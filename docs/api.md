# API

Tend 24/7's web app uses the same JSON API that scripts and integrations call. This page covers API tokens, the endpoints a token can reach, and webhooks.

## Tokens

Create a token under **Your settings > API tokens** (admins and agents only). You choose:

- a **name**, so you can tell tokens apart later;
- its **scopes**;
- an **expiry**: 30 days, 90 days, a year, or never.

The token is shown **once**, so copy it then. It looks like `t247.<workspace id>.<secret>`; only a hash of the secret is stored.

A token acts as you. It has your role and sees exactly the records you can see, including your restricted projects, limited further by its scopes. It stops working when it expires, when it is revoked, or when your account is deactivated. Admins can see and revoke everyone's tokens.

Send it as a bearer token:

```bash
curl -s https://help.acme.com/api/records?status=new \
  -H "Authorization: Bearer $TEND247_TOKEN"
```

A request with an `Authorization` header never falls back to a browser session cookie: if the token is wrong, the answer is `401`.

| Scope | Allows |
| --- | --- |
| `records:read` | List, search and read records, their history, watchers, the board and the dashboard |
| `records:write` | Create, update, transition, delete records; bulk update; links |
| `comments:read` | Read comments and attachments |
| `comments:write` | Add comments and upload attachments |
| `config:read` | Read projects, record types, fields, workflows, people and teams |

Tokens cannot reach admin routes, notifications, approvals, saved views, other tokens, or phone pairing, whatever their scopes. Demo sandboxes allow read scopes only.

**Rate limit:** each token gets 300 requests per minute by default (the `API_RATE_LIMITER` binding in `wrangler.jsonc`). Past that the answer is `429`.

## Endpoints

All bodies are JSON (`Content-Type: application/json`). Ids are UUIDs; records also accept their key (`FIN-142`).

### Reading

| Method and path | Scope | Notes |
| --- | --- | --- |
| `GET /api/me` | any | Who the token acts as |
| `GET /api/config` | `config:read` | Projects, record types, fields, workflow and layout |
| `GET /api/users`, `GET /api/teams` | `config:read` | People and teams (staff tokens) |
| `GET /api/records` | `records:read` | Filters below; cursor pagination |
| `GET /api/records/:idOrKey` | `records:read` | The record, available transitions, SLA clocks, approvals, links |
| `GET /api/records/:idOrKey/events` | `records:read` | History |
| `GET /api/board` | `records:read` | Records grouped by workflow status |
| `GET /api/dashboard?days=30&projectId=` | `records:read` | Counts, aging, throughput, SLA attainment |
| `GET /api/records/:idOrKey/comments` | `comments:read` | Internal notes only for staff |
| `GET /api/records/:idOrKey/attachments`, `GET /api/attachments/:id` | `comments:read` | List; download (`?inline=1` to view) |
| `GET /api/projects/:id/backlog`, `/sprints`, `/velocity`; `GET /api/sprints/:id/report` | `records:read` | Agile projects ([agile.md](agile.md)) |

Filters for `GET /api/records`:

- `projectId`, `recordTypeId`, `assigneeId`, `teamId`, `requesterId`
- `status`, `statusCategory` (`todo`, `in_progress`, `done`) and `priority`, each taking comma-separated values
- `sla` (`breached`, `at_risk`)
- `createdAfter`, `createdBefore` (ISO dates)
- `q` (search titles, descriptions and comments)
- `custom` (JSON, for example `{"vendor":"Acme"}`)
- `sprintId` (`active`, `backlog` or an id) and `epicId` (`none` or an id), for agile projects
- `sort` (`created_desc`, `created_asc`, `updated_desc`, `priority_desc`, `key_asc`, `due_asc`, `rank_asc`), `limit` (up to 100) and `cursor` (from `nextCursor`)

### Writing

| Method and path | Scope | Body |
| --- | --- | --- |
| `POST /api/records` | `records:write` | `{ recordTypeId, title, description?, priority?, assigneeId?, requesterId?, teamId?, custom?, storyPoints?, epicId? }` |
| `PATCH /api/records/:idOrKey` | `records:write` | `{ version, ...fields }`; `version` must match (optimistic locking, `409` otherwise) |
| `POST /api/records/:idOrKey/transitions` | `records:write` | `{ transition, fields?, comment? }` |
| `POST /api/records/bulk` | `records:write` | `{ ids, patch?, transition? }` |
| `DELETE /api/records/:idOrKey` | `records:write` | Moves it to the trash |
| `POST /api/records/:idOrKey/links`, `DELETE /api/links/:id` | `records:write` | `{ to, kind }` with kind `relates`, `blocks`, `duplicates` or `parent` |
| `POST /api/records/:idOrKey/comments` | `comments:write` | `{ body, internal?, mentions? }` |
| `POST /api/records/:idOrKey/attachments` | `comments:write` | The raw file as the body. Headers: `X-Tend-Upload: 1`, `X-Filename` (URI-encoded), `Content-Type`, `Content-Length` |
| `POST /api/records/:idOrKey/plan` | `records:write` | `{ sprintId?, afterId?, beforeId? }`: plan into a sprint and/or rank |
| `POST /api/projects/:id/sprints`, `PATCH`/`DELETE /api/sprints/:id`, `POST /api/sprints/:id/start`, `/complete` | `records:write` | Sprint lifecycle ([agile.md](agile.md)) |

Records created with a token are marked `via: "api"`.

### Errors

Errors look like this:

```json
{ "error": { "code": "validation_failed", "message": "…", "details": { "issues": [{ "field": "custom.amount", "message": "…" }] } } }
```

| Code | Status |
| --- | --- |
| `bad_request` | 400 |
| `unauthenticated` | 401 |
| `forbidden` | 403 (`details.reason`: `token_scope`, `token_route` or `read_only`) |
| `not_found` | 404 |
| `conflict`, `version_conflict` | 409 |
| `unsupported_media_type` | 415 |
| `validation_failed` | 422 |
| `rate_limited` | 429 |

## Webhooks

Admins add endpoints under **Admin > Webhooks**. Each endpoint has:

- a URL, which must be `https` on a public host name;
- the events it receives;
- optionally, one project it is limited to.

**Events:**

- `record.created`, `record.updated`, `record.transitioned`, `record.deleted`, `record.restored`
- `comment.created`, `attachment.created`
- `approval.requested`, `approval.decided`
- `sla.warning`, `sla.breached`
- `sprint.started`, `sprint.completed` (with a `sprint` object instead of a `record`; `sprint.completed` adds `movedOut`)
- `ping` (sent by **Send test**)

Every delivery is a `POST` with this body:

```json
{
  "deliveryId": "…",
  "event": "record.transitioned",
  "eventId": "1842",
  "occurredAt": "2026-10-01T15:04:05.000Z",
  "actorId": "…",
  "record": { "id": "…", "key": "ITSD-42", "title": "…", "status": "resolved", "priority": "high", "custom": { … }, … },
  "from": "in_progress", "to": "resolved", "transition": "resolve"
}
```

- For an internal note, `comment.created` carries the comment's id and `internal: true`, but not its text. Likewise, an internal file's name is not sent.
- `record.updated` lists the changed `fields`.

**Headers:** `X-Tend-Event`, `X-Tend-Delivery` and `X-Tend-Signature: t=<unix seconds>,v1=<hex>`. The `v1` value is HMAC-SHA256 over `"<t>.<raw body>"`, keyed with the workspace's signing secret (shown on the Webhooks page, rotatable). Verify it, and reject old timestamps:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
function verify(secret, header, rawBody, toleranceSeconds = 300) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

**Responding:** answer with any `2xx` within 10 seconds.

**Retries:** after a failed attempt, the next waits 1, 5, 30, 120 and then 720 minutes, for six attempts in all. The delivery log shows every attempt. **Redeliver** sends any past delivery again to the endpoint's current URL.

Automation rules can also call a webhook as an action. Those deliveries use the same signing, retries and log.
