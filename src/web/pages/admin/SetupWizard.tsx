// A guided setup for admins who are not developers: start from scratch, a template or a file,
// then answer plain questions step by step. The result is checked by the server exactly as a
// real install would be, then created in one go (and can be kept as a template).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { api, ApiError, type Issue } from "../../api.ts";
import { useSession } from "../../session.tsx";
import { ErrorText } from "../../components/ui.tsx";
import type { Category, FieldType, Priority, SavedTemplate, TemplateSummary } from "../../types.ts";
import { AdminNav } from "./AdminProjects.tsx";
import {
  agileTypes,
  BUILTIN_REQUIRABLE,
  blankState,
  CATEGORY_LABELS,
  FIELD_TYPES,
  fromDefinition,
  newField,
  newPolicy,
  newType,
  projectKeyFrom,
  slug,
  status,
  stepForIssue,
  stepsOf,
  toDefinition,
  uniqueKey,
  type TemplateDefinition,
  type Unit,
  type WField,
  type WizardState,
  type WPolicy,
  type WType,
} from "./wizard/model.ts";

const STEPS = ["Start", "Basics", "Types and fields", "Steps", "Targets", "Review"];
const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];

export function SetupWizard() {
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>(blankState);
  const [origin, setOrigin] = useState<string>("");
  const top = useRef<HTMLDivElement>(null);
  const go = (n: number) => {
    setStep(n);
    top.current?.scrollIntoView({ block: "start" });
  };
  const update = (fn: (s: WizardState) => WizardState) => setState((s) => fn(structuredClone(s)));

  return (
    <section className="wizard" ref={top}>
      <AdminNav />
      <p className="muted small">
        <Link to="/app/admin">Projects</Link> / New project
      </p>
      <h1>Set up a new project</h1>
      <ol className="wizard-steps" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? "current" : i < step ? "done" : ""}>
            <button type="button" className="link" disabled={i > 0 && !origin} onClick={() => go(i)} aria-current={i === step ? "step" : undefined}>
              <span className="step-n">{i + 1}</span> {label}
            </button>
          </li>
        ))}
      </ol>
      {step === 0 && (
        <StartStep
          onStart={(s, from) => {
            setState(s);
            setOrigin(from);
            go(1);
          }}
        />
      )}
      {step === 1 && <BasicsStep state={state} update={update} />}
      {step === 2 && <TypesStep state={state} update={update} />}
      {step === 3 && <StepsStep state={state} update={update} />}
      {step === 4 && <TargetsStep state={state} update={update} />}
      {step === 5 && <ReviewStep state={state} update={update} origin={origin} goTo={go} />}
      {step > 0 && step < 5 && (
        <div className="row wizard-nav">
          <button type="button" className="subtle" onClick={() => go(step - 1)}>
            Back
          </button>
          <button type="button" className="primary" onClick={() => go(step + 1)} disabled={step === 1 && (!state.project.name.trim() || !state.project.key)}>
            Next: {STEPS[step + 1]}
          </button>
        </div>
      )}
    </section>
  );
}

type Update = (fn: (s: WizardState) => WizardState) => void;

function Help({ children }: { children: ReactNode }) {
  return <p className="muted small help">{children}</p>;
}

// ---------------------------------------------------------------- 1. start

function StartStep({ onStart }: { onStart: (s: WizardState, origin: string) => void }) {
  const [builtins, setBuiltins] = useState<TemplateSummary[]>([]);
  const [saved, setSaved] = useState<SavedTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.get<{ templates: TemplateSummary[]; saved: SavedTemplate[] }>("/api/admin/templates").then((r) => {
      setBuiltins(r.templates);
      setSaved(r.saved.filter((t) => t.valid));
    });
  }, []);

  async function useTemplate(path: string, label: string) {
    setError(null);
    try {
      const r = await api.get<{ definition: TemplateDefinition }>(path);
      onStart(fromDefinition(r.definition), label);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function useFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const def = JSON.parse(await file.text()) as TemplateDefinition;
      if (def?.format !== "tend247-template" || !Array.isArray(def.recordTypes)) throw new Error("not a template");
      onStart(fromDefinition(def), `the file ${file.name}`);
    } catch {
      setError(`${file.name} is not a Tend 24/7 template file. Template files are downloaded from Admin > Projects.`);
    }
  }

  return (
    <div className="stack">
      <p>Answer a few questions and Tend 24/7 builds the project for you: its form, its steps, who sees it and how fast it should be handled. You can change anything afterwards.</p>
      <div className="start-grid">
        <button type="button" className="card start-card" onClick={() => onStart(blankState(), "scratch")}>
          <strong>Start from scratch</strong>
          <span className="muted small">A simple queue with New, In progress and Done that you shape as you go.</span>
        </button>
        <label className="card start-card">
          <strong>Use a template file</strong>
          <span className="muted small">A .json file downloaded from another Tend 24/7 workspace.</span>
          <input type="file" accept=".json,application/json" onChange={(e) => useFile(e.target.files?.[0])} />
        </label>
      </div>
      <ErrorText error={error} />
      <h2>Or start from a template</h2>
      <div className="template-grid">
        {[...saved.map((t) => ({ ...t, path: `/api/admin/templates/saved/${t.id}`, mine: true })), ...builtins.map((t) => ({ ...t, path: `/api/admin/templates/builtin/${t.key}`, mine: false }))].map((t) => (
          <button type="button" key={t.path} className="card template start-card" onClick={() => useTemplate(t.path, `the ${t.name} template`)}>
            <strong>
              {t.name}
              {t.mine && <span className="tag-mini">yours</span>}
              {t.agile && <span className="tag-mini">sprints</span>}
            </strong>
            <span className="muted small">{t.summary}</span>
            {t.recordTypes && <span className="small">{t.recordTypes.join(", ")}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 2. basics

function BasicsStep({ state, update }: { state: WizardState; update: Update }) {
  const { teams, projects } = useSession();
  const p = state.project;
  const taken = projects.some((x) => x.key === p.key.toUpperCase());
  return (
    <div className="stack">
      <div className="card stack">
        <div className="row wrap">
          <label className="field grow">
            What is this project called?
            <input
              value={p.name}
              autoFocus
              placeholder="Facilities requests"
              onChange={(e) =>
                update((s) => {
                  s.project.name = e.target.value;
                  if (!s.keyEdited) s.project.key = projectKeyFrom(e.target.value);
                  if (!s.name || s.name === state.project.name) s.name = e.target.value;
                  return s;
                })
              }
            />
          </label>
          <label className="field">
            Short key
            <input
              value={p.key}
              maxLength={10}
              className="mono"
              onChange={(e) =>
                update((s) => {
                  s.project.key = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
                  s.keyEdited = true;
                  return s;
                })
              }
            />
            {taken ? <span className="error small">Another project uses {p.key}</span> : <span className="muted small">Records are numbered {p.key || "KEY"}-1, {p.key || "KEY"}-2…</span>}
          </label>
        </div>
        <label className="field">
          Describe it in a sentence (people see this when they ask for something)
          <input value={p.description} placeholder="Something broken in the building? Tell facilities." onChange={(e) => update((s) => ((s.project.description = e.target.value), s))} />
        </label>
      </div>

      <div className="card stack">
        <h2>Who works on it</h2>
        <label className="field">
          Team that handles it
          <input
            list="wizard-teams"
            value={state.team}
            placeholder="Maintenance"
            onChange={(e) => update((s) => ((s.team = e.target.value), s))}
          />
          <datalist id="wizard-teams">
            {teams.map((t) => (
              <option key={t.id} value={t.name} />
            ))}
          </datalist>
          <span className="muted small">{state.team && !teams.some((t) => t.name === state.team.trim()) ? "A new team with this name is created. Add people to it afterwards." : "New work lands with this team."}</span>
        </label>
        <fieldset className="choices">
          <legend>How is work handed out?</legend>
          <label className="inline">
            <input type="radio" checked={p.assignment === "manual"} onChange={() => update((s) => ((s.project.assignment = "manual"), s))} />
            People pick it up themselves, or a lead assigns it
          </label>
          <label className="inline">
            <input type="radio" checked={p.assignment === "round_robin"} onChange={() => update((s) => ((s.project.assignment = "round_robin"), s))} />
            Take turns: each new item goes to the next person in the team
          </label>
        </fieldset>
      </div>

      <div className="card stack">
        <h2>Who can see it</h2>
        <label className="inline">
          <input type="checkbox" checked={p.requesterAccess} onChange={(e) => update((s) => ((s.project.requesterAccess = e.target.checked), s))} />
          Anyone in the company can send requests here (from the request portal or by email)
        </label>
        <label className="inline">
          <input type="checkbox" checked={p.restricted} onChange={(e) => update((s) => ((s.project.restricted = e.target.checked), s))} />
          Keep it private: only the team, admins and the person who asked can see each item (for HR or finance)
        </label>
      </div>

      <div className="card stack">
        <h2>Planning</h2>
        <label className="inline">
          <input
            type="checkbox"
            checked={p.agile}
            onChange={(e) =>
              update((s) => {
                s.project.agile = e.target.checked;
                return s;
              })
            }
          />
          Plan work in sprints: a ranked backlog, story points, epics, a sprint board and burndown charts
        </label>
        <Help>Turn this on for software or project teams that plan in fixed periods. Service queues usually leave it off.</Help>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 3. types and fields

function TypesStep({ state, update }: { state: WizardState; update: Update }) {
  const [open, setOpen] = useState(state.types[0]?.uid ?? "");
  const agile = state.project.agile;
  const hasAgileTypes = state.types.some((t) => t.isEpic);
  return (
    <div className="stack">
      <Help>
        A type is a kind of item people raise, like “Repair” or “Invoice exception”. Each type has its own form. Most projects need one; a software team might use Story, Bug and
        Task.
      </Help>
      {agile && !hasAgileTypes && (
        <div className="card row between wrap">
          <span>Use the usual types for a software team: Story, Bug, Task and Epic?</span>
          <button type="button" onClick={() => update((s) => ((s.types = agileTypes()), (s.sharedSteps = true), s))}>
            Use these types
          </button>
        </div>
      )}
      <div className="tabs" role="tablist">
        {state.types.map((t) => (
          <button key={t.uid} role="tab" type="button" aria-selected={open === t.uid} className={open === t.uid ? "on" : ""} onClick={() => setOpen(t.uid)}>
            {t.name || "Untitled"}
            {agile && t.isEpic ? " (epic)" : ""}
          </button>
        ))}
        <button
          type="button"
          className="subtle"
          disabled={state.types.length >= 20}
          onClick={() =>
            update((s) => {
              const t = newType("New type");
              t.key = uniqueKey(t.key, s.types.map((x) => x.key));
              const shared = s.types.find((x) => !x.isEpic);
              if (shared) t.statuses = structuredClone(shared.statuses);
              s.types.push(t);
              setOpen(t.uid);
              return s;
            })
          }
        >
          + Add a type
        </button>
      </div>
      {state.types.map((t, ti) =>
        t.uid !== open ? null : (
          <div key={t.uid} className="card stack">
            <div className="row wrap">
              <label className="field grow">
                Type name
                <input
                  value={t.name}
                  onChange={(e) =>
                    update((s) => {
                      const x = s.types[ti]!;
                      x.name = e.target.value;
                      if (!x.locked) x.key = uniqueKey(slug(e.target.value, "type"), s.types.filter((o) => o.uid !== x.uid).map((o) => o.key));
                      return s;
                    })
                  }
                />
              </label>
              {state.types.length > 1 && (
                <button
                  type="button"
                  className="subtle"
                  onClick={() =>
                    update((s) => {
                      s.types.splice(ti, 1);
                      setOpen(s.types[0]!.uid);
                      return s;
                    })
                  }
                >
                  Remove this type
                </button>
              )}
            </div>
            <label className="field">
              What is it for? (optional)
              <input value={t.description} onChange={(e) => update((s) => ((s.types[ti]!.description = e.target.value), s))} />
            </label>
            {agile && (
              <label className="inline">
                <input type="checkbox" checked={t.isEpic} onChange={(e) => update((s) => ((s.types[ti]!.isEpic = e.target.checked), s))} />
                This is an epic: a bigger piece of work that groups other items
              </label>
            )}
            <h3>Questions on the form</h3>
            <Help>Every form already asks for a title, a description and a priority. Add the questions this type needs.</Help>
            <FieldList type={t} onChange={(fields) => update((s) => ((s.types[ti]!.fields = fields), s))} />
          </div>
        ),
      )}
    </div>
  );
}

function FieldList({ type, onChange }: { type: WType; onChange: (fields: WField[]) => void }) {
  const fields = type.fields;
  const set = (i: number, patch: Partial<WField>) => {
    const next = structuredClone(fields);
    const f = { ...next[i]!, ...patch };
    if (patch.label !== undefined && !f.locked) f.key = uniqueKey(slug(patch.label, "field"), next.filter((_, j) => j !== i).map((x) => x.key));
    next[i] = f;
    onChange(next);
  };
  const move = (i: number, d: number) => {
    const next = [...fields];
    const [f] = next.splice(i, 1);
    next.splice(i + d, 0, f!);
    onChange(next);
  };
  return (
    <div className="stack">
      {fields.length === 0 && <p className="muted small">No extra questions yet.</p>}
      {fields.map((f, i) => (
        <div key={f.uid} className="field-row">
          <div className="row wrap">
            <label className="field grow">
              Question
              <input value={f.label} onChange={(e) => set(i, { label: e.target.value })} />
            </label>
            <span className="type-tag">{FIELD_TYPES.find((x) => x.type === f.type)?.label}</span>
            <label className="inline">
              <input type="checkbox" checked={f.required} onChange={(e) => set(i, { required: e.target.checked })} />
              Must be answered
            </label>
            <span className="row">
              <button type="button" className="subtle small" aria-label={`Move ${f.label} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" className="subtle small" aria-label={`Move ${f.label} down`} disabled={i === fields.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button type="button" className="subtle small" aria-label={`Remove ${f.label}`} onClick={() => onChange(fields.filter((_, j) => j !== i))}>
                Remove
              </button>
            </span>
          </div>
          {(f.type === "select" || f.type === "multi_select") && (
            <label className="field">
              Choices (one per line)
              <textarea rows={3} value={f.choices} onChange={(e) => set(i, { choices: e.target.value })} />
            </label>
          )}
          {f.type === "currency" && (
            <label className="field narrow">
              Currency
              <input value={f.currency} maxLength={3} onChange={(e) => set(i, { currency: e.target.value.toUpperCase() })} />
            </label>
          )}
          <label className="field">
            Hint shown under the question (optional)
            <input value={f.helpText} onChange={(e) => set(i, { helpText: e.target.value })} />
          </label>
        </div>
      ))}
      <div className="palette" role="group" aria-label="Add a question">
        {FIELD_TYPES.map((ft) => (
          <button
            key={ft.type}
            type="button"
            title={ft.hint}
            disabled={fields.length >= 60}
            onClick={() => onChange([...fields, newField(ft.type as FieldType, fields.map((x) => x.key))])}
          >
            + {ft.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 4. steps

function StepsStep({ state, update }: { state: WizardState; update: Update }) {
  const work = state.types.filter((t) => !t.isEpic || !state.project.agile);
  const editable = state.sharedSteps ? [work[0], ...state.types.filter((t) => t.isEpic && state.project.agile)].filter(Boolean) : state.types;
  const [open, setOpen] = useState(editable[0]?.uid ?? "");
  const current = editable.find((t) => t?.uid === open) ?? editable[0];
  return (
    <div className="stack">
      <Help>Steps are the stages an item goes through, like New → In progress → Done. They become the columns of the board.</Help>
      {work.length > 1 && (
        <label className="inline">
          <input type="checkbox" checked={state.sharedSteps} onChange={(e) => update((s) => ((s.sharedSteps = e.target.checked), s))} />
          Every type uses the same steps
        </label>
      )}
      {editable.length > 1 && (
        <div className="tabs" role="tablist">
          {editable.map((t) => (
            <button key={t!.uid} role="tab" type="button" aria-selected={current?.uid === t!.uid} className={current?.uid === t!.uid ? "on" : ""} onClick={() => setOpen(t!.uid)}>
              {state.sharedSteps && !(t!.isEpic && state.project.agile) ? "All types" : t!.name}
            </button>
          ))}
        </div>
      )}
      {current && <StepsEditor key={current.uid} state={state} typeIndex={state.types.findIndex((t) => t.uid === current.uid)} update={update} />}
    </div>
  );
}

function StepsEditor({ state, typeIndex, update }: { state: WizardState; typeIndex: number; update: Update }) {
  const t = state.types[typeIndex]!;
  const [newName, setNewName] = useState("");
  const [newCat, setNewCat] = useState<Category>("in_progress");
  const edit = (fn: (x: WType) => void) => update((s) => (fn(s.types[typeIndex]!), s));
  // Fields that can be required: those of every type sharing these steps.
  const sharing = state.types.filter((x) => stepsOf(state, x).uid === t.uid);
  const requirable = [
    ...BUILTIN_REQUIRABLE,
    ...sharing.flatMap((x) => x.fields.map((f) => ({ key: f.key, label: f.label }))).filter((f, i, a) => a.findIndex((y) => y.key === f.key) === i),
  ];
  const firstWork = t.statuses.find((x) => x.category === "in_progress");

  return (
    <div className="card stack">
      <h3>Steps</h3>
      <ol className="status-list">
        {t.statuses.map((st, i) => (
          <li key={st.uid} className="row wrap">
            <span className="step-n">{i + 1}</span>
            <input
              aria-label={`Name of step ${i + 1}`}
              value={st.name}
              onChange={(e) =>
                edit((x) => {
                  const s2 = x.statuses[i]!;
                  const oldKey = s2.key;
                  s2.name = e.target.value;
                  if (!s2.locked) {
                    s2.key = uniqueKey(slug(e.target.value, "status"), x.statuses.filter((_, j) => j !== i).map((y) => y.key));
                    if (x.rules[oldKey]) {
                      x.rules[s2.key] = x.rules[oldKey]!;
                      if (oldKey !== s2.key) delete x.rules[oldKey];
                    }
                  }
                })
              }
            />
            <select aria-label={`Stage of ${st.name}`} value={st.category} onChange={(e) => edit((x) => (x.statuses[i]!.category = e.target.value as Category))}>
              {(Object.keys(CATEGORY_LABELS) as Category[]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
            {i === 0 && <span className="muted small">New items start here</span>}
            <span className="row">
              <button type="button" className="subtle small" aria-label={`Move ${st.name} up`} disabled={i === 0} onClick={() => edit((x) => x.statuses.splice(i - 1, 0, ...x.statuses.splice(i, 1)))}>
                ↑
              </button>
              <button
                type="button"
                className="subtle small"
                aria-label={`Move ${st.name} down`}
                disabled={i === t.statuses.length - 1}
                onClick={() => edit((x) => x.statuses.splice(i + 1, 0, ...x.statuses.splice(i, 1)))}
              >
                ↓
              </button>
              <button type="button" className="subtle small" disabled={t.statuses.length <= 2} onClick={() => edit((x) => x.statuses.splice(i, 1))}>
                Remove
              </button>
            </span>
          </li>
        ))}
      </ol>
      <form
        className="row wrap add-step"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newName.trim()) return;
          edit((x) => {
            const s2 = status(newName.trim(), newCat);
            s2.key = uniqueKey(s2.key, x.statuses.map((y) => y.key));
            // Keep finished steps last.
            const at = newCat === "done" ? x.statuses.length : x.statuses.findIndex((y) => y.category === "done");
            x.statuses.splice(at < 0 ? x.statuses.length : at, 0, s2);
          });
          setNewName("");
        }}
      >
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Add a step, e.g. Waiting for parts" aria-label="New step name" />
        <select value={newCat} onChange={(e) => setNewCat(e.target.value as Category)} aria-label="Stage of the new step">
          {(Object.keys(CATEGORY_LABELS) as Category[]).map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <button type="submit" disabled={t.statuses.length >= 30}>
          Add step
        </button>
      </form>
      {!t.statuses.some((x) => x.category === "done") && <p className="error small">Add at least one finished step, so work can be completed.</p>}

      <h3>How items move between steps</h3>
      <fieldset className="choices">
        <label className="inline">
          <input type="radio" checked={t.flow === "free"} onChange={() => edit((x) => (x.flow = "free"))} />
          Freely: any step to any other (good for boards)
        </label>
        <label className="inline">
          <input type="radio" checked={t.flow === "ordered"} onChange={() => edit((x) => (x.flow = "ordered"))} />
          In order: each step leads to the next, and work can be finished from any step
        </label>
        {t.custom.length > 0 && (
          <label className="inline">
            <input type="radio" checked={t.flow === "custom"} onChange={() => edit((x) => (x.flow = "custom"))} />
            As the template defines ({t.custom.length} moves)
          </label>
        )}
      </fieldset>
      {t.flow === "ordered" && (
        <label className="inline">
          <input type="checkbox" checked={t.requesterReopen} onChange={(e) => edit((x) => (x.requesterReopen = e.target.checked))} />
          The person who asked can reopen it if it was not fixed
        </label>
      )}
      {firstWork && (
        <label className="inline">
          <input type="checkbox" checked={t.assignOnStart} onChange={(e) => edit((x) => (x.assignOnStart = e.target.checked))} />
          Assign the item to whoever moves it to {firstWork.name}
        </label>
      )}

      <h3>Checks before a step</h3>
      <Help>For each step, choose whether moving there needs someone's approval, and which questions must be answered first.</Help>
      <table className="grid compact rules">
        <thead>
          <tr>
            <th>Moving to</th>
            <th>Needs approval</th>
            <th>Must be filled in first</th>
          </tr>
        </thead>
        <tbody>
          {t.statuses.slice(1).map((st) => {
            const rule = t.rules[st.key] ?? { approval: false, required: [] };
            return (
              <tr key={st.uid}>
                <td>{st.name}</td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Moving to ${st.name} needs approval`}
                    checked={rule.approval}
                    onChange={(e) => edit((x) => (x.rules[st.key] = { ...rule, approval: e.target.checked }))}
                  />
                </td>
                <td>
                  <div className="chips">
                    {requirable.map((f) => (
                      <label key={f.key} className={`chip ${rule.required.includes(f.key) ? "on" : ""}`}>
                        <input
                          type="checkbox"
                          checked={rule.required.includes(f.key)}
                          onChange={(e) =>
                            edit(
                              (x) =>
                                (x.rules[st.key] = {
                                  ...rule,
                                  required: e.target.checked ? [...rule.required, f.key] : rule.required.filter((k) => k !== f.key),
                                }),
                            )
                          }
                        />
                        {f.label}
                      </label>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- 5. targets

function TargetsStep({ state, update }: { state: WizardState; update: Update }) {
  const sla = state.sla;
  const waiting = state.types
    .flatMap((t) => stepsOf(state, t).statuses)
    .filter((s, i, a) => s.category === "in_progress" && a.findIndex((x) => x.key === s.key) === i);
  const setPolicy = (i: number, fn: (p: WPolicy) => void) => update((s) => (fn(s.sla.policies[i]!), s));
  return (
    <div className="stack">
      <Help>Targets say how quickly the team should answer and finish. Tend 24/7 warns before a target is missed and shows what is late.</Help>
      <label className="inline">
        <input
          type="checkbox"
          checked={sla.enabled}
          onChange={(e) =>
            update((s) => {
              s.sla.enabled = e.target.checked;
              if (e.target.checked && !s.sla.policies.length) s.sla.policies.push(newPolicy());
              return s;
            })
          }
        />
        Set response and resolution targets
      </label>
      {sla.enabled && (
        <>
          {sla.policies.map((p, i) => (
            <div key={p.uid} className="card stack">
              <div className="row wrap">
                <label className="field grow">
                  Name
                  <input value={p.name} onChange={(e) => setPolicy(i, (x) => (x.name = e.target.value))} />
                </label>
                <button type="button" className="subtle" onClick={() => update((s) => (s.sla.policies.splice(i, 1), s))}>
                  Remove
                </button>
              </div>
              <div className="chips" role="group" aria-label="Applies to priorities">
                <span className="muted small">Applies to</span>
                <label className={`chip ${p.priorities.length === 0 ? "on" : ""}`}>
                  <input type="checkbox" checked={p.priorities.length === 0} onChange={() => setPolicy(i, (x) => (x.priorities = []))} />
                  Every priority
                </label>
                {PRIORITIES.map((pr) => (
                  <label key={pr} className={`chip ${p.priorities.includes(pr) ? "on" : ""}`}>
                    <input
                      type="checkbox"
                      checked={p.priorities.includes(pr)}
                      onChange={(e) => setPolicy(i, (x) => (x.priorities = e.target.checked ? [...x.priorities, pr] : x.priorities.filter((y) => y !== pr)))}
                    />
                    {pr[0]!.toUpperCase() + pr.slice(1)}
                  </label>
                ))}
              </div>
              <div className="row wrap">
                <Duration label="First response within" value={p.firstResponse} onChange={(v) => setPolicy(i, (x) => (x.firstResponse = v))} />
                <Duration label="Finished within" value={p.resolution} onChange={(v) => setPolicy(i, (x) => (x.resolution = v))} />
              </div>
              <label className="inline">
                <input type="checkbox" checked={p.businessHours} onChange={(e) => setPolicy(i, (x) => (x.businessHours = e.target.checked))} />
                Count working hours only (Monday to Friday, 9 to 5; a day is 8 working hours)
              </label>
            </div>
          ))}
          <button type="button" className="subtle" disabled={sla.policies.length >= 20} onClick={() => update((s) => (s.sla.policies.push(newPolicy("Urgent")), s))}>
            + Add another target (for example, faster for urgent items)
          </button>
          <Help>When several targets match an item, the first one in this list is used. Put the most specific (urgent) first.</Help>
          {waiting.length > 0 && (
            <div className="chips" role="group" aria-label="Pause the clock">
              <span className="muted small">Pause the clock while an item is</span>
              {waiting.map((st) => (
                <label key={st.key} className={`chip ${sla.pauseStatuses.includes(st.key) ? "on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={sla.pauseStatuses.includes(st.key)}
                    onChange={(e) =>
                      update((s) => ((s.sla.pauseStatuses = e.target.checked ? [...s.sla.pauseStatuses, st.key] : s.sla.pauseStatuses.filter((k) => k !== st.key)), s))
                    }
                  />
                  {st.name}
                </label>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Duration({ label, value, onChange }: { label: string; value: { value: string; unit: Unit }; onChange: (v: { value: string; unit: Unit }) => void }) {
  return (
    <label className="field">
      {label}
      <span className="row">
        <input type="number" min={0} step="any" className="narrow" value={value.value} onChange={(e) => onChange({ ...value, value: e.target.value })} placeholder="No target" />
        <select value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value as Unit })} aria-label={`${label} unit`}>
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
      </span>
    </label>
  );
}

// ---------------------------------------------------------------- 6. review

function ReviewStep({ state, update, origin, goTo }: { state: WizardState; update: Update; origin: string; goTo: (n: number) => void }) {
  const { people, me, reload } = useSession();
  const navigate = useNavigate();
  const definition = useMemo(() => toDefinition(state), [state]);
  const [checking, setChecking] = useState(true);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [approvers, setApprovers] = useState<string[]>(me ? [me.id] : []);
  const [keep, setKeep] = useState(origin === "scratch");
  const [busy, setBusy] = useState(false);
  const needsApprovers = definition.recordTypes.some((r) => r.workflow.transitions.some((t) => t.approval));
  const staff = people.filter((p) => p.role !== "requester");
  const options = needsApprovers && approvers.length ? { approverIds: approvers } : {};

  useEffect(() => {
    let live = true;
    setChecking(true);
    api
      .post("/api/admin/templates/check", { definition, options })
      .then(() => live && (setIssues([]), setProblem(null)))
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && err.issues.length) setIssues(err.issues);
        else setProblem((err as Error).message);
      })
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition, approvers.join(",")]);

  async function create() {
    setBusy(true);
    setProblem(null);
    try {
      const r = await api.post<{ project: { id: string } }>("/api/admin/templates/install", { definition, options });
      if (keep) {
        const name = (state.name || state.project.name).slice(0, 100);
        try {
          await api.post("/api/admin/templates/saved", { definition, name, source: "wizard" });
        } catch (err) {
          // Never overwrite someone's template: keep both, the new one dated.
          if (err instanceof ApiError && err.code === "conflict") {
            await api.post("/api/admin/templates/saved", { definition, name: `${name} (${new Date().toISOString().slice(0, 10)})`, source: "wizard" }).catch(() => {});
          }
          /* otherwise the project exists; saving the template is a convenience */
        }
      }
      await reload();
      navigate(state.project.agile ? `/app/plan/${r.project.id}/backlog` : `/app/admin/projects/${r.project.id}`, { state: { created: true } });
    } catch (err) {
      if (err instanceof ApiError && err.issues.length) setIssues(err.issues);
      else setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function download() {
    const blob = new Blob([JSON.stringify(definition, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${slug(definition.name, "template").replace(/_/g, "-")}.tend247-template.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  const p = definition.project;
  return (
    <div className="stack">
      <div className="card stack">
        <h2>
          {p.name} <span className="muted mono">{p.key}</span>
        </h2>
        <ul className="review">
          <li>{p.description || <span className="muted">No description</span>}</li>
          <li>
            Handled by {definition.team ? <strong>{definition.team}</strong> : "no particular team"};{" "}
            {p.assignment === "round_robin" ? "new items go to each team member in turn" : "people pick work up themselves"}.
          </li>
          <li>
            {p.requesterAccess ? "Anyone can send requests" : "Only staff create items"}
            {p.restricted ? "; each item is private to the team and the person who asked" : ""}.
          </li>
          {p.agile && <li>Planned in sprints, with a backlog, story points and epics.</li>}
          {definition.recordTypes.map((t) => (
            <li key={t.key}>
              <strong>{t.name}</strong>
              {t.isEpic ? " (epic)" : ""}: {t.fields.length ? t.fields.map((f) => `${f.label}${f.required ? "*" : ""}`).join(", ") : "title, description and priority only"}. Steps:{" "}
              {t.workflow.statuses.map((s) => s.name).join(" → ")}
              {t.workflow.transitions.some((x) => x.approval) ? "; some moves need approval" : ""}.
            </li>
          ))}
          {definition.sla?.policies.map((sp) => (
            <li key={sp.name}>
              Target “{sp.name}”{sp.priorities.length ? ` for ${sp.priorities.join(" and ")} items` : ""}: first response {sp.firstResponseMinutes ? fmtMin(sp.firstResponseMinutes, sp.businessHours) : "—"}, finished within{" "}
              {sp.resolutionMinutes ? fmtMin(sp.resolutionMinutes, sp.businessHours) : "—"}
              {sp.businessHours ? " (working hours)" : ""}.
            </li>
          ))}
          {definition.automation.length > 0 && <li>{definition.automation.length} automation rule{definition.automation.length === 1 ? "" : "s"} from the template.</li>}
        </ul>
        <p className="muted small">Started from {origin === "scratch" ? "scratch" : origin}.</p>
      </div>

      {needsApprovers && (
        <div className="card stack">
          <h2>Who approves?</h2>
          <div className="chips">
            {staff.map((u) => (
              <label key={u.id} className={`chip ${approvers.includes(u.id) ? "on" : ""}`}>
                <input type="checkbox" checked={approvers.includes(u.id)} onChange={(e) => setApprovers((a) => (e.target.checked ? [...a, u.id] : a.filter((x) => x !== u.id)))} />
                {u.displayName}
              </label>
            ))}
          </div>
          <Help>Any one of them can approve. You can change this later in the workflow editor.</Help>
        </div>
      )}

      <div className="card stack" aria-live="polite">
        {checking ? (
          <p className="muted">Checking…</p>
        ) : issues.length ? (
          <>
            <h2>A few things to fix</h2>
            <ul>
              {issues.map((i, n) => (
                <li key={n}>
                  {friendly(i, state)}{" "}
                  <button type="button" className="link" onClick={() => goTo(stepForIssue(i.field))}>
                    Go to {STEPS[stepForIssue(i.field)]}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : problem ? (
          <ErrorText error={problem} />
        ) : (
          <p>
            <span className="status-icon good" aria-hidden="true">
              ✓
            </span>{" "}
            Everything checks out.
          </p>
        )}
        <label className="inline">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          Also save this setup as a template, to use again or share with another workspace
        </label>
        {keep && (
          <label className="field">
            Template name
            <input value={state.name} onChange={(e) => update((s) => ((s.name = e.target.value), s))} placeholder={state.project.name} />
          </label>
        )}
        <div className="row wrap">
          <button type="button" className="primary" disabled={busy || checking || issues.length > 0} onClick={create}>
            {busy ? "Creating…" : "Create project"}
          </button>
          <button type="button" className="subtle" onClick={download}>
            Download as a template file
          </button>
          <button type="button" className="subtle" onClick={() => goTo(4)}>
            Back
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtMin(m: number, business: boolean): string {
  const day = business ? 480 : 1440;
  if (m % day === 0) return `${m / day} ${business ? "working " : ""}day${m / day === 1 ? "" : "s"}`;
  if (m % 60 === 0) return `${m / 60} hour${m / 60 === 1 ? "" : "s"}`;
  return `${m} minutes`;
}

/** Say where a problem is in the wizard's words, not the template's field paths. */
function friendly(issue: Issue, state: WizardState): string {
  const m = /^recordTypes\.(\d+)(?:\.(fields)\.(\d+))?/.exec(issue.field);
  if (m) {
    const t = state.types[Number(m[1])];
    const f = m[2] ? t?.fields[Number(m[3])] : undefined;
    return `${t?.name ?? "A type"}${f ? `, “${f.label}”` : ""}: ${issue.message}`;
  }
  if (issue.field === "projectKey" || issue.field.startsWith("project")) return `Basics: ${issue.message}`;
  if (issue.field.startsWith("sla")) return `Targets: ${issue.message}`;
  return issue.message;
}
