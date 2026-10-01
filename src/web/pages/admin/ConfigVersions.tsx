// Shared pieces for versioned configuration (workflows, layouts, SLA policies): load the
// bundle, save a draft, publish (asking for a status mapping when a workflow removes statuses
// that records use), and restore an earlier version.
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../api.ts";
import { useSession } from "../../session.tsx";
import { timeAgo } from "../../components/ui.tsx";
import type { ConfigBundle } from "../../types.ts";

export interface NeedsMap {
  statuses: { key: string; name: string; count: number }[];
  /** What to retry once the admin picks replacements. */
  retry: (statusMap: Record<string, string>) => Promise<void>;
}

export function useConfig<D>(kind: "workflow" | "layout" | "sla", ownerId: string) {
  const { reload: reloadSession } = useSession();
  const [bundle, setBundle] = useState<ConfigBundle<D> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ field: string; message: string }[]>([]);
  const [needsMap, setNeedsMap] = useState<NeedsMap | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const base = `/api/admin/config/${kind}/${ownerId}`;

  const load = useCallback(async () => {
    setBundle(await api.get<ConfigBundle<D>>(base));
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  const handle = useCallback(
    async (fn: () => Promise<unknown>, done: string, retry?: (m: Record<string, string>) => Promise<unknown>) => {
      setError(null);
      setIssues([]);
      setNotice(null);
      try {
        await fn();
        setNeedsMap(null);
        await load();
        await reloadSession();
        setNotice(done);
      } catch (err) {
        if (err instanceof ApiError && Array.isArray(err.details.statusesNeedingMap) && retry) {
          setNeedsMap({
            statuses: err.details.statusesNeedingMap as NeedsMap["statuses"],
            retry: async (m) => {
              await handle(() => retry(m), done, retry);
            },
          });
          return;
        }
        setError((err as Error).message);
        if (err instanceof ApiError) setIssues(err.issues);
      }
    },
    [load, reloadSession],
  );

  return {
    bundle,
    error,
    issues,
    notice,
    needsMap,
    cancelMap: () => setNeedsMap(null),
    saveDraft: (definition: D) => handle(() => api.put(`${base}/draft`, { definition }), "Draft saved. Publish it to put it in force."),
    discard: () => handle(() => api.delete(`${base}/draft`), "Draft discarded."),
    publish: () =>
      handle(
        () => api.post(`${base}/publish`, {}),
        "Published.",
        (statusMap) => api.post(`${base}/publish`, { statusMap }),
      ),
    restore: (version: number) =>
      handle(
        () => api.post(`${base}/versions/${version}/restore`, {}),
        `Version ${version} restored as the newest version.`,
        (statusMap) => api.post(`${base}/versions/${version}/restore`, { statusMap }),
      ),
  };
}

export function StatusMapDialog({ needs, statuses, onCancel }: { needs: NeedsMap; statuses: { key: string; name: string }[]; onCancel: () => void }) {
  const [map, setMap] = useState<Record<string, string>>(Object.fromEntries(needs.statuses.map((s) => [s.key, statuses[0]?.key ?? ""])));
  return (
    <div className="card warn">
      <strong>Some records are in statuses this version removes.</strong>
      <p className="muted small">Choose where those records move. The move is recorded in each record's history.</p>
      {needs.statuses.map((s) => (
        <label key={s.key} className="row">
          <span className="grow">
            {s.name} ({s.count} record{s.count === 1 ? "" : "s"}) →
          </span>
          <select value={map[s.key]} onChange={(e) => setMap({ ...map, [s.key]: e.target.value })}>
            {statuses.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      ))}
      <div className="row">
        <button className="primary" onClick={() => needs.retry(map)}>
          Move records and publish
        </button>
        <button className="subtle" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function VersionsPanel<D>({ bundle, onRestore }: { bundle: ConfigBundle<D>; onRestore: (version: number) => void }) {
  if (!bundle.versions.length) return <p className="muted small">Nothing published yet; the built-in default is in force.</p>;
  return (
    <table className="grid compact">
      <thead>
        <tr>
          <th>Version</th>
          <th>State</th>
          <th>Published</th>
          <th>By</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {bundle.versions.map((v) => (
          <tr key={v.id}>
            <td>v{v.version}</td>
            <td>{v.state === "published" ? <strong>in force</strong> : <span className="muted">earlier</span>}</td>
            <td className="muted">{timeAgo(v.publishedAt)}</td>
            <td className="muted">{v.createdByName ?? ""}</td>
            <td>
              {v.state !== "published" && (
                <button className="subtle small" onClick={() => window.confirm(`Publish a copy of version ${v.version} as the newest version?`) && onRestore(v.version)}>
                  Restore
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ConfigToolbar({ hasDraft, dirty, onSave, onPublish, onDiscard }: { hasDraft: boolean; dirty: boolean; onSave: () => void; onPublish: () => void; onDiscard: () => void }) {
  return (
    <div className="row toolbar">
      <button onClick={onSave} disabled={!dirty}>
        Save draft
      </button>
      <button className="primary" onClick={onPublish} disabled={!hasDraft || dirty} title={dirty ? "Save the draft first" : ""}>
        Publish draft
      </button>
      {hasDraft && (
        <button className="subtle" onClick={onDiscard}>
          Discard draft
        </button>
      )}
      <span className="muted small">{hasDraft ? (dirty ? "Unsaved changes" : "Draft saved, not yet published") : dirty ? "Unsaved changes" : "Showing the version in force"}</span>
    </div>
  );
}
