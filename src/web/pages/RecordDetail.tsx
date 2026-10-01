import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, issuesByField } from "../api.ts";
import { allRecordTypes, personName, useSession } from "../session.tsx";
import { FieldInput, formatValue } from "../components/FieldInput.tsx";
import { ErrorText, SlaBadge, StatusPill, fmtBytes, timeAgo } from "../components/ui.tsx";
import type { Attachment, AvailableTransition, Comment, Field, Priority, RecordDetailData, RecordEvent, WorkRecord } from "../types.ts";

const BUILTIN_LABELS: Record<string, string> = {
  title: "Title",
  description: "Description",
  priority: "Priority",
  assigneeId: "Assignee",
  requesterId: "Requester",
  teamId: "Team",
};

const EVENT_TEXT: Record<string, string> = {
  created: "created this record",
  deleted: "moved it to the trash",
  restored: "restored it from the trash",
  commented: "commented",
  comment_edited: "edited a comment",
  comment_deleted: "deleted a comment",
  comment_restored: "restored a comment",
  attachment_added: "attached a file",
  attachment_removed: "removed a file",
  attachment_restored: "restored a file",
  approval_requested: "asked for approval",
  approval_step: "approved a step",
  approval_cancelled: "withdrew an approval request",
  linked: "linked a record",
  unlinked: "removed a link",
  automation_ran: "ran an automation rule",
  automation_failed: "automation rule failed",
  action_failed: "a transition action failed",
  status_mapped: "moved it to a new status after a workflow change",
};

export function RecordDetail() {
  const { key = "" } = useParams();
  const { projects, people, teams, me, settings } = useSession();
  const navigate = useNavigate();
  const [data, setData] = useState<RecordDetailData | null>(null);
  const [events, setEvents] = useState<RecordEvent[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<WorkRecord>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notFound, setNotFound] = useState(false);
  const [pending, setPending] = useState<AvailableTransition | null>(null);
  const staff = me?.role !== "requester";

  const load = useCallback(async () => {
    try {
      const d = await api.get<RecordDetailData>(`/api/records/${key}`);
      setData(d);
      const [ev, cm, at] = await Promise.all([
        api.get<{ events: RecordEvent[] }>(`/api/records/${key}/events`),
        api.get<{ comments: Comment[] }>(`/api/records/${key}/comments`),
        api.get<{ attachments: Attachment[] }>(`/api/records/${key}/attachments`),
      ]);
      setEvents(ev.events);
      setComments(cm.comments);
      setAttachments(at.attachments);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
    }
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  if (notFound) return <p className="muted">Record not found.</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const record = data.record;
  const type = allRecordTypes(projects).find((t) => t.id === record.recordTypeId);
  const fields: Field[] = type?.fields ?? [];
  const statuses = type?.workflow.statuses;
  const fieldLabel = (path: string) =>
    path.startsWith("custom.") ? (fields.find((f) => `custom.${f.key}` === path)?.label ?? path.slice(7)) : (BUILTIN_LABELS[path] ?? path);
  const viewSections = type?.layout.view.sections ?? [{ title: "Details", fields: ["priority", "assigneeId", "teamId", ...fields.map((f) => f.key)] }];

  function startEdit() {
    setDraft({ title: record.title, description: record.description, priority: record.priority, assigneeId: record.assigneeId, teamId: record.teamId, custom: { ...record.custom } });
    setErrors({});
    setEditing(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const custom: Record<string, unknown> = {};
    for (const f of fields) {
      const before = record.custom[f.key] ?? null;
      const after = draft.custom?.[f.key] ?? null;
      if (JSON.stringify(before) !== JSON.stringify(after)) custom[f.key] = after === "" ? null : after;
    }
    try {
      await api.patch(`/api/records/${record.id}`, {
        version: record.version,
        title: draft.title,
        description: draft.description,
        priority: draft.priority,
        assigneeId: draft.assigneeId ?? null,
        teamId: draft.teamId ?? null,
        custom,
      });
      setEditing(false);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "version_conflict") {
        setErrors({ _: "Someone else changed this record while you were editing. Reload to see their changes." });
      } else setErrors({ _: (err as Error).message, ...issuesByField(err) });
    }
  }

  async function quickAssign(userId: string | null) {
    await api.patch(`/api/records/${record.id}`, { version: record.version, assigneeId: userId });
    await load();
  }

  async function remove() {
    if (!window.confirm(`Move ${record.key} to the trash? An admin can restore it.`)) return;
    await api.delete(`/api/records/${record.id}`);
    navigate("/app");
  }

  async function runTransition(t: AvailableTransition) {
    const missing = t.requiredFields.filter((f) => {
      const v = ["description", "assigneeId", "teamId", "priority"].includes(f) ? (record as unknown as Record<string, unknown>)[f] : record.custom[f];
      return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
    });
    if (missing.length || t.needsApproval) {
      setPending(t);
      return;
    }
    try {
      await api.post(`/api/records/${record.key}/transitions`, { transition: t.key, version: record.version });
      await load();
    } catch (err) {
      setErrors({ _: (err as Error).message });
    }
  }

  async function toggleWatch() {
    await api.post(`/api/records/${record.key}/watchers`, { watching: !data!.watching });
    await load();
  }

  const pendingApproval = data.approvals.find((a) => a.status === "pending");

  return (
    <section className="detail">
      <div className="row between">
        <div>
          <p className="muted small">
            <Link to={`/app?projectId=${record.projectId}`}>{type?.project.name}</Link> · {type?.name} · {record.key}
            {record.via !== "app" && <span> · via {record.via}</span>}
          </p>
          <h1>{record.title}</h1>
          <div className="row">
            <StatusPill status={record.status} category={record.statusCategory} statuses={statuses} />
            <span className={`pill ${record.priority}`}>{record.priority}</span>
            {data.sla.map((c) => (
              <SlaBadge key={c.id} clock={c} />
            ))}
          </div>
        </div>
        <div className="row">
          <button className="subtle" onClick={toggleWatch} aria-pressed={data.watching}>
            {data.watching ? "Watching" : "Watch"}
          </button>
          {staff && !editing && (
            <>
              <button onClick={startEdit}>Edit</button>
              <button className="subtle danger" onClick={remove}>
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      {data.transitions.length > 0 && !editing && (
        <div className="transitions">
          {data.transitions.map((t) => (
            <button key={t.key} className={t.to === record.status ? "" : "primary-outline"} onClick={() => runTransition(t)}>
              {t.name}
              {t.needsApproval && <span className="small muted"> · needs approval</span>}
            </button>
          ))}
        </div>
      )}
      {pending && <TransitionPanel record={record} transition={pending} fields={fields} onDone={async () => { setPending(null); await load(); }} onCancel={() => setPending(null)} />}
      {pendingApproval && <ApprovalPanel approval={pendingApproval} onChange={load} />}
      <ErrorText error={!editing ? errors._ : null} />

      {editing ? (
        <form onSubmit={save} className="stack narrow">
          <label className="field">
            Title
            <input value={draft.title ?? ""} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </label>
          <label className="field">
            Description
            <textarea rows={5} value={draft.description ?? ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          <div className="row wrap">
            <label className="field">
              Priority
              <select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value as Priority })}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
            <label className="field">
              Assignee
              <select value={draft.assigneeId ?? ""} onChange={(e) => setDraft({ ...draft, assigneeId: e.target.value || null })}>
                <option value="">Unassigned</option>
                {people.filter((p) => p.role !== "requester").map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Team
              <select value={draft.teamId ?? ""} onChange={(e) => setDraft({ ...draft, teamId: e.target.value || null })}>
                <option value="">No team</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {fields.map((f) => (
            <FieldInput
              key={f.id}
              field={f}
              people={people}
              value={draft.custom?.[f.key] ?? null}
              error={errors[`custom.${f.key}`]}
              onChange={(v) => setDraft({ ...draft, custom: { ...draft.custom, [f.key]: v } })}
            />
          ))}
          <ErrorText error={errors._} />
          <div className="row">
            <button className="primary" type="submit">
              Save
            </button>
            <button className="subtle" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="columns">
          <div>
            <p className="prewrap">{record.description || <span className="muted">No description.</span>}</p>
            <Attachments recordKey={record.key} items={attachments} maxMb={settings.attachmentMaxMb} onChange={load} />
            <Comments recordKey={record.key} items={comments} staff={staff} requesterId={record.requesterId} onChange={load} />
          </div>
          <div className="stack">
            {viewSections.map((s, i) => (
              <dl className="props" key={i}>
                {s.title && <div className="props-title">{s.title}</div>}
                {s.fields.map((k) => {
                  if (k === "description") return null;
                  if (k === "priority")
                    return (
                      <div key={k} className="contents">
                        <dt>Priority</dt>
                        <dd>
                          <span className={`pill ${record.priority}`}>{record.priority}</span>
                        </dd>
                      </div>
                    );
                  if (k === "assigneeId")
                    return (
                      <div key={k} className="contents">
                        <dt>Assignee</dt>
                        <dd>
                          {record.assigneeName ?? "Unassigned"}
                          {staff && record.assigneeId !== me?.id && (
                            <button className="link small" onClick={() => quickAssign(me!.id)}>
                              Assign to me
                            </button>
                          )}
                        </dd>
                      </div>
                    );
                  if (k === "teamId")
                    return (
                      <div key={k} className="contents">
                        <dt>Team</dt>
                        <dd>{record.teamName ?? "None"}</dd>
                      </div>
                    );
                  const f = fields.find((x) => x.key === k);
                  if (!f) return null;
                  return (
                    <div key={k} className="contents">
                      <dt>{f.label}</dt>
                      <dd>{formatValue(f, record.custom[f.key], people)}</dd>
                    </div>
                  );
                })}
              </dl>
            ))}
            <dl className="props">
              <dt>Requester</dt>
              <dd>{record.requesterName ?? personName(people, record.requesterId)}</dd>
              <dt>Created</dt>
              <dd title={new Date(record.createdAt).toLocaleString()}>{timeAgo(record.createdAt)}</dd>
              {record.resolvedAt && (
                <>
                  <dt>Resolved</dt>
                  <dd title={new Date(record.resolvedAt).toLocaleString()}>{timeAgo(record.resolvedAt)}</dd>
                </>
              )}
            </dl>
            <Links recordKey={record.key} links={data.links} staff={staff} onChange={load} />
          </div>
        </div>
      )}

      <h2>History</h2>
      <ol className="timeline">
        {events.map((ev) => (
          <li key={ev.id}>
            <span className="muted small">{new Date(ev.createdAt).toLocaleString()}</span> <strong>{ev.actorName ?? (ev.kind.startsWith("automation") ? "Automation" : "System")}</strong>{" "}
            {ev.kind === "updated" || ev.kind === "reverted" ? (
              <>
                {ev.kind === "reverted" ? "reverted" : "changed"}{" "}
                {(ev.data.changes ?? []).map((c, i) => (
                  <span key={c.field}>
                    {i > 0 && ", "}
                    {fieldLabel(c.field)}
                    {staff && ev.kind === "updated" && (
                      <button
                        className="link small"
                        title="Undo this change"
                        onClick={async () => {
                          try {
                            await api.post(`/api/records/${record.key}/events/${ev.id}/revert`, { version: record.version, field: c.field });
                            await load();
                          } catch (err) {
                            setErrors({ _: (err as Error).message });
                          }
                        }}
                      >
                        undo
                      </button>
                    )}
                  </span>
                ))}
              </>
            ) : ev.kind === "transitioned" ? (
              <>
                moved it to <strong>{statuses?.find((s) => s.key === ev.data.to)?.name ?? String(ev.data.to)}</strong>
                {ev.data.approvalId ? " (approved)" : ""}
              </>
            ) : ev.kind === "approval_decided" ? (
              <>
                {String(ev.data.decision)} “{String(ev.data.name)}”
              </>
            ) : (
              (EVENT_TEXT[ev.kind] ?? ev.kind) + (ev.kind === "automation_ran" || ev.kind === "automation_failed" ? `: ${String(ev.data.rule)}` : "")
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function TransitionPanel({ record, transition, fields, onDone, onCancel }: { record: WorkRecord; transition: AvailableTransition; fields: Field[]; onDone: () => void; onCancel: () => void }) {
  const { people } = useSession();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [comment, setComment] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const needed = transition.requiredFields.filter((f) => {
    const v = ["description", "assigneeId", "teamId", "priority"].includes(f) ? (record as unknown as Record<string, unknown>)[f] : record.custom[f];
    return v === null || v === undefined || v === "";
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const custom: Record<string, unknown> = {};
    const builtin: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (["description", "assigneeId", "teamId", "priority"].includes(k)) builtin[k] = v;
      else custom[k] = v;
    }
    try {
      await api.post(`/api/records/${record.key}/transitions`, {
        transition: transition.key,
        version: record.version,
        ...(Object.keys(custom).length || Object.keys(builtin).length ? { fields: { ...builtin, ...(Object.keys(custom).length ? { custom } : {}) } } : {}),
        ...(comment.trim() ? { comment } : {}),
      });
      onDone();
    } catch (err) {
      setErrors({ _: (err as Error).message, ...issuesByField(err) });
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <h3>{transition.name}</h3>
      {transition.needsApproval && <p className="muted small">This step needs approval. Approvers are notified; the record moves once they agree.</p>}
      {needed.map((k) => {
        const f = fields.find((x) => x.key === k);
        if (f) return <FieldInput key={k} field={{ ...f, required: true }} people={people} value={values[k] ?? null} error={errors[`custom.${k}`]} onChange={(v) => setValues({ ...values, [k]: v })} />;
        if (k === "assigneeId")
          return (
            <label className="field" key={k}>
              Assignee *
              <select value={(values[k] as string) ?? ""} onChange={(e) => setValues({ ...values, [k]: e.target.value || null })}>
                <option value="">Choose…</option>
                {people.filter((p) => p.role !== "requester").map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </label>
          );
        return (
          <label className="field" key={k}>
            {BUILTIN_LABELS[k] ?? k} *
            <textarea rows={3} value={(values[k] as string) ?? ""} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
          </label>
        );
      })}
      <label className="field">
        Comment (optional, visible to the requester)
        <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      <ErrorText error={errors._} />
      <div className="row">
        <button className="primary" type="submit">
          {transition.needsApproval ? "Request approval" : transition.name}
        </button>
        <button className="subtle" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ApprovalPanel({ approval, onChange }: { approval: RecordDetailData["approvals"][number]; onChange: () => void }) {
  const { me, people } = useSession();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const step = approval.steps[approval.currentStep];
  const mine = !!me && step?.approvers.includes(me.id) && approval.requestedBy !== me.id;
  const canCancel = me && (approval.requestedBy === me.id || me.role === "admin");

  async function decide(decision: "approve" | "reject") {
    try {
      await api.post(`/api/approvals/${approval.id}/decision`, { decision, ...(note.trim() ? { comment: note } : {}) });
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="card approval">
      <strong>Waiting for approval: {approval.transitionName}</strong>
      <p className="muted small">
        Requested by {approval.requestedByName ?? "someone"} {timeAgo(approval.createdAt)}
        {approval.steps.length > 1 && ` · step ${approval.currentStep + 1} of ${approval.steps.length}`}
        {step && step.approvers.length > 0 && ` · ${approval.mode === "any" ? "any of" : ""} ${step.approvers.map((a) => personName(people, a)).join(", ")}`}
      </p>
      {mine && (
        <div className="stack">
          <textarea rows={2} placeholder="Note (optional, internal)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row">
            <button className="primary" onClick={() => decide("approve")}>
              Approve
            </button>
            <button className="danger" onClick={() => decide("reject")}>
              Reject
            </button>
          </div>
        </div>
      )}
      {canCancel && (
        <button
          className="link small"
          onClick={async () => {
            await api.post(`/api/approvals/${approval.id}/cancel`);
            onChange();
          }}
        >
          Withdraw request
        </button>
      )}
      <ErrorText error={error} />
    </div>
  );
}

function Comments({ recordKey, items, staff, requesterId, onChange }: { recordKey: string; items: Comment[]; staff: boolean; requesterId: string | null; onChange: () => void }) {
  const { me, people } = useSession();
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [mentions, setMentions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const mentionable = people.filter((p) => p.role !== "requester" || (!internal && p.id === requesterId));

  async function post(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    try {
      await api.post(`/api/records/${recordKey}/comments`, { body, internal, mentions });
      setBody("");
      setMentions([]);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <h2>Comments</h2>
      <ol className="comments">
        {items.map((c) => (
          <li key={c.id} className={c.internal ? "internal" : ""}>
            <div className="small">
              <strong>{c.authorName ?? "Automation"}</strong> <span className="muted">{timeAgo(c.createdAt)}</span>
              {c.internal && <span className="tag-mini">internal</span>}
              {c.via === "email" && <span className="tag-mini">email</span>}
              {c.editedAt && <span className="muted"> · edited</span>}
              {c.authorId === me?.id && editingId !== c.id && (
                <button className="link small" onClick={() => { setEditingId(c.id); setEditBody(c.body); }}>
                  edit
                </button>
              )}
              {(c.authorId === me?.id || me?.role === "admin") && (
                <button
                  className="link small"
                  onClick={async () => {
                    if (!window.confirm("Delete this comment? An admin can restore it from the trash.")) return;
                    await api.delete(`/api/comments/${c.id}`);
                    onChange();
                  }}
                >
                  delete
                </button>
              )}
            </div>
            {editingId === c.id ? (
              <div className="stack">
                <textarea rows={3} value={editBody} onChange={(e) => setEditBody(e.target.value)} />
                <div className="row">
                  <button className="primary small" onClick={async () => { await api.patch(`/api/comments/${c.id}`, { body: editBody }); setEditingId(null); onChange(); }}>
                    Save
                  </button>
                  <button className="subtle small" onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <p className="prewrap">{c.body}</p>
            )}
          </li>
        ))}
      </ol>
      <form onSubmit={post} className="stack composer">
        <textarea rows={3} placeholder={internal ? "Internal note: only staff can see this" : "Reply"} value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="row wrap">
          {staff && (
            <label className="inline">
              <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note
            </label>
          )}
          {staff && (
            <select
              value=""
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                setMentions((m) => [...new Set([...m, id])]);
                setBody((b) => `${b}${b && !b.endsWith(" ") ? " " : ""}@${personName(people, id)} `);
              }}
              aria-label="Mention someone"
            >
              <option value="">@ Mention…</option>
              {mentionable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          )}
          <div className="spacer" />
          <button className="primary" type="submit" disabled={!body.trim()}>
            {internal ? "Add note" : "Send reply"}
          </button>
        </div>
        <ErrorText error={error} />
      </form>
    </div>
  );
}

function Attachments({ recordKey, items, maxMb, onChange }: { recordKey: string; items: Attachment[]; maxMb: number; onChange: () => void }) {
  const { me } = useSession();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    setBusy(true);
    try {
      for (const f of [...files]) {
        if (f.size > maxMb * 1024 * 1024) throw new Error(`${f.name} is larger than ${maxMb} MB`);
        await api.upload(`/api/records/${recordKey}/attachments`, f);
      }
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="attachments">
      <div className="row between">
        <h2>Files</h2>
        <button className="subtle small" onClick={() => input.current?.click()} disabled={busy}>
          {busy ? "Uploading…" : "Attach files"}
        </button>
        <input ref={input} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
      </div>
      {items.length === 0 ? (
        <p className="muted small">No files.</p>
      ) : (
        <ul className="files">
          {items.map((a) => (
            <li key={a.id}>
              <a href={`/api/attachments/${a.id}`}>{a.filename}</a> <span className="muted small">{fmtBytes(a.sizeBytes)} · {a.uploadedByName ?? "email"} · {timeAgo(a.createdAt)}</span>
              {(a.uploadedBy === me?.id || me?.role !== "requester") && (
                <button
                  className="link small"
                  onClick={async () => {
                    if (!window.confirm(`Remove ${a.filename}? An admin can restore it from the trash.`)) return;
                    await api.delete(`/api/attachments/${a.id}`);
                    onChange();
                  }}
                >
                  remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={error} />
    </div>
  );
}

const LINK_LABEL: Record<string, [string, string]> = {
  relates: ["relates to", "relates to"],
  blocks: ["blocks", "is blocked by"],
  duplicates: ["duplicates", "is duplicated by"],
  parent: ["is parent of", "is child of"],
};

function Links({ recordKey, links, staff, onChange }: { recordKey: string; links: RecordDetailData["links"]; staff: boolean; onChange: () => void }) {
  const [to, setTo] = useState("");
  const [kind, setKind] = useState("relates");
  const [error, setError] = useState<string | null>(null);
  if (!staff && links.length === 0) return null;
  return (
    <div className="props links">
      <div className="props-title">Links</div>
      {links.length === 0 && <p className="muted small">No linked records.</p>}
      <ul>
        {links.map((l) => (
          <li key={l.id}>
            <span className="muted small">{LINK_LABEL[l.kind]![l.direction === "outward" ? 0 : 1]}</span> <Link to={`/app/records/${l.other.key}`}>{l.other.key}</Link> {l.other.title}
            {staff && (
              <button className="link small" aria-label="Remove link" onClick={async () => { await api.delete(`/api/links/${l.id}`); onChange(); }}>
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {staff && (
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await api.post(`/api/records/${recordKey}/links`, { to: to.trim(), kind });
              setTo("");
              onChange();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Link type">
            <option value="relates">relates to</option>
            <option value="blocks">blocks</option>
            <option value="duplicates">duplicates</option>
            <option value="parent">is parent of</option>
          </select>
          <input placeholder="Key, e.g. FIN-12" value={to} onChange={(e) => setTo(e.target.value)} required />
          <button type="submit">Link</button>
        </form>
      )}
      <ErrorText error={error} />
    </div>
  );
}
