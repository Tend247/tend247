// CSV import of people and records, with a dry run. Each row is checked by the same services
// the API uses (createUser, createRecord), inside a savepoint, so one bad row never stops the
// rest and a dry run reports exactly what a real run would do before rolling everything back.
import { z } from "zod";
import type { Tx } from "../db/client.ts";
import { audit, type Actor } from "../audit.ts";
import { createUser } from "../users/service.ts";
import { createRecord } from "../records/service.ts";
import { getRecordType, listFields } from "../config/service.ts";
import type { FieldDef } from "../config/fields.ts";
import { AppError } from "../lib/errors.ts";
import { parse, uuid } from "../lib/validate.ts";
import { csvObjects } from "./csv.ts";

export const MAX_IMPORT_ROWS = 2000;

export interface RowResult {
  line: number;
  status: "created" | "skipped" | "error";
  message?: string;
  key?: string;
}

export interface ImportReport {
  dryRun: boolean;
  total: number;
  created: number;
  skipped: number;
  errors: number;
  rows: RowResult[];
  unmatchedColumns?: string[];
}

const usersBody = z.object({ csv: z.string().min(1).max(5_000_000), dryRun: z.boolean().default(true) });
const recordsBody = usersBody.extend({
  recordTypeId: uuid,
  /** Send notifications, automation and webhooks for imported records (off by default). */
  notify: z.boolean().default(false),
});

function readCsv(text: string) {
  try {
    return csvObjects(text, MAX_IMPORT_ROWS);
  } catch (err) {
    throw new AppError("bad_request", `Could not read the CSV: ${(err as Error).message}`);
  }
}

function report(dryRun: boolean, rows: RowResult[], extra: Partial<ImportReport> = {}): ImportReport {
  return {
    dryRun,
    total: rows.length,
    created: rows.filter((r) => r.status === "created").length,
    skipped: rows.filter((r) => r.status === "skipped").length,
    errors: rows.filter((r) => r.status === "error").length,
    rows,
    ...extra,
  };
}

function describe(err: unknown): string {
  const e = err as AppError & { details?: { issues?: { field: string; message: string }[] } };
  const issues = e.details?.issues;
  if (issues?.length) return issues.map((i) => (i.field ? `${i.field}: ${i.message}` : i.message)).join("; ");
  return e.message ?? "Failed";
}

/** Run each row in a savepoint so a failure undoes only that row. */
async function eachRow<T>(tx: Tx, rows: T[], fn: (row: T, line: number) => Promise<RowResult>): Promise<RowResult[]> {
  const out: RowResult[] = [];
  for (const [i, row] of rows.entries()) {
    const line = i + 2; // header is line 1
    try {
      // Statements run on the transaction's one connection, so they fall inside the savepoint.
      out.push((await tx.savepoint(() => fn(row, line))) as RowResult);
    } catch (err) {
      out.push({ line, status: "error", message: describe(err) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- people

/** Columns: email, name (or display_name), role (admin | agent | requester), teams (separated by ;). */
export async function importUsers(tx: Tx, actor: Actor, input: unknown): Promise<ImportReport> {
  const body = parse(usersBody, input);
  const { headers, rows } = readCsv(body.csv);
  const lower = headers.map((h) => h.toLowerCase());
  if (!lower.includes("email")) throw new AppError("bad_request", "The CSV needs an email column");
  const teams = await tx<{ id: string; name: string }[]>`select id, name from teams where archived_at is null`;
  const results = await eachRow(tx, rows, async (row) => {
    const email = (row.email ?? "").toLowerCase();
    const [existing] = await tx`select 1 from users where email = ${email}`;
    if (existing) return { line: 0, status: "skipped", message: `${email} already exists` };
    const role = (row.role || "requester").toLowerCase();
    const user = await createUser(tx, actor, { email, displayName: row.name || row.display_name || email.split("@")[0], role });
    const wanted = (row.teams ?? "").split(";").map((t) => t.trim()).filter(Boolean);
    for (const name of wanted) {
      const team = teams.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (!team) throw new AppError("bad_request", `Unknown team "${name}"`);
      if (role === "requester") throw new AppError("bad_request", "Requesters cannot join teams");
      await tx`insert into team_members (tenant_id, team_id, user_id) values (${actor.tenantId}, ${team.id}, ${user.id}) on conflict do nothing`;
    }
    return { line: 0, status: "created", key: email };
  });
  results.forEach((r, i) => (r.line = i + 2));
  await audit(tx, actor, { entity: "import", entityId: null, action: body.dryRun ? "users_dry_run" : "users", after: { rows: rows.length } });
  return report(body.dryRun, results);
}

// ---------------------------------------------------------------- records

const BUILTIN = new Set(["title", "description", "priority", "assignee", "requester", "team"]);

function coerce(field: FieldDef, raw: string, emails: Map<string, string>): unknown {
  if (raw === "") return undefined;
  const choice = (v: string) => {
    const c = field.options.choices?.find((x) => x.value === v || x.label.toLowerCase() === v.toLowerCase());
    if (!c) throw new AppError("bad_request", `${field.label}: "${v}" is not one of the choices`);
    return c.value;
  };
  switch (field.type) {
    case "number":
    case "currency": {
      const n = Number(raw.replace(/[$,\s]/g, ""));
      if (!Number.isFinite(n)) throw new AppError("bad_request", `${field.label}: "${raw}" is not a number`);
      return n;
    }
    case "checkbox":
      if (/^(true|yes|y|1|x)$/i.test(raw)) return true;
      if (/^(false|no|n|0)$/i.test(raw)) return false;
      throw new AppError("bad_request", `${field.label}: use yes or no`);
    case "select":
      return choice(raw);
    case "multi_select":
      return raw.split(";").map((v) => v.trim()).filter(Boolean).map(choice);
    case "user": {
      const id = emails.get(raw.toLowerCase());
      if (!id) throw new AppError("bad_request", `${field.label}: no person with email ${raw}`);
      return id;
    }
    default:
      return raw;
  }
}

/**
 * Columns: title (required), description, priority, assignee and requester (emails), team
 * (name), and any custom field by key or label. Records start in the workflow's first status.
 */
export async function importRecords(tx: Tx, actor: Actor, input: unknown): Promise<ImportReport> {
  const body = parse(recordsBody, input);
  const recordType = await getRecordType(tx, body.recordTypeId);
  const fields = (await listFields(tx, recordType.id)).filter((f) => !f.archivedAt);
  const { headers, rows } = readCsv(body.csv);
  if (!headers.some((h) => h.toLowerCase() === "title")) throw new AppError("bad_request", "The CSV needs a title column");
  const byColumn = new Map<string, FieldDef>();
  const unmatched: string[] = [];
  for (const h of headers) {
    const k = h.toLowerCase();
    if (BUILTIN.has(k)) continue;
    const f = fields.find((x) => x.key === k || x.label.toLowerCase() === k);
    if (f) byColumn.set(k, f);
    else unmatched.push(h);
  }
  const people = await tx<{ id: string; email: string }[]>`select id, email from users where active`;
  const emails = new Map(people.map((p) => [p.email, p.id]));
  const teams = await tx<{ id: string; name: string }[]>`select id, name from teams where archived_at is null`;
  const importer: Actor = { ...actor, via: "import" };

  const results = await eachRow(tx, rows, async (row) => {
    const person = (col: string) => {
      const v = row[col];
      if (!v) return undefined;
      const id = emails.get(v.toLowerCase());
      if (!id) throw new AppError("bad_request", `${col}: no active person with email ${v}`);
      return id;
    };
    const custom: Record<string, unknown> = {};
    for (const [col, f] of byColumn) {
      const v = coerce(f, row[col] ?? "", emails);
      if (v !== undefined) custom[f.key] = v;
    }
    let teamId: string | undefined;
    if (row.team) {
      teamId = teams.find((t) => t.name.toLowerCase() === row.team!.toLowerCase())?.id;
      if (!teamId) throw new AppError("bad_request", `Unknown team "${row.team}"`);
    }
    const record = await createRecord(tx, importer, {
      recordTypeId: recordType.id,
      title: row.title,
      description: row.description ?? "",
      ...(row.priority ? { priority: row.priority.toLowerCase() } : {}),
      ...(person("assignee") ? { assigneeId: person("assignee") } : {}),
      ...(person("requester") ? { requesterId: person("requester") } : {}),
      ...(teamId ? { teamId } : {}),
      custom,
    });
    return { line: 0, status: "created", key: record.key };
  });
  results.forEach((r, i) => (r.line = i + 2));
  if (!body.notify) {
    // A bulk load should not page everyone: mark the imported records' own events handled
    // (and only theirs; events other people raise meanwhile are untouched).
    const keys = results.filter((r) => r.status === "created").map((r) => r.key!);
    if (keys.length) {
      await tx`
        update outbox set delivered_at = now()
        where delivered_at is null and payload ->> 'key' in (select jsonb_array_elements_text(${tx.json(keys)}))`;
    }
  }
  await audit(tx, actor, {
    entity: "import",
    entityId: recordType.id,
    action: body.dryRun ? "records_dry_run" : "records",
    after: { rows: rows.length, created: results.filter((r) => r.status === "created").length },
  });
  return report(body.dryRun, results, { unmatchedColumns: unmatched });
}

/** Thrown to roll a dry run back while carrying its report out of the transaction. */
export class DryRun extends Error {
  readonly report: ImportReport;
  constructor(report: ImportReport) {
    super("dry run");
    this.report = report;
  }
}
