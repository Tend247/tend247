# Starter templates

Four templates ship with 1.0, under **Admin > Projects > Start from a template**. Each one is a complete, working queue:

- a project and one record type;
- fields;
- a workflow (with an approval step where it makes sense);
- a form layout;
- an SLA policy;
- a default team.

Installing a template goes through the same services an admin uses by hand. The result is ordinary configuration: rename anything, add fields, change the workflow, and every change is versioned like any other.

| Template | Key | Fields | Workflow | Notes |
| --- | --- | --- | --- | --- |
| **HR Cases** | `HR` | Category, Site, Resolution | New → In review → Waiting on employee → Resolved | Restricted: only People Ops and the requester see a case. SLA: 8 h first response, 40 h resolution, on business hours |
| **IT Service Desk** | `ITSD` | Site, Asset tag, Resolution | New → In progress → Waiting on requester → Resolved | Round-robin assignment. SLA: urgent "line down" 30 min / 4 h around the clock; standard 4 h / 27 h on business hours |
| **IT Enhancements** | `ITE` | System, Business value, Target date | Proposed → Approved → In development → Shipped (or Declined) | "Approve" needs an approval and a business value |
| **AP Requests** | `FIN` | Vendor, Invoice number, Amount, Reason | New → Investigating → Awaiting vendor → Approved for payment → Paid (or Voided) | Restricted to Accounts payable. "Approve payment" needs an approval and an amount. SLA pauses while waiting on the vendor |

Requesters can reopen resolved HR cases and IT incidents.

## Installing

Pick a template and keep its key or type another one (keys are permanent, because they prefix every record number), then click **Install**. The installer:

- creates the team named in the template if the workspace doesn't have one, and makes it the default team;
- creates a **Business hours** calendar (Monday to Friday, 09:00 to 17:00 in the workspace time zone) if the template's SLA counts business hours and you don't have one;
- makes **you** the approver for approval steps. Change approvers in the workflow editor.

Then:

1. Add people to the team (**Admin > Teams**).
2. Adjust the calendar's holidays (**Admin > Calendars**).
3. If you use inbound email, give the project a queue address. The suggested addresses are `people`, `it` and `ap`.

Through the API, an admin session can call:

```http
GET  /api/admin/templates
POST /api/admin/templates/:key/install
     { "projectKey": "HR2", "projectName": "HR Cases (Plant 2)", "approverIds": ["…"], "teamId": "…", "calendarId": null }
```

Every body field is optional. `calendarId: null` makes the SLA count every minute; `teamId: null` leaves the project without a default team.

## Writing a template

Templates live in `src/worker/templates/catalog.ts` as plain data. Two placeholders are filled in at install time:

- `"$approvers"` in a transition's `approval.approvers`;
- business-hours SLA policies (`businessHours: true`), which get the chosen calendar.

Add an entry to `TEMPLATES`, and `test/templates-bundles.test.ts` installs it with every other template. The Fernhollow Foods sample workspace (`npm run db:seed` and the public demo) is built from these same four templates (`src/worker/demo/fernhollow.ts`).
