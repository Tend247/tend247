// Built-in starter templates, in the same format as a workspace's saved templates
// (definition.ts). Installing one goes through the same services an admin uses, so the result
// is ordinary configuration that can be renamed, extended or versioned like anything else.
import { templateSchema, summarize, type TemplateDefinition, type TemplateInput } from "./definition.ts";

const choices = (...labels: string[]) => ({
  choices: labels.map((l) => ({ value: l.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), label: l })),
});

const reopen = (to: string, from: string[]) => ({ key: "reopen", name: "Reopen", from, to, roles: ["admin", "agent", "requester"] as ("admin" | "agent" | "requester")[] });

const SITES = choices("Bottling line", "Sauce kitchen", "Warehouse", "Office");
const COMPONENTS = choices("Web", "Mobile app", "API", "Data");

/** A board-friendly workflow: any card can move to any column. */
const flow = (statuses: { key: string; name: string; category: "todo" | "in_progress" | "done" }[], names: Record<string, string>, assignOn?: string) => ({
  initial: statuses[0]!.key,
  statuses,
  transitions: statuses.map((s) => ({
    key: `to_${s.key}`,
    name: names[s.key] ?? s.name,
    from: [],
    to: s.key,
    ...(s.key === assignOn ? { actions: [{ type: "assign_self" as const }] } : {}),
  })),
});

const DEV_STATUSES = [
  { key: "todo", name: "To do", category: "todo" as const },
  { key: "in_progress", name: "In progress", category: "in_progress" as const },
  { key: "in_review", name: "In review", category: "in_progress" as const },
  { key: "done", name: "Done", category: "done" as const },
];
const DEV_FLOW = flow(DEV_STATUSES, { todo: "Back to to do", in_progress: "Start work", in_review: "Send to review", done: "Done" }, "in_progress");

const BUILTIN: { key: string; input: TemplateInput }[] = [
  {
    key: "hr_cases",
    input: {
      format: "tend247-template",
      version: 1,
      name: "HR Cases",
      summary: "Shift swaps, leave questions and policy requests, private to HR and the requester.",
      project: {
        key: "HR",
        name: "HR Cases",
        description: "Questions and requests for People Ops. Only HR and the person who asked can see a case.",
        restricted: true,
      },
      team: "People Ops",
      recordTypes: [
        {
          key: "hr_case",
          name: "HR case",
          description: "A question or request for HR.",
          fields: [
            { key: "category", label: "Category", type: "select", required: true, options: choices("Shift swap", "Leave", "Payroll", "Policy question") },
            { key: "site", label: "Site", type: "select", options: SITES },
            { key: "resolution", label: "Resolution", type: "long_text", helpText: "What was decided; the requester sees this." },
          ],
          workflow: {
            initial: "new",
            statuses: [
              { key: "new", name: "New", category: "todo" },
              { key: "in_review", name: "In review", category: "in_progress" },
              { key: "waiting_on_employee", name: "Waiting on employee", category: "in_progress" },
              { key: "resolved", name: "Resolved", category: "done" },
            ],
            transitions: [
              { key: "review", name: "Start review", from: ["new"], to: "in_review", actions: [{ type: "assign_self" }] },
              { key: "ask", name: "Ask the employee", from: ["in_review"], to: "waiting_on_employee" },
              { key: "resume", name: "Resume", from: ["waiting_on_employee"], to: "in_review" },
              { key: "resolve", name: "Resolve", from: ["in_review", "waiting_on_employee"], to: "resolved", requiredFields: ["resolution"] },
              reopen("in_review", ["resolved"]),
            ],
          },
          layout: {
            create: { sections: [{ title: "", fields: ["category", "site", "description"] }] },
            view: {
              sections: [
                { title: "Case", fields: ["category", "site", "priority"] },
                { title: "Handling", fields: ["assigneeId", "teamId", "resolution"] },
              ],
            },
            requiredOnCreate: ["description"],
          },
        },
      ],
      sla: {
        policies: [{ name: "HR standard", firstResponseMinutes: 480, resolutionMinutes: 2400, businessHours: true, warnPercent: 80 }],
        pauseStatuses: ["waiting_on_employee"],
      },
    },
  },
  {
    key: "it_service_desk",
    input: {
      format: "tend247-template",
      version: 1,
      name: "IT Service Desk",
      summary: "Break-fix requests from the plant floor and the office, with SLAs by priority.",
      project: {
        key: "ITSD",
        name: "IT Service Desk",
        description: "Something broken or not working? Tell the service desk.",
        assignment: "round_robin",
      },
      team: "Service desk",
      recordTypes: [
        {
          key: "incident",
          name: "Incident",
          description: "Something is broken or not working.",
          fields: [
            { key: "site", label: "Site", type: "select", required: true, options: SITES },
            { key: "asset_tag", label: "Asset tag", type: "text", helpText: "On the sticker, e.g. LP-0042." },
            { key: "resolution", label: "Resolution", type: "long_text" },
          ],
          workflow: {
            initial: "new",
            statuses: [
              { key: "new", name: "New", category: "todo" },
              { key: "in_progress", name: "In progress", category: "in_progress" },
              { key: "waiting_on_requester", name: "Waiting on requester", category: "in_progress" },
              { key: "resolved", name: "Resolved", category: "done" },
            ],
            transitions: [
              { key: "start", name: "Start work", from: ["new"], to: "in_progress", actions: [{ type: "assign_self" }] },
              { key: "ask", name: "Ask requester", from: ["in_progress"], to: "waiting_on_requester" },
              { key: "resume", name: "Resume", from: ["waiting_on_requester"], to: "in_progress" },
              { key: "resolve", name: "Resolve", from: ["new", "in_progress", "waiting_on_requester"], to: "resolved", requiredFields: ["resolution"] },
              reopen("in_progress", ["resolved"]),
            ],
          },
        },
      ],
      sla: {
        policies: [
          { name: "Line down", priorities: ["urgent"], firstResponseMinutes: 30, resolutionMinutes: 240, businessHours: false, warnPercent: 75 },
          { name: "Standard", firstResponseMinutes: 240, resolutionMinutes: 1620, businessHours: true, warnPercent: 80 },
        ],
        pauseStatuses: ["waiting_on_requester"],
      },
    },
  },
  {
    key: "it_enhancements",
    input: {
      format: "tend247-template",
      version: 1,
      name: "IT Enhancements",
      summary: "Change requests for internal systems, with approval before work starts.",
      project: {
        key: "ITE",
        name: "IT Enhancements",
        description: "Ideas and change requests for the systems we run. Each one is approved before work starts.",
      },
      team: "Product engineering",
      recordTypes: [
        {
          key: "change_request",
          name: "Change request",
          description: "A change to an internal system.",
          fields: [
            { key: "system", label: "System", type: "select", required: true, options: choices("Recipe system", "ERP", "Label printing", "Website") },
            { key: "business_value", label: "Business value", type: "long_text", helpText: "Who benefits, and how much time or money it saves." },
            { key: "target_date", label: "Target date", type: "date" },
          ],
          workflow: {
            initial: "proposed",
            statuses: [
              { key: "proposed", name: "Proposed", category: "todo" },
              { key: "approved", name: "Approved", category: "in_progress" },
              { key: "in_development", name: "In development", category: "in_progress" },
              { key: "shipped", name: "Shipped", category: "done" },
              { key: "declined", name: "Declined", category: "done" },
            ],
            transitions: [
              { key: "approve", name: "Approve", from: ["proposed"], to: "approved", requiredFields: ["business_value"], approval: { mode: "any", approvers: ["$approvers"] } },
              { key: "decline", name: "Decline", from: ["proposed"], to: "declined" },
              { key: "build", name: "Start development", from: ["approved"], to: "in_development", actions: [{ type: "assign_self" }] },
              { key: "ship", name: "Ship", from: ["in_development"], to: "shipped" },
            ],
          },
        },
      ],
    },
  },
  {
    key: "ap_requests",
    input: {
      format: "tend247-template",
      version: 1,
      name: "AP Requests",
      summary: "Invoice exceptions, vendor questions and payment holds for accounts payable.",
      project: {
        key: "FIN",
        name: "AP Requests",
        description: "Invoice exceptions and payment questions for accounts payable. Visible to the AP team only.",
        restricted: true,
      },
      team: "Accounts payable",
      recordTypes: [
        {
          key: "invoice_exception",
          name: "Invoice exception",
          description: "An invoice that cannot be paid as it stands.",
          fields: [
            { key: "vendor", label: "Vendor", type: "text", required: true },
            { key: "invoice_number", label: "Invoice number", type: "text" },
            { key: "amount", label: "Amount", type: "currency", options: { currency: "USD" } },
            { key: "reason", label: "Reason", type: "select", options: choices("Price mismatch", "Quantity mismatch", "Missing PO", "Duplicate") },
          ],
          workflow: {
            initial: "new",
            statuses: [
              { key: "new", name: "New", category: "todo" },
              { key: "investigating", name: "Investigating", category: "in_progress" },
              { key: "awaiting_vendor", name: "Awaiting vendor", category: "in_progress" },
              { key: "approved_for_payment", name: "Approved for payment", category: "in_progress" },
              { key: "paid", name: "Paid", category: "done" },
              { key: "voided", name: "Voided", category: "done" },
            ],
            transitions: [
              { key: "investigate", name: "Investigate", from: ["new"], to: "investigating", actions: [{ type: "assign_self" }] },
              { key: "wait_vendor", name: "Wait for vendor", from: ["investigating"], to: "awaiting_vendor" },
              { key: "resume", name: "Resume", from: ["awaiting_vendor"], to: "investigating" },
              {
                key: "approve_payment",
                name: "Approve payment",
                from: ["investigating"],
                to: "approved_for_payment",
                requiredFields: ["amount"],
                approval: { mode: "any", approvers: ["$approvers"] },
              },
              { key: "pay", name: "Mark paid", from: ["approved_for_payment"], to: "paid" },
              { key: "void", name: "Void", from: ["new", "investigating", "awaiting_vendor"], to: "voided" },
            ],
          },
          layout: {
            create: { sections: [{ title: "Invoice", fields: ["vendor", "invoice_number", "amount", "reason", "description"] }] },
            view: {
              sections: [
                { title: "Invoice", fields: ["vendor", "invoice_number", "amount", "reason"] },
                { title: "Handling", fields: ["priority", "assigneeId", "teamId"] },
              ],
            },
            requiredOnCreate: ["amount"],
          },
        },
      ],
      sla: {
        policies: [{ name: "AP standard", firstResponseMinutes: 540, resolutionMinutes: 2700, businessHours: true, warnPercent: 80 }],
        pauseStatuses: ["awaiting_vendor", "approved_for_payment"],
      },
    },
  },
  {
    key: "agile_team",
    input: {
      format: "tend247-template",
      version: 1,
      name: "Agile Software Team",
      summary: "Stories, bugs and tasks planned in sprints from a ranked backlog, with epics, story points and a burndown.",
      project: {
        key: "APP",
        name: "Product Development",
        description: "Planned in two-week sprints from a ranked backlog.",
        requesterAccess: false,
        agile: true,
      },
      team: "Product engineering",
      recordTypes: [
        {
          key: "story",
          name: "Story",
          description: "Something a user can do when it ships.",
          fields: [
            { key: "acceptance_criteria", label: "Acceptance criteria", type: "long_text", helpText: "How the team will know it is done." },
            { key: "component", label: "Component", type: "select", options: COMPONENTS },
          ],
          workflow: DEV_FLOW,
          layout: {
            create: { sections: [{ title: "", fields: ["description", "acceptance_criteria", "component", "priority"] }] },
            view: { sections: [{ title: "Details", fields: ["priority", "assigneeId", "component", "acceptance_criteria"] }] },
            requiredOnCreate: [],
          },
        },
        {
          key: "bug",
          name: "Bug",
          description: "Something that does not work as it should.",
          fields: [
            { key: "severity", label: "Severity", type: "select", required: true, options: choices("Minor", "Major", "Critical") },
            { key: "steps", label: "Steps to reproduce", type: "long_text" },
            { key: "component", label: "Component", type: "select", options: COMPONENTS },
          ],
          workflow: DEV_FLOW,
        },
        {
          key: "task",
          name: "Task",
          description: "Work that is not a user-facing change.",
          fields: [{ key: "component", label: "Component", type: "select", options: COMPONENTS }],
          workflow: DEV_FLOW,
        },
        {
          key: "epic",
          name: "Epic",
          description: "A larger outcome made of stories, bugs and tasks.",
          isEpic: true,
          fields: [{ key: "target_date", label: "Target date", type: "date" }],
          workflow: flow(
            [
              { key: "open", name: "Open", category: "todo" },
              { key: "in_progress", name: "In progress", category: "in_progress" },
              { key: "done", name: "Done", category: "done" },
            ],
            { open: "Reopen", in_progress: "Start", done: "Close" },
          ),
        },
      ],
      automation: [
        {
          name: "Critical bugs alert the team",
          trigger: "record.created",
          conditions: [{ field: "custom.severity", op: "eq", value: "critical" }],
          actions: [{ type: "notify", to: ["team"], message: "Critical bug: {{title}}" }],
        },
      ],
    },
  },
];

export interface BuiltinTemplate {
  key: string;
  definition: TemplateDefinition;
}

export const TEMPLATES: BuiltinTemplate[] = BUILTIN.map((b) => ({ key: b.key, definition: templateSchema.parse(b.input) }));

export function getTemplate(key: string): BuiltinTemplate | undefined {
  return TEMPLATES.find((t) => t.key === key);
}

/** What the template picker shows for the built-ins. */
export function templateSummaries() {
  return TEMPLATES.map((t) => ({ key: t.key, source: "builtin" as const, ...summarize(t.definition) }));
}
