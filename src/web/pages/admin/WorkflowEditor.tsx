import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { allRecordTypes, useSession } from "../../session.tsx";
import { ErrorText } from "../../components/ui.tsx";
import type { Category, Role, Workflow, WorkflowTransition } from "../../types.ts";
import { AdminNav } from "./AdminProjects.tsx";
import { ConfigToolbar, StatusMapDialog, useConfig, VersionsPanel } from "./ConfigVersions.tsx";

const CATEGORY_LABEL: Record<Category, string> = { todo: "To do", in_progress: "In progress", done: "Done" };
const BUILTINS: [string, string][] = [
  ["description", "Description"],
  ["assigneeId", "Assignee"],
  ["teamId", "Team"],
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "s_$1").slice(0, 41) || "status";

export function WorkflowEditor() {
  const { id = "" } = useParams();
  const { projects, people } = useSession();
  const type = allRecordTypes(projects).find((t) => t.id === id);
  const cfg = useConfig<Workflow>("workflow", id);
  const [def, setDef] = useState<Workflow | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (cfg.bundle) {
      setDef(structuredClone(cfg.bundle.draft?.definition ?? cfg.bundle.effective));
      setDirty(false);
    }
  }, [cfg.bundle]);

  if (!type) return <p className="muted">Record type not found.</p>;
  if (!def || !cfg.bundle) return <p className="muted">Loading…</p>;

  const update = (next: Workflow) => {
    setDef(next);
    setDirty(true);
  };
  const staff = people.filter((p) => p.role !== "requester");
  const fieldChoices: [string, string][] = [...BUILTINS, ...type.fields.map((f) => [f.key, f.label] as [string, string])];
  const issueFor = (path: string) => cfg.issues.find((i) => i.field === path || i.field.startsWith(`${path}.`))?.message;

  function setTransition(i: number, patch: Partial<WorkflowTransition>) {
    const transitions = def!.transitions.map((t, j) => (j === i ? { ...t, ...patch } : t));
    update({ ...def!, transitions });
  }

  return (
    <section>
      <AdminNav />
      <p className="muted small">
        <Link to={`/app/admin/projects/${type.projectId}`}>{type.project.name}</Link> · {type.name}
      </p>
      <h1>Workflow</h1>
      <p className="muted">
        Statuses fall into three categories that every report and board understands. Transitions are the moves people can make, who may make them, and
        what must be filled in first. Changes take effect when you publish; earlier versions can be restored.
      </p>
      <ConfigToolbar
        hasDraft={Boolean(cfg.bundle.draft)}
        dirty={dirty}
        onSave={() => cfg.saveDraft(def)}
        onPublish={() => cfg.publish()}
        onDiscard={() => cfg.discard()}
      />
      {cfg.notice && <p className="notice">{cfg.notice}</p>}
      <ErrorText error={cfg.error} />
      {cfg.needsMap && <StatusMapDialog needs={cfg.needsMap} statuses={def.statuses} onCancel={cfg.cancelMap} />}

      <div className="card">
        <h2>Statuses</h2>
        <table className="grid">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Category</th>
              <th>Starts here</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {def.statuses.map((s, i) => (
              <tr key={i}>
                <td>
                  <input
                    aria-label="Status name"
                    value={s.name}
                    onChange={(e) => update({ ...def, statuses: def.statuses.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                  />
                </td>
                <td className="mono">
                  <input
                    aria-label="Status key"
                    className="mono"
                    value={s.key}
                    onChange={(e) => update({ ...def, statuses: def.statuses.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })}
                  />
                  {issueFor(`statuses.${i}`) && <span className="error small">{issueFor(`statuses.${i}`)}</span>}
                </td>
                <td>
                  <select
                    aria-label="Category"
                    value={s.category}
                    onChange={(e) => update({ ...def, statuses: def.statuses.map((x, j) => (j === i ? { ...x, category: e.target.value as Category } : x)) })}
                  >
                    {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_LABEL[c]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input type="radio" name="initial" aria-label="Initial status" checked={def.initial === s.key} onChange={() => update({ ...def, initial: s.key })} />
                </td>
                <td className="row">
                  <button className="subtle small" disabled={i === 0} onClick={() => { const st = [...def.statuses]; [st[i - 1], st[i]] = [st[i]!, st[i - 1]!]; update({ ...def, statuses: st }); }} aria-label="Move up">
                    ↑
                  </button>
                  <button
                    className="subtle small danger"
                    disabled={def.statuses.length === 1}
                    onClick={() =>
                      update({
                        ...def,
                        statuses: def.statuses.filter((_, j) => j !== i),
                        transitions: def.transitions.filter((t) => t.to !== s.key).map((t) => ({ ...t, from: t.from.filter((f) => f !== s.key) })),
                      })
                    }
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          onClick={() => {
            const name = window.prompt("New status name");
            if (name) update({ ...def, statuses: [...def.statuses, { key: slug(name), name, category: "in_progress" }] });
          }}
        >
          Add status
        </button>
        <ErrorText error={issueFor("initial")} />
      </div>

      <div className="card">
        <h2>Transitions</h2>
        {def.transitions.map((t, i) => (
          <div key={i} className="transition-edit">
            <div className="row wrap">
              <label className="field grow">
                Name (the button people press)
                <input value={t.name} onChange={(e) => setTransition(i, { name: e.target.value })} />
              </label>
              <label className="field">
                Key
                <input className="mono" value={t.key} onChange={(e) => setTransition(i, { key: e.target.value })} />
              </label>
              <label className="field">
                Moves to
                <select value={t.to} onChange={(e) => setTransition(i, { to: e.target.value })}>
                  {def.statuses.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <button className="subtle small danger" onClick={() => update({ ...def, transitions: def.transitions.filter((_, j) => j !== i) })}>
                Remove
              </button>
            </div>
            <div className="checkline">
              <span className="muted small">From:</span>
              <label className="inline">
                <input type="checkbox" checked={t.from.length === 0} onChange={(e) => setTransition(i, { from: e.target.checked ? [] : def.statuses.filter((s) => s.key !== t.to).map((s) => s.key) })} /> any status
              </label>
              {t.from.length > 0 &&
                def.statuses.filter((s) => s.key !== t.to).map((s) => (
                  <label key={s.key} className="inline">
                    <input
                      type="checkbox"
                      checked={t.from.includes(s.key)}
                      onChange={(e) => setTransition(i, { from: e.target.checked ? [...t.from, s.key] : t.from.filter((f) => f !== s.key) })}
                    />
                    {s.name}
                  </label>
                ))}
            </div>
            <div className="checkline">
              <span className="muted small">Who:</span>
              {(["admin", "agent", "requester"] as Role[]).map((r) => (
                <label key={r} className="inline">
                  <input
                    type="checkbox"
                    checked={t.roles.includes(r)}
                    onChange={(e) => setTransition(i, { roles: e.target.checked ? [...t.roles, r] : t.roles.filter((x) => x !== r) })}
                  />
                  {r}s
                </label>
              ))}
            </div>
            <div className="checkline">
              <span className="muted small">Required first:</span>
              {fieldChoices.map(([k, label]) => (
                <label key={k} className="inline">
                  <input
                    type="checkbox"
                    checked={t.requiredFields.includes(k)}
                    onChange={(e) => setTransition(i, { requiredFields: e.target.checked ? [...t.requiredFields, k] : t.requiredFields.filter((x) => x !== k) })}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="checkline">
              <span className="muted small">Afterwards:</span>
              {(["assign_self", "unassign"] as const).map((a) => (
                <label key={a} className="inline">
                  <input
                    type="checkbox"
                    checked={t.actions.some((x) => x.type === a)}
                    onChange={(e) =>
                      setTransition(i, {
                        actions: e.target.checked
                          ? [...t.actions.filter((x) => x.type !== (a === "assign_self" ? "unassign" : "assign_self")), { type: a }]
                          : t.actions.filter((x) => x.type !== a),
                      })
                    }
                  />
                  {a === "assign_self" ? "assign to whoever moved it" : "unassign"}
                </label>
              ))}
            </div>
            <div className="checkline">
              <span className="muted small">Approval:</span>
              <select
                aria-label="Approval"
                value={t.approval?.mode ?? ""}
                onChange={(e) =>
                  setTransition(i, { approval: e.target.value ? { mode: e.target.value as "any" | "sequential", approvers: t.approval?.approvers ?? [] } : undefined })
                }
              >
                <option value="">Not needed</option>
                <option value="any">Any one approver</option>
                <option value="sequential">Each approver, in order</option>
              </select>
              {t.approval &&
                staff.map((p) => (
                  <label key={p.id} className="inline">
                    <input
                      type="checkbox"
                      checked={t.approval!.approvers.includes(p.id)}
                      onChange={(e) =>
                        setTransition(i, {
                          approval: { ...t.approval!, approvers: e.target.checked ? [...t.approval!.approvers, p.id] : t.approval!.approvers.filter((x) => x !== p.id) },
                        })
                      }
                    />
                    {p.displayName}
                  </label>
                ))}
            </div>
            <ErrorText error={issueFor(`transitions.${i}`)} />
          </div>
        ))}
        <button
          onClick={() => {
            const name = window.prompt("New transition name (e.g. “Escalate”)");
            if (name) update({ ...def, transitions: [...def.transitions, { key: slug(name), name, from: [], to: def.statuses[0]!.key, roles: ["admin", "agent"], requiredFields: [], actions: [] }] });
          }}
        >
          Add transition
        </button>
      </div>

      <h2>Versions</h2>
      <VersionsPanel bundle={cfg.bundle} onRestore={cfg.restore} />
    </section>
  );
}
