import { useState } from "react";
import { api, issuesByField } from "../../api.ts";
import { ErrorText, useLoad } from "../../components/ui.tsx";
import { AdminNav } from "./AdminProjects.tsx";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_LABEL: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

interface Calendar {
  id: string;
  name: string;
  timezone: string;
  hours: Partial<Record<(typeof DAYS)[number], [string, string][]>>;
  holidays: string[];
}

const toText = (ivs: [string, string][] | undefined) => (ivs ?? []).map(([a, b]) => `${a}-${b}`).join(", ");
const fromText = (s: string): [string, string][] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.split("-").map((y) => y.trim()) as [string, string]);

function CalendarForm({ initial, onSaved }: { initial?: Calendar; onSaved: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [timezone, setTimezone] = useState(initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [hours, setHours] = useState<Record<string, string>>(
    Object.fromEntries(DAYS.map((d) => [d, initial ? toText(initial.hours[d]) : ["sat", "sun"].includes(d) ? "" : "09:00-17:00"])),
  );
  const [holidays, setHolidays] = useState((initial?.holidays ?? []).join("\n"));
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const body = {
      name,
      timezone,
      hours: Object.fromEntries(DAYS.map((d) => [d, fromText(hours[d] ?? "")])),
      holidays: holidays.split(/\s+/).filter(Boolean),
    };
    try {
      if (initial) await api.patch(`/api/admin/calendars/${initial.id}`, body);
      else await api.post("/api/admin/calendars", body);
      onSaved();
    } catch (err) {
      const issues = issuesByField(err);
      setError(Object.entries(issues).map(([k, v]) => `${k}: ${v}`).join("; ") || (err as Error).message);
    }
  }

  return (
    <div className="card stack">
      <div className="row wrap">
        <label className="field grow">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Head office" />
        </label>
        <label className="field">
          Time zone (IANA)
          <input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/Chicago" />
        </label>
      </div>
      <div className="days">
        {DAYS.map((d) => (
          <label key={d} className="field">
            {DAY_LABEL[d]}
            <input value={hours[d]} placeholder="closed" onChange={(e) => setHours({ ...hours, [d]: e.target.value })} />
          </label>
        ))}
      </div>
      <label className="field">
        Holidays (YYYY-MM-DD, one per line)
        <textarea rows={3} value={holidays} onChange={(e) => setHolidays(e.target.value)} />
      </label>
      <ErrorText error={error} />
      <div>
        <button className="primary" onClick={save}>
          {initial ? "Save calendar" : "Add calendar"}
        </button>
      </div>
    </div>
  );
}

export function AdminCalendars() {
  const list = useLoad(() => api.get<{ calendars: Calendar[] }>("/api/admin/calendars"), []);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <section>
      <AdminNav />
      <h1>Business-hours calendars</h1>
      <p className="muted">SLA clocks only count working hours on their calendar, in its own time zone, and skip holidays. Write hours like 09:00-12:00, 13:00-17:00.</p>
      {(list.data?.calendars ?? []).map((c) =>
        editing === c.id ? (
          <CalendarForm key={c.id} initial={c} onSaved={() => { setEditing(null); void list.reload(); }} />
        ) : (
          <div key={c.id} className="card row between">
            <div>
              <strong>{c.name}</strong> <span className="muted small">{c.timezone}</span>
              <div className="muted small">
                {DAYS.filter((d) => c.hours[d]?.length).map((d) => `${DAY_LABEL[d]} ${toText(c.hours[d])}`).join(" · ")}
                {c.holidays.length > 0 && ` · ${c.holidays.length} holidays`}
              </div>
            </div>
            <button className="subtle" onClick={() => setEditing(c.id)}>
              Edit
            </button>
          </div>
        ),
      )}
      <h2>Add a calendar</h2>
      <CalendarForm key={list.data?.calendars.length ?? 0} onSaved={() => void list.reload()} />
    </section>
  );
}
