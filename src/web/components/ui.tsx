import { useCallback, useEffect, useState, type DependencyList, type ReactNode } from "react";
import type { Category, SlaClock, WorkflowStatus } from "../types.ts";

/** Load data on mount and when deps change; `reload` re-runs it. */
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(async () => {
    try {
      setData(await run());
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload, setData };
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (Math.abs(s) < 60) return "just now";
  const fmt = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const abs = Math.abs(s);
  const label = abs < 3600 ? fmt(Math.round(abs / 60), "minute") : abs < 86400 ? fmt(Math.round(abs / 3600), "hour") : fmt(Math.round(abs / 86400), "day");
  return s >= 0 ? `${label} ago` : `in ${label}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  if (m % (60 * 24) === 0) return `${m / 60 / 24} d`;
  return m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function StatusPill({ status, statuses, category }: { status: string; statuses?: WorkflowStatus[]; category: Category }) {
  const name = statuses?.find((s) => s.key === status)?.name ?? status;
  return <span className={`status-pill ${category}`}>{name}</span>;
}

export function SlaBadge({ clock }: { clock: SlaClock }) {
  const label = clock.metric === "first_response" ? "First response" : "Resolution";
  let state = "ok";
  let text: string;
  if (clock.status === "met") {
    state = clock.breachedAt ? "late" : "met";
    text = clock.breachedAt ? "met late" : "met";
  } else if (clock.status === "paused") {
    state = "paused";
    text = "paused";
  } else if (clock.breachedAt) {
    state = "late";
    text = `breached ${timeAgo(clock.breachedAt)}`;
  } else {
    state = clock.warnedAt ? "warn" : "ok";
    text = `due ${timeAgo(clock.dueAt)}`;
  }
  return (
    <span className={`sla ${state}`} title={`${clock.policyName}: ${label} target ${fmtMinutes(clock.targetMinutes)}${clock.dueAt ? `, due ${new Date(clock.dueAt).toLocaleString()}` : ""}`}>
      <strong>{label}</strong> {text}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted empty">{children}</p>;
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  return error ? <p className="error">{error}</p> : null;
}
