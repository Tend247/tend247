import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../../api.ts";
import { ErrorText, fmtMinutes, useLoad } from "../../components/ui.tsx";
import type { Priority, Project } from "../../types.ts";
import { ConfigToolbar, useConfig, VersionsPanel } from "./ConfigVersions.tsx";

interface Policy {
  name: string;
  match: { priorities: Priority[]; recordTypeIds: string[] };
  firstResponseMinutes: number | null;
  resolutionMinutes: number | null;
  calendarId: string | null;
  warnPercent: number;
}

interface SlaDef {
  policies: Policy[];
  pauseStatuses: string[];
}

const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];

/** Hours input that stores minutes. */
function Duration({ value, onChange, label }: { value: number | null; onChange: (m: number | null) => void; label: string }) {
  return (
    <label className="field">
      {label}
      <span className="row">
        <input
          type="number"
          min={0}
          step={0.25}
          style={{ width: "6rem" }}
          value={value === null ? "" : value / 60}
          onChange={(e) => onChange(e.target.value === "" ? null : Math.max(1, Math.round(Number(e.target.value) * 60)))}
        />
        <span className="muted small">hours</span>
      </span>
    </label>
  );
}

export function SlaEditor({ project }: { project: Project }) {
  const cfg = useConfig<SlaDef>("sla", project.id);
  const calendars = useLoad(() => api.get<{ calendars: { id: string; name: string; timezone: string }[] }>("/api/admin/calendars"), []);
  const [def, setDef] = useState<SlaDef | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (cfg.bundle) {
      setDef(structuredClone(cfg.bundle.draft?.definition ?? cfg.bundle.effective ?? { policies: [], pauseStatuses: [] }));
      setDirty(false);
    }
  }, [cfg.bundle]);

  if (!def || !cfg.bundle) return null;
  const update = (next: SlaDef) => {
    setDef(next);
    setDirty(true);
  };
  const setPolicy = (i: number, patch: Partial<Policy>) => update({ ...def, policies: def.policies.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const statuses = [...new Map(project.recordTypes.flatMap((t) => t.workflow.statuses).map((s) => [s.key, s])).values()];

  return (
    <div className="card">
      <h2>Service levels</h2>
      <p className="muted small">
        The first policy that matches a record sets its first-response and resolution targets. Clocks count working time on the chosen calendar (or around the
        clock) and stop while a record is in a paused status. Assignees are warned before a target and told when it is breached.
      </p>
      <ConfigToolbar hasDraft={Boolean(cfg.bundle.draft)} dirty={dirty} onSave={() => cfg.saveDraft(def)} onPublish={() => cfg.publish()} onDiscard={() => cfg.discard()} />
      {cfg.notice && <p className="notice">{cfg.notice}</p>}
      <ErrorText error={cfg.error} />
      {def.policies.map((p, i) => (
        <div key={i} className="transition-edit">
          <div className="row wrap">
            <label className="field grow">
              Policy name
              <input value={p.name} onChange={(e) => setPolicy(i, { name: e.target.value })} />
            </label>
            <Duration label="First response" value={p.firstResponseMinutes} onChange={(m) => setPolicy(i, { firstResponseMinutes: m })} />
            <Duration label="Resolution" value={p.resolutionMinutes} onChange={(m) => setPolicy(i, { resolutionMinutes: m })} />
            <label className="field">
              Calendar
              <select value={p.calendarId ?? ""} onChange={(e) => setPolicy(i, { calendarId: e.target.value || null })}>
                <option value="">24×7</option>
                {(calendars.data?.calendars ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.timezone})
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Warn at
              <span className="row">
                <input type="number" min={1} max={99} style={{ width: "5rem" }} value={p.warnPercent} onChange={(e) => setPolicy(i, { warnPercent: Number(e.target.value) })} />
                <span className="muted small">%</span>
              </span>
            </label>
            <button className="subtle small danger" onClick={() => update({ ...def, policies: def.policies.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
          <div className="checkline">
            <span className="muted small">Applies to priorities:</span>
            {PRIORITIES.map((pr) => (
              <label key={pr} className="inline">
                <input
                  type="checkbox"
                  checked={p.match.priorities.includes(pr)}
                  onChange={(e) => setPolicy(i, { match: { ...p.match, priorities: e.target.checked ? [...p.match.priorities, pr] : p.match.priorities.filter((x) => x !== pr) } })}
                />
                {pr}
              </label>
            ))}
            <span className="muted small">(none ticked = all)</span>
          </div>
          {project.recordTypes.length > 1 && (
            <div className="checkline">
              <span className="muted small">Record types:</span>
              {project.recordTypes.map((t) => (
                <label key={t.id} className="inline">
                  <input
                    type="checkbox"
                    checked={p.match.recordTypeIds.includes(t.id)}
                    onChange={(e) =>
                      setPolicy(i, { match: { ...p.match, recordTypeIds: e.target.checked ? [...p.match.recordTypeIds, t.id] : p.match.recordTypeIds.filter((x) => x !== t.id) } })
                    }
                  />
                  {t.name}
                </label>
              ))}
            </div>
          )}
          <p className="muted small">
            {[p.firstResponseMinutes && `first response in ${fmtMinutes(p.firstResponseMinutes)}`, p.resolutionMinutes && `resolved in ${fmtMinutes(p.resolutionMinutes)}`].filter(Boolean).join(", ")}
          </p>
          <ErrorText error={cfg.issues.find((x) => x.field.startsWith(`policies.${i}`))?.message} />
        </div>
      ))}
      <button
        onClick={() =>
          update({
            ...def,
            policies: [...def.policies, { name: `Policy ${def.policies.length + 1}`, match: { priorities: [], recordTypeIds: [] }, firstResponseMinutes: 240, resolutionMinutes: 2880, calendarId: null, warnPercent: 80 }],
          })
        }
      >
        Add policy
      </button>
      <div className="checkline">
        <span className="muted small">Clocks pause in:</span>
        {statuses.map((s) => (
          <label key={s.key} className="inline">
            <input
              type="checkbox"
              checked={def.pauseStatuses.includes(s.key)}
              onChange={(e) => update({ ...def, pauseStatuses: e.target.checked ? [...def.pauseStatuses, s.key] : def.pauseStatuses.filter((x) => x !== s.key) })}
            />
            {s.name}
          </label>
        ))}
      </div>
      <p className="muted small">
        Business hours and holidays live in <Link to="/app/admin/calendars">Calendars</Link>.
      </p>
      <details>
        <summary className="small">Versions</summary>
        <VersionsPanel bundle={cfg.bundle} onRestore={cfg.restore} />
      </details>
    </div>
  );
}
