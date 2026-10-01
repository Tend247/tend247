import { useState } from "react";
import { api, issuesByField } from "../../api.ts";
import { allRecordTypes, useSession } from "../../session.tsx";
import { Empty, ErrorText, useLoad } from "../../components/ui.tsx";
import { AdminNav } from "./AdminProjects.tsx";

type Op = "eq" | "neq" | "in" | "not_in" | "contains" | "empty" | "not_empty" | "changed";
interface Condition {
  field: string;
  op: Op;
  value?: unknown;
}
type Action =
  | { type: "set_field"; field: string; value: unknown }
  | { type: "assign"; userId?: string | null; roundRobinTeamId?: string }
  | { type: "set_team"; teamId: string | null }
  | { type: "transition"; transition: string }
  | { type: "notify"; to: string[]; message: string }
  | { type: "webhook"; url: string }
  | { type: "create_linked"; recordTypeId: string; title: string; linkKind: string }
  | { type: "comment"; body: string; internal: boolean };

interface Rule {
  id: string;
  name: string;
  projectId: string | null;
  enabled: boolean;
  trigger: string;
  conditions: Condition[];
  actions: Action[];
  position: number;
}

const TRIGGERS: [string, string][] = [
  ["record.created", "A record is created"],
  ["record.updated", "A record's fields change"],
  ["record.transitioned", "A record changes status"],
  ["comment.created", "A comment is added"],
  ["sla.warning", "An SLA target is close"],
  ["sla.breached", "An SLA target is breached"],
  ["approval.decided", "An approval is decided"],
];

const EVENT_FIELDS: Record<string, [string, string][]> = {
  "record.updated": [["event.fields", "Changed fields"]],
  "record.transitioned": [["event.to", "New status"], ["event.from", "Previous status"], ["event.toCategory", "New category"]],
  "comment.created": [["event.internal", "Comment is internal (true/false)"]],
  "sla.warning": [["event.metric", "Metric (first_response/resolution)"]],
  "sla.breached": [["event.metric", "Metric (first_response/resolution)"]],
  "approval.decided": [["event.approved", "Approved (true/false)"]],
};

const OPS: [Op, string][] = [
  ["eq", "is"],
  ["neq", "is not"],
  ["in", "is one of"],
  ["not_in", "is none of"],
  ["contains", "contains"],
  ["empty", "is empty"],
  ["not_empty", "is not empty"],
  ["changed", "changed"],
];

function parseValue(s: string): unknown {
  const t = s.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && !Number.isNaN(Number(t)) && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return s;
}

const blank = (): Omit<Rule, "id"> => ({ name: "", projectId: null, enabled: true, trigger: "record.created", conditions: [], actions: [{ type: "comment", body: "", internal: true }], position: 0 });

function RuleForm({ initial, onSaved, onCancel }: { initial?: Rule; onSaved: () => void; onCancel?: () => void }) {
  const { projects, people, teams } = useSession();
  const [rule, setRule] = useState<Omit<Rule, "id">>(initial ? structuredClone(initial) : blank());
  const [error, setError] = useState<string | null>(null);
  const types = allRecordTypes(projects).filter((t) => !rule.projectId || t.projectId === rule.projectId);
  const customFields = [...new Map(types.flatMap((t) => t.fields).map((f) => [f.key, f])).values()];
  const fieldOptions: [string, string][] = [
    ["priority", "Priority"],
    ["status", "Status"],
    ["statusCategory", "Status category"],
    ["assigneeId", "Assignee"],
    ["teamId", "Team"],
    ["recordTypeId", "Record type"],
    ["title", "Title"],
    ["description", "Description"],
    ["via", "Came in via (app/email)"],
    ...customFields.map((f) => [`custom.${f.key}`, f.label] as [string, string]),
    ...(EVENT_FIELDS[rule.trigger] ?? []),
  ];
  const transitions = [...new Map(types.flatMap((t) => t.workflow.transitions).map((t) => [t.key, t.name])).entries()];
  const setAction = (i: number, a: Action) => setRule({ ...rule, actions: rule.actions.map((x, j) => (j === i ? a : x)) });
  const staff = people.filter((p) => p.role !== "requester");

  async function save() {
    setError(null);
    try {
      if (initial) await api.patch(`/api/admin/automation/${initial.id}`, rule);
      else await api.post("/api/admin/automation", rule);
      onSaved();
      if (!initial) setRule(blank());
    } catch (err) {
      const issues = issuesByField(err);
      setError(Object.entries(issues).map(([k, v]) => `${k}: ${v}`).join("; ") || (err as Error).message);
    }
  }

  return (
    <div className="card stack">
      <div className="row wrap">
        <label className="field grow">
          Rule name
          <input value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} placeholder="Route urgent payments to the AP lead" />
        </label>
        <label className="field">
          Project
          <select value={rule.projectId ?? ""} onChange={(e) => setRule({ ...rule, projectId: e.target.value || null })}>
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          When
          <select value={rule.trigger} onChange={(e) => setRule({ ...rule, trigger: e.target.value })}>
            {TRIGGERS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div>
        <strong className="small">If (all of these are true)</strong>
        {rule.conditions.map((c, i) => (
          <div key={i} className="row cond">
            <select value={c.field} onChange={(e) => setRule({ ...rule, conditions: rule.conditions.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })}>
              {fieldOptions.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <select value={c.op} onChange={(e) => setRule({ ...rule, conditions: rule.conditions.map((x, j) => (j === i ? { ...x, op: e.target.value as Op } : x)) })}>
              {OPS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            {!["empty", "not_empty", "changed"].includes(c.op) && (
              <input
                placeholder={c.op === "in" || c.op === "not_in" ? "a, b, c" : "value"}
                value={Array.isArray(c.value) ? c.value.join(", ") : c.value === undefined ? "" : String(c.value)}
                onChange={(e) =>
                  setRule({
                    ...rule,
                    conditions: rule.conditions.map((x, j) =>
                      j === i ? { ...x, value: x.op === "in" || x.op === "not_in" ? e.target.value.split(",").map((s) => parseValue(s.trim())) : parseValue(e.target.value) } : x,
                    ),
                  })
                }
              />
            )}
            <button className="subtle small" onClick={() => setRule({ ...rule, conditions: rule.conditions.filter((_, j) => j !== i) })} aria-label="Remove condition">
              ×
            </button>
          </div>
        ))}
        <button className="subtle small" onClick={() => setRule({ ...rule, conditions: [...rule.conditions, { field: "priority", op: "eq", value: "urgent" }] })}>
          Add condition
        </button>
      </div>

      <div>
        <strong className="small">Then</strong>
        {rule.actions.map((a, i) => (
          <div key={i} className="row wrap cond">
            <select
              value={a.type}
              onChange={(e) => {
                const t = e.target.value;
                const fresh: Record<string, Action> = {
                  set_field: { type: "set_field", field: "priority", value: "high" },
                  assign: { type: "assign", userId: staff[0]?.id ?? null },
                  set_team: { type: "set_team", teamId: teams[0]?.id ?? null },
                  transition: { type: "transition", transition: transitions[0]?.[0] ?? "" },
                  notify: { type: "notify", to: ["assignee"], message: "" },
                  webhook: { type: "webhook", url: "https://" },
                  create_linked: { type: "create_linked", recordTypeId: types[0]?.id ?? "", title: "Follow up on {{key}}", linkKind: "relates" },
                  comment: { type: "comment", body: "", internal: true },
                };
                setAction(i, fresh[t]!);
              }}
            >
              <option value="set_field">Set a field</option>
              <option value="assign">Assign</option>
              <option value="set_team">Set team</option>
              <option value="transition">Move (transition)</option>
              <option value="notify">Notify people</option>
              <option value="comment">Add a comment</option>
              <option value="create_linked">Create a linked record</option>
              <option value="webhook">Call a webhook</option>
            </select>
            {a.type === "set_field" && (
              <>
                <select value={a.field} onChange={(e) => setAction(i, { ...a, field: e.target.value })}>
                  {fieldOptions.filter(([v]) => !v.startsWith("event.") && !["status", "statusCategory", "recordTypeId", "via"].includes(v)).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
                <input placeholder="value" value={String(a.value ?? "")} onChange={(e) => setAction(i, { ...a, value: parseValue(e.target.value) })} />
              </>
            )}
            {a.type === "assign" && (
              <select
                value={a.roundRobinTeamId ? `team:${a.roundRobinTeamId}` : (a.userId ?? "")}
                onChange={(e) => setAction(i, e.target.value.startsWith("team:") ? { type: "assign", roundRobinTeamId: e.target.value.slice(5) } : { type: "assign", userId: e.target.value || null })}
              >
                <option value="">Nobody (unassign)</option>
                {staff.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
                {teams.map((t) => (
                  <option key={t.id} value={`team:${t.id}`}>
                    Next in rotation: {t.name}
                  </option>
                ))}
              </select>
            )}
            {a.type === "set_team" && (
              <select value={a.teamId ?? ""} onChange={(e) => setAction(i, { ...a, teamId: e.target.value || null })}>
                <option value="">No team</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            {a.type === "transition" && (
              <select value={a.transition} onChange={(e) => setAction(i, { ...a, transition: e.target.value })}>
                {transitions.map(([k, n]) => (
                  <option key={k} value={k}>
                    {n}
                  </option>
                ))}
              </select>
            )}
            {a.type === "notify" && (
              <>
                {["assignee", "requester", "watchers", "team"].map((who) => (
                  <label key={who} className="inline">
                    <input type="checkbox" checked={a.to.includes(who)} onChange={(e) => setAction(i, { ...a, to: e.target.checked ? [...a.to, who] : a.to.filter((x) => x !== who) })} />
                    {who}
                  </label>
                ))}
                <input className="grow" placeholder="Message, e.g. {{key}} needs attention" value={a.message} onChange={(e) => setAction(i, { ...a, message: e.target.value })} />
              </>
            )}
            {a.type === "comment" && (
              <>
                <input className="grow" placeholder="Comment text ({{key}}, {{title}} work)" value={a.body} onChange={(e) => setAction(i, { ...a, body: e.target.value })} />
                <label className="inline">
                  <input type="checkbox" checked={a.internal} onChange={(e) => setAction(i, { ...a, internal: e.target.checked })} /> internal
                </label>
              </>
            )}
            {a.type === "create_linked" && (
              <>
                <select value={a.recordTypeId} onChange={(e) => setAction(i, { ...a, recordTypeId: e.target.value })}>
                  {allRecordTypes(projects).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.project.name} · {t.name}
                    </option>
                  ))}
                </select>
                <input className="grow" value={a.title} onChange={(e) => setAction(i, { ...a, title: e.target.value })} />
              </>
            )}
            {a.type === "webhook" && <input className="grow" value={a.url} onChange={(e) => setAction(i, { ...a, url: e.target.value })} />}
            <button className="subtle small" disabled={rule.actions.length === 1} onClick={() => setRule({ ...rule, actions: rule.actions.filter((_, j) => j !== i) })} aria-label="Remove action">
              ×
            </button>
          </div>
        ))}
        <button className="subtle small" onClick={() => setRule({ ...rule, actions: [...rule.actions, { type: "notify", to: ["assignee"], message: "" }] })}>
          Add action
        </button>
      </div>
      <ErrorText error={error} />
      <div className="row">
        <button className="primary" onClick={save}>
          {initial ? "Save rule" : "Create rule"}
        </button>
        {onCancel && (
          <button className="subtle" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export function AdminAutomation() {
  const { projects } = useSession();
  const rules = useLoad(() => api.get<{ rules: Rule[] }>("/api/admin/automation"), []);
  const secret = useLoad(() => api.get<{ secret: string }>("/api/admin/webhook-secret"), []);
  const deliveries = useLoad(() => api.get<{ deliveries: { id: string; url: string; status: string; attempts: number; lastStatus: number | null; lastError: string | null; createdAt: string }[] }>("/api/admin/webhook-deliveries"), []);
  const [editing, setEditing] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  return (
    <section>
      <AdminNav />
      <h1>Automation</h1>
      <p className="muted">
        Rules run right after the change that triggers them, as “Automation”. A rule never triggers itself, and a chain of rules stops after three steps.
      </p>
      {rules.data?.rules.length === 0 && <Empty>No rules yet.</Empty>}
      {(rules.data?.rules ?? []).map((r) =>
        editing === r.id ? (
          <RuleForm key={r.id} initial={r} onSaved={() => { setEditing(null); void rules.reload(); }} onCancel={() => setEditing(null)} />
        ) : (
          <div key={r.id} className={`card row between ${r.enabled ? "" : "dim"}`}>
            <div>
              <strong>{r.name}</strong>
              <div className="muted small">
                {TRIGGERS.find(([v]) => v === r.trigger)?.[1]} · {r.projectId ? projects.find((p) => p.id === r.projectId)?.name : "all projects"} · {r.conditions.length} condition
                {r.conditions.length === 1 ? "" : "s"} · {r.actions.map((a) => a.type.replace("_", " ")).join(", ")}
              </div>
            </div>
            <div className="row">
              <label className="inline">
                <input type="checkbox" checked={r.enabled} onChange={async (e) => { await api.patch(`/api/admin/automation/${r.id}`, { enabled: e.target.checked }); void rules.reload(); }} /> on
              </label>
              <button className="subtle" onClick={() => setEditing(r.id)}>
                Edit
              </button>
              <button className="subtle danger" onClick={async () => { if (window.confirm(`Delete “${r.name}”?`)) { await api.delete(`/api/admin/automation/${r.id}`); void rules.reload(); } }}>
                Delete
              </button>
            </div>
          </div>
        ),
      )}
      <h2>New rule</h2>
      <RuleForm onSaved={() => void rules.reload()} />

      <h2>Webhooks</h2>
      <p className="muted small">
        Each delivery is a POST with JSON and an <code>X-Tend-Signature: t=…,v1=…</code> header: the hex HMAC-SHA256 of <code>t + "." + body</code> with this secret. Failed deliveries retry
        five more times with backoff.
      </p>
      <div className="row">
        <code className="secret">{showSecret ? secret.data?.secret : "••••••••••••••••"}</code>
        <button className="subtle small" onClick={() => setShowSecret(!showSecret)}>
          {showSecret ? "Hide" : "Reveal"}
        </button>
        <button className="subtle small" onClick={async () => { if (window.confirm("Rotate the secret? Receivers must switch to the new one.")) { await api.post("/api/admin/webhook-secret/rotate"); void secret.reload(); } }}>
          Rotate
        </button>
      </div>
      {(deliveries.data?.deliveries.length ?? 0) > 0 && (
        <table className="grid compact">
          <thead>
            <tr>
              <th>URL</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Last result</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.data!.deliveries.slice(0, 20).map((d) => (
              <tr key={d.id}>
                <td className="mono small">{d.url}</td>
                <td>{d.status}</td>
                <td>{d.attempts}</td>
                <td className="muted small">{d.lastError ?? d.lastStatus ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
