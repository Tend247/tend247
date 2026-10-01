import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { allRecordTypes, useSession } from "../../session.tsx";
import { ErrorText } from "../../components/ui.tsx";
import type { Layout, LayoutSection } from "../../types.ts";
import { AdminNav } from "./AdminProjects.tsx";
import { ConfigToolbar, useConfig, VersionsPanel } from "./ConfigVersions.tsx";

const BUILTINS: Record<string, string> = { description: "Description", priority: "Priority", assigneeId: "Assignee", teamId: "Team" };

export function LayoutEditor() {
  const { id = "" } = useParams();
  const { projects } = useSession();
  const type = allRecordTypes(projects).find((t) => t.id === id);
  const cfg = useConfig<Layout>("layout", id);
  const [def, setDef] = useState<Layout | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (cfg.bundle) {
      setDef(structuredClone(cfg.bundle.draft?.definition ?? cfg.bundle.effective));
      setDirty(false);
    }
  }, [cfg.bundle]);

  if (!type) return <p className="muted">Record type not found.</p>;
  if (!def || !cfg.bundle) return <p className="muted">Loading…</p>;

  const label = (k: string) => BUILTINS[k] ?? type.fields.find((f) => f.key === k)?.label ?? k;
  const all = [...Object.keys(BUILTINS), ...type.fields.map((f) => f.key)];
  const update = (next: Layout) => {
    setDef(next);
    setDirty(true);
  };

  function FormEditor({ form, title, help }: { form: "create" | "view"; title: string; help: string }) {
    const sections = def![form].sections;
    const used = new Set(sections.flatMap((s) => s.fields));
    const setSections = (next: LayoutSection[]) => {
      const onCreate = form === "create" ? new Set(next.flatMap((s) => s.fields)) : null;
      update({
        ...def!,
        [form]: { sections: next },
        requiredOnCreate: onCreate ? def!.requiredOnCreate.filter((k) => onCreate.has(k)) : def!.requiredOnCreate,
      });
    };
    return (
      <div className="card">
        <h2>{title}</h2>
        <p className="muted small">{help}</p>
        {sections.map((s, i) => (
          <fieldset key={i} className="section">
            <div className="row">
              <input
                aria-label="Section title"
                placeholder="Section title (optional)"
                value={s.title}
                onChange={(e) => setSections(sections.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
              />
              <button className="subtle small danger" disabled={sections.length === 1} onClick={() => setSections(sections.filter((_, j) => j !== i))}>
                Remove section
              </button>
            </div>
            <ol className="field-order">
              {s.fields.map((k, j) => (
                <li key={k}>
                  <span className="grow">{label(k)}</span>
                  {form === "create" && (
                    <label className="inline small">
                      <input
                        type="checkbox"
                        checked={def!.requiredOnCreate.includes(k) || type!.fields.find((f) => f.key === k)?.required === true}
                        disabled={type!.fields.find((f) => f.key === k)?.required === true || k === "priority"}
                        onChange={(e) =>
                          update({ ...def!, requiredOnCreate: e.target.checked ? [...def!.requiredOnCreate, k] : def!.requiredOnCreate.filter((x) => x !== k) })
                        }
                      />
                      required
                    </label>
                  )}
                  <button
                    className="subtle small"
                    disabled={j === 0}
                    aria-label="Move up"
                    onClick={() => {
                      const f = [...s.fields];
                      [f[j - 1], f[j]] = [f[j]!, f[j - 1]!];
                      setSections(sections.map((x, n) => (n === i ? { ...x, fields: f } : x)));
                    }}
                  >
                    ↑
                  </button>
                  <button className="subtle small" aria-label="Remove field" onClick={() => setSections(sections.map((x, n) => (n === i ? { ...x, fields: x.fields.filter((y) => y !== k) } : x)))}>
                    ×
                  </button>
                </li>
              ))}
            </ol>
            <select
              aria-label="Add a field"
              value=""
              onChange={(e) => e.target.value && setSections(sections.map((x, n) => (n === i ? { ...x, fields: [...x.fields, e.target.value] } : x)))}
            >
              <option value="">Add a field…</option>
              {all.filter((k) => !used.has(k)).map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </select>
          </fieldset>
        ))}
        <button className="subtle" onClick={() => setSections([...sections, { title: "", fields: [] }])}>
          Add section
        </button>
      </div>
    );
  }

  return (
    <section>
      <AdminNav />
      <p className="muted small">
        <Link to={`/app/admin/projects/${type.projectId}`}>{type.project.name}</Link> · {type.name}
      </p>
      <h1>Layout</h1>
      <p className="muted">
        Which fields appear on the forms, in which order and sections. Requesters can fill in only what the create form shows, so leave internal fields off it.
      </p>
      <ConfigToolbar hasDraft={Boolean(cfg.bundle.draft)} dirty={dirty} onSave={() => cfg.saveDraft(def)} onPublish={() => cfg.publish()} onDiscard={() => cfg.discard()} />
      {cfg.notice && <p className="notice">{cfg.notice}</p>}
      <ErrorText error={cfg.error} />
      {cfg.issues.length > 0 && (
        <ul className="error small">
          {cfg.issues.map((i) => (
            <li key={i.field}>
              {i.field}: {i.message}
            </li>
          ))}
        </ul>
      )}
      <div className="columns-2">
        {FormEditor({ form: "create", title: "Create form", help: "Shown when someone submits a new record." })}
        {FormEditor({ form: "view", title: "Record page", help: "The details panel on a record, for viewing and editing." })}
      </div>
      <h2>Versions</h2>
      <VersionsPanel bundle={cfg.bundle} onRestore={cfg.restore} />
    </section>
  );
}
