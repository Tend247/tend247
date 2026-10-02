# Admin guide

Everything here is under **Admin**, which only admins see.

## People and roles

| Role | Can |
| --- | --- |
| **Admin** | Everything, including configuration, the trash, the audit log and every restricted project |
| **Agent** | Work records in open projects, and in restricted projects for the teams they belong to; create API tokens |
| **Requester** | Use the portal: ask for help, follow their own requests, reply, attach files, reopen |

Ways to add people:

- **Admin > People**, one at a time;
- **Admin > Import** from a CSV (columns `email`, `name`, `role`, `teams`);
- **automatically on first sign-in**:
  - with SSO, set `TEND247_OIDC_AUTO_PROVISION` and the allowed domains;
  - for requesters, put their email domain in `TEND247_REQUESTER_DOMAINS`.

Deactivate people rather than deleting them: their history stays, and their sessions and tokens stop working at once.

## Projects, fields, workflows and forms

A **project** is a queue with a permanent key (`FIN`), a default team and an assignment mode (manual or round-robin).

- **Restricted** projects (HR, finance) are visible only to their teams, the assignee and the requester.
- **Requester access** controls whether a project appears in the portal.

Each project has one or more **record types**. Each record type has:

- **fields**: ten types, from text to user pickers;
- a **workflow**: statuses in three categories, and transitions guarded by role, required fields and optional approval;
- a **layout**: the create and view forms. The create form is also what requesters can fill in.

Workflows, layouts and SLA policies are **versioned**:

1. Edit a draft.
2. Publish it.
3. Restore any earlier version if needed.

When a new workflow version removes statuses that records still use, you map them to new ones as part of publishing.

The fastest start is a **starter template** ([templates.md](templates.md)).

## Teams, SLAs and calendars

- **Teams** own queues and receive round-robin assignments.
- **Calendars** define business hours (IANA time zone, weekly hours, holidays).
- **SLA policies** (per project, on the project page) set first-response and resolution targets by priority and record type. They count business hours on a calendar or every minute, and pause in chosen statuses. People are warned before a breach and notified at it.

## Automation

**Admin > Automation**: rules on record, comment, SLA and approval events, with conditions and actions:

- set a field, assign, set team, transition;
- notify, comment;
- create a linked record;
- call a webhook.

Chains stop at three levels, and a rule never re-triggers itself.

## Webhooks and API tokens

- **Admin > Webhooks**: endpoints, signing secret, delivery log, redeliver ([api.md](api.md#webhooks)).
- **API tokens**: each person manages their own under **Your settings**. Admins can list and revoke everyone's from the same page ("Show everyone's tokens").

## Import

**Admin > Import** loads people or records from CSV. Every import is a dry run first: you see what would be created and which rows have problems before anything is saved.

For records:

- Columns match fields by key or label.
- Choices match by label or value.
- People are matched by email.
- Imported records start in the workflow's first status and are marked "via import".
- Nobody is notified about the import.

The limit is 2,000 rows per import.

## Phone access

Anyone can link their phone under **Your settings > Phone access**:

1. Scan the QR code with the phone.
2. Check that the device, browser and two-digit number the computer shows match the phone.
3. Approve.

The phone gets **read-only** access for 4 hours as the same person: its queue, records, comments, approvals waiting and notifications. It cannot change anything; the server enforces that on every route.

Linked devices are listed on the same page and can be revoked at once. The audit log records every request, claim, approval, link and revoke.

## Dashboard

**Dashboard** (admins and agents) shows:

- open work by status, priority and project;
- how long open work has waited;
- records created and resolved per day;
- SLA attainment;
- workload per person.

It covers the last 7, 30 or 90 days, for all projects or one. Agents see only what they could open.

## Settings, trash, audit, backups

- **Admin > Settings**:
  - the workspace's time zone, trash retention and largest attachment;
  - the email setup;
  - nightly export health;
  - **Export this workspace** (a bundle you can import elsewhere, see [restore.md](restore.md)).
- **Trash**: restore or purge records, comments and files.
- **Audit log**: every configuration change, token, import, export and phone link, append-only.
