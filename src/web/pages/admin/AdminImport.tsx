import { useState, type ChangeEvent, type ReactNode } from "react";
import { api } from "../../api.ts";
import { allRecordTypes, useSession } from "../../session.tsx";
import { ErrorText } from "../../components/ui.tsx";
import { AdminNav } from "./AdminProjects.tsx";

interface Report {
  dryRun: boolean;
  total: number;
  created: number;
  skipped: number;
  errors: number;
  rows: { line: number; status: "created" | "skipped" | "error"; message?: string; key?: string }[];
  unmatchedColumns?: string[];
}

function ImportCard({
  title,
  help,
  target,
  extra,
  disabled,
}: {
  title: string;
  help: ReactNode;
  target: string;
  extra?: Record<string, unknown>;
  disabled?: string;
}) {
  const { reload } = useSession();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    setCsv(await f.text());
    setReport(null);
  }

  async function run(dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<Report>(target, { csv, dryRun, ...extra });
      setReport(r);
      if (!dryRun) await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h2>{title}</h2>
      <div className="muted small">{help}</div>
      {disabled ? (
        <p className="muted">{disabled}</p>
      ) : (
        <>
          <label className="field">
            CSV file
            <input type="file" accept=".csv,text/csv" onChange={onFile} />
          </label>
          <div className="row">
            <button disabled={!csv || busy} onClick={() => run(true)}>
              Check {fileName && `“${fileName}”`}
            </button>
            <button className="primary" disabled={!report?.dryRun || report.created === 0 || busy} onClick={() => run(false)}>
              Import {report?.dryRun ? `${report.created} row${report.created === 1 ? "" : "s"}` : ""}
            </button>
          </div>
          <ErrorText error={error} />
          {report && (
            <div>
              <p>
                <strong>{report.dryRun ? "Check only, nothing saved:" : "Imported:"}</strong> {report.created} {report.dryRun ? "would be created" : "created"},{" "}
                {report.skipped} skipped, {report.errors} with problems.
              </p>
              {report.unmatchedColumns?.length ? <p className="muted small">Ignored columns: {report.unmatchedColumns.join(", ")}</p> : null}
              {report.rows.some((r) => r.status !== "created") && (
                <table className="grid compact">
                  <thead>
                    <tr>
                      <th>Line</th>
                      <th>Result</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows
                      .filter((r) => r.status !== "created")
                      .map((r) => (
                        <tr key={r.line}>
                          <td>{r.line}</td>
                          <td className={r.status === "error" ? "error" : "muted"}>{r.status}</td>
                          <td className="small">{r.message}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function AdminImport() {
  const { projects, me } = useSession();
  const types = allRecordTypes(projects);
  const [recordTypeId, setRecordTypeId] = useState(types[0]?.id ?? "");
  const type = types.find((t) => t.id === recordTypeId);
  return (
    <section className="narrow">
      <AdminNav />
      <h1>Import from CSV</h1>
      <p className="muted">Every import is checked first: you see what would be created and which rows have problems before anything is saved. Up to 2,000 rows at a time.</p>
      <ImportCard
        title="People"
        target="/api/admin/import/users"
        help={
          <>
            Columns: <code className="mono">email</code>, <code className="mono">name</code>, <code className="mono">role</code> (admin, agent or
            requester; requester if blank) and <code className="mono">teams</code> (team names separated by semicolons). Existing people are
            skipped.
          </>
        }
      />
      <div className="card">
        <label className="field">
          Import records into
          <select value={recordTypeId} onChange={(e) => setRecordTypeId(e.target.value)}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.project.name} · {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ImportCard
        title="Records"
        target="/api/admin/import/records"
        extra={{ recordTypeId }}
        disabled={me?.demo ? "Record import is turned off in the demo." : !type ? "Add a record type first." : undefined}
        help={
          <>
            Columns: <code className="mono">title</code> (required), <code className="mono">description</code>,{" "}
            <code className="mono">priority</code>, <code className="mono">assignee</code> and <code className="mono">requester</code> (email addresses),{" "}
            <code className="mono">team</code>, and any field by its key or label
            {type ? `: ${type.fields.filter((f) => !f.archivedAt).map((f) => f.label).join(", ")}` : ""}. Choices match by label or value;
            separate multiple choices with semicolons. Records start in the first status, and nobody is notified about the import.
          </>
        }
      />
    </section>
  );
}
