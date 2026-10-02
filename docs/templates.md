# Templates and the setup guide

A template is one project's whole setup as data: its record types, fields, workflow, forms, SLA targets, automation and default team. It never contains records, people or secrets. Templates come from three places:

- **Built-in templates**, which ship with Tend 24/7.
- **Your templates**: saved from one of your projects, built in the setup guide, or uploaded from a file.
- **Template files** (`.tend247-template.json`), downloaded from one workspace and uploaded to another.

All three use the same format and the same installer. Installing goes through the services an admin uses by hand, so the result is ordinary configuration: rename anything, add fields, change the workflow, and every change is versioned. A template installs completely or not at all.

## Built-in templates

| Template | Key | Types and fields | Workflow | Notes |
| --- | --- | --- | --- | --- |
| **HR Cases** | `HR` | HR case: Category, Site, Resolution | New → In review → Waiting on employee → Resolved | Restricted: only People Ops and the requester see a case. SLA: 8 h first response, 40 h resolution, on business hours |
| **IT Service Desk** | `ITSD` | Incident: Site, Asset tag, Resolution | New → In progress → Waiting on requester → Resolved | Round-robin assignment. SLA: urgent "line down" 30 min / 4 h around the clock; standard 4 h / 27 h on business hours |
| **IT Enhancements** | `ITE` | Change request: System, Business value, Target date | Proposed → Approved → In development → Shipped (or Declined) | "Approve" needs an approval and a business value |
| **AP Requests** | `FIN` | Invoice exception: Vendor, Invoice number, Amount, Reason | New → Investigating → Awaiting vendor → Approved for payment → Paid (or Voided) | Restricted to Accounts payable. "Approve payment" needs an approval and an amount. SLA pauses while waiting on the vendor |
| **Agile Software Team** | `APP` | Story, Bug (Severity required), Task, Epic | To do → In progress → In review → Done, any card to any column | Agile: sprints, backlog, story points, epics, burndown and velocity ([agile.md](agile.md)). Critical bugs alert the team |

Requesters can reopen resolved HR cases and IT incidents.

## The setup guide (no configuration language needed)

**Admin > Projects > Set up a new project** walks an admin through a new project in plain questions. Nothing is created until the last step.

1. **Start.** Begin from scratch (New, In progress, Done), from any built-in or saved template, or from a template file.
2. **Basics.** The name (the key is suggested from it), a one-line description, the team that handles it (a new team is created if the name is new), how work is handed out, who can see it, and whether the team plans in sprints.
3. **Types and fields.** Each type gets its own form. Add questions from a palette (short or long text, one or several choices, number, money, date, person, yes/no, web address), mark them required, add a hint, and reorder them. Agile projects can use the usual Story, Bug, Task and Epic types in one click.
4. **Steps.** The stages work goes through, each marked as not started, in progress or finished; they become the board's columns. Choose how items move: freely between any steps (good for boards) or in order (each step leads to the next, and work can be finished from any step). Then, for each step, whether moving there needs approval and which questions must be answered first. Every type can share the same steps.
5. **Targets.** Optional response and resolution targets in minutes, hours or days, by priority, counted around the clock or in working hours (a working day is 8 hours), and the steps that pause the clock.
6. **Review.** A plain summary, who approves, and a check that runs the real install and rolls it back, so any problem is listed in plain words with a link to the step that fixes it. Then **Create project**. Tick **Also save this setup as a template** to reuse it, or download it as a file.

A template with hand-made transitions (like IT Enhancements) keeps them in the guide; its steps, approvals and required answers stay editable.

## Save as template, download and upload

- **Save as template** is on every project's admin page. It records the project's configuration and tells you what was left out. Saved templates are listed under **Your templates** on the Projects page, with **Install**, **Download** and **Delete**.
- **Download** gives a `.tend247-template.json` file. **Upload a template file** on the Projects page adds one to your templates after checking that it would install.

What a template generalises or leaves out, so it works in any workspace:

| In the project | In the template |
| --- | --- |
| Approvers | `"$approvers"`, chosen at install (default: the admin installing) |
| The SLA calendar | `businessHours: true`, counted on the calendar chosen at install (default: a new Monday–Friday 9–5 **Business hours** calendar) |
| The default team | Its name. At install, a team with that name is used, or created |
| Automation that names a person (assign to Sam, notify Dana, set a field to someone, conditions on people) | Left out, with a warning |
| Webhook actions | Left out, with a warning. A template can never contain a webhook: their URLs can carry secrets, or send records somewhere the installing admin did not choose |
| Round-robin or "move to team" actions for the project's own team | `"$team"`, the installed project's team |
| "Create a linked record" in the same project | The record type's key |
| The inbound email address | Left out: set one after installing |

## Installing

Pick a template, keep its key or type another (keys are permanent, because they prefix every record number), then click **Install**. Then:

1. Add people to the team (**Admin > Teams**).
2. Adjust the calendar's holidays (**Admin > Calendars**).
3. Check approvers in the workflow editor.
4. If you use inbound email, give the project a queue address.

## API (admin sessions)

```http
GET    /api/admin/templates                      → { templates: [built-in summaries], saved: [your templates] }
GET    /api/admin/templates/builtin/:key         → { key, definition, summary }
GET    /api/admin/templates/saved/:id            → { id, name, definition, summary }
GET    /api/admin/templates/saved/:id/download   → the definition as a JSON file
DELETE /api/admin/templates/saved/:id
POST   /api/admin/templates/saved                { definition, name, summary?, replace?, source?: "wizard" | "file" }
POST   /api/admin/projects/:id/save-template     { name, summary?, replace? } → { template, warnings }
POST   /api/admin/templates/check                { definition, options? } → { ok, summary } or 422 with field paths
POST   /api/admin/templates/install              { definition, options? } → 201 { project, recordTypeId, recordTypeIds, teamId, calendarId }
POST   /api/admin/templates/:keyOrId/install     options → 201 (a built-in key or a saved template id)
```

`options`, and the body of `/:keyOrId/install`, are all optional: `{ "projectKey": "HR2", "projectName": "HR Cases (Plant 2)", "approverIds": ["…"], "teamId": "…", "calendarId": null }`. `calendarId: null` makes the SLA count every minute; `teamId: null` leaves the project without a default team. A saved name already in use answers 409 unless `replace` is true. A workspace keeps up to 100 saved templates.

## The format

```json
{
  "format": "tend247-template",
  "version": 1,
  "name": "Facilities requests",
  "summary": "Repairs around the plant.",
  "project": { "key": "FR", "name": "Facilities requests", "description": "", "restricted": false, "requesterAccess": true, "assignment": "manual", "agile": false },
  "team": "Maintenance",
  "recordTypes": [
    {
      "key": "repair", "name": "Repair", "isEpic": false,
      "fields": [{ "key": "location", "label": "Location", "type": "text", "required": true }],
      "workflow": {
        "initial": "new",
        "statuses": [{ "key": "new", "name": "New", "category": "todo" }, { "key": "done", "name": "Done", "category": "done" }],
        "transitions": [{ "key": "fix", "name": "Mark fixed", "from": ["new"], "to": "done", "requiredFields": ["location"], "approval": { "mode": "any", "approvers": ["$approvers"] } }]
      }
    }
  ],
  "sla": { "policies": [{ "name": "Standard", "priorities": [], "recordTypes": ["repair"], "firstResponseMinutes": 120, "resolutionMinutes": 2880, "businessHours": true }], "pauseStatuses": [] },
  "automation": []
}
```

The schema, with every limit, is `templateSchema` in `src/worker/templates/definition.ts`. Optional parts: `layout` per record type (create and view forms), `sla`, `automation`. Automation actions are those of automation rules, except that `create_linked` names its record type by `recordTypeKey`.

## Adding a built-in template

Built-in templates live in `src/worker/templates/catalog.ts` in this format. Add an entry; `test/templates-bundles.test.ts` installs every built-in template and `test/wizard-model.test.ts` round-trips each one through the setup guide. The Fernhollow Foods sample workspace (`npm run db:seed` and the public demo) is built from the built-in templates (`src/worker/demo/fernhollow.ts`).
