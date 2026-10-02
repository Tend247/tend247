// Starter templates: a project with one record type, its fields, workflow, form layout, SLA
// policy and default team, ready to install in any workspace. Installing one goes through the
// same services an admin uses, so the result is ordinary configuration that can be renamed,
// extended or versioned like anything else.
//
// Two placeholders are filled in at install time:
//   "$approvers"  the people who approve gated transitions (default: the installing admin)
//   "$calendar"   the business-hours calendar SLA targets count (default: one is created)

export interface TemplateField {
  key: string;
  label: string;
  type: "text" | "long_text" | "number" | "currency" | "date" | "select" | "multi_select" | "user" | "checkbox" | "url";
  required?: boolean;
  options?: Record<string, unknown>;
  helpText?: string;
}

export interface TemplateTransition {
  key: string;
  name: string;
  from: string[];
  to: string;
  roles?: ("admin" | "agent" | "requester")[];
  requiredFields?: string[];
  approval?: { mode: "any" | "sequential"; approvers: ["$approvers"] };
  actions?: { type: "assign_self" | "unassign" }[];
}

export interface Template {
  key: string;
  name: string;
  /** One line for the template picker. */
  summary: string;
  project: { key: string; name: string; description: string; restricted: boolean; assignment: "manual" | "round_robin" };
  /** Created if the workspace has no team of this name, and made the project's default team. */
  team: string;
  recordType: { key: string; name: string; description: string };
  fields: TemplateField[];
  workflow: {
    initial: string;
    statuses: { key: string; name: string; category: "todo" | "in_progress" | "done" }[];
    transitions: TemplateTransition[];
  };
  layout?: {
    create: { sections: { title: string; fields: string[] }[] };
    view: { sections: { title: string; fields: string[] }[] };
    requiredOnCreate: string[];
  };
  sla?: {
    policies: {
      name: string;
      priorities: ("low" | "medium" | "high" | "urgent")[];
      firstResponseMinutes: number | null;
      resolutionMinutes: number | null;
      /** True: count business hours on "$calendar"; false: count every minute. */
      businessHours: boolean;
      warnPercent: number;
    }[];
    pauseStatuses: string[];
  };
  /** Suggested inbound address (local part); not set automatically. */
  suggestedAddress?: string;
}

const choices = (...labels: string[]) => ({
  choices: labels.map((l) => ({ value: l.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), label: l })),
});

const reopen = (to: string, from: string[]): TemplateTransition => ({
  key: "reopen",
  name: "Reopen",
  from,
  to,
  roles: ["admin", "agent", "requester"],
});

export const TEMPLATES: Template[] = [
  {
    key: "hr_cases",
    name: "HR Cases",
    summary: "Shift swaps, leave questions and policy requests, private to HR and the requester.",
    project: {
      key: "HR",
      name: "HR Cases",
      description: "Questions and requests for People Ops. Only HR and the person who asked can see a case.",
      restricted: true,
      assignment: "manual",
    },
    team: "People Ops",
    recordType: { key: "hr_case", name: "HR case", description: "A question or request for HR." },
    fields: [
      { key: "category", label: "Category", type: "select", required: true, options: choices("Shift swap", "Leave", "Payroll", "Policy question") },
      { key: "site", label: "Site", type: "select", options: choices("Bottling line", "Sauce kitchen", "Warehouse", "Office") },
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
    sla: {
      policies: [{ name: "HR standard", priorities: [], firstResponseMinutes: 480, resolutionMinutes: 2400, businessHours: true, warnPercent: 80 }],
      pauseStatuses: ["waiting_on_employee"],
    },
    suggestedAddress: "people",
  },
  {
    key: "it_service_desk",
    name: "IT Service Desk",
    summary: "Break-fix requests from the plant floor and the office, with SLAs by priority.",
    project: {
      key: "ITSD",
      name: "IT Service Desk",
      description: "Something broken or not working? Tell the service desk.",
      restricted: false,
      assignment: "round_robin",
    },
    team: "Service desk",
    recordType: { key: "incident", name: "Incident", description: "Something is broken or not working." },
    fields: [
      { key: "site", label: "Site", type: "select", required: true, options: choices("Bottling line", "Sauce kitchen", "Warehouse", "Office") },
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
    sla: {
      policies: [
        { name: "Line down", priorities: ["urgent"], firstResponseMinutes: 30, resolutionMinutes: 240, businessHours: false, warnPercent: 75 },
        { name: "Standard", priorities: [], firstResponseMinutes: 240, resolutionMinutes: 1620, businessHours: true, warnPercent: 80 },
      ],
      pauseStatuses: ["waiting_on_requester"],
    },
    suggestedAddress: "it",
  },
  {
    key: "it_enhancements",
    name: "IT Enhancements",
    summary: "Change requests for internal systems, with approval before work starts.",
    project: {
      key: "ITE",
      name: "IT Enhancements",
      description: "Ideas and change requests for the systems we run. Each one is approved before work starts.",
      restricted: false,
      assignment: "manual",
    },
    team: "Product engineering",
    recordType: { key: "change_request", name: "Change request", description: "A change to an internal system." },
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
        {
          key: "approve",
          name: "Approve",
          from: ["proposed"],
          to: "approved",
          requiredFields: ["business_value"],
          approval: { mode: "any", approvers: ["$approvers"] },
        },
        { key: "decline", name: "Decline", from: ["proposed"], to: "declined" },
        { key: "build", name: "Start development", from: ["approved"], to: "in_development", actions: [{ type: "assign_self" }] },
        { key: "ship", name: "Ship", from: ["in_development"], to: "shipped" },
      ],
    },
  },
  {
    key: "ap_requests",
    name: "AP Requests",
    summary: "Invoice exceptions, vendor questions and payment holds for accounts payable.",
    project: {
      key: "FIN",
      name: "AP Requests",
      description: "Invoice exceptions and payment questions for accounts payable. Visible to the AP team only.",
      restricted: true,
      assignment: "manual",
    },
    team: "Accounts payable",
    recordType: { key: "invoice_exception", name: "Invoice exception", description: "An invoice that cannot be paid as it stands." },
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
    sla: {
      policies: [{ name: "AP standard", priorities: [], firstResponseMinutes: 540, resolutionMinutes: 2700, businessHours: true, warnPercent: 80 }],
      pauseStatuses: ["awaiting_vendor", "approved_for_payment"],
    },
    suggestedAddress: "ap",
  },
];

export function getTemplate(key: string): Template | undefined {
  return TEMPLATES.find((t) => t.key === key);
}

/** What the template picker shows. */
export function templateSummaries() {
  return TEMPLATES.map((t) => ({
    key: t.key,
    name: t.name,
    summary: t.summary,
    projectKey: t.project.key,
    restricted: t.project.restricted,
    recordType: t.recordType.name,
    fields: t.fields.map((f) => f.label),
    statuses: t.workflow.statuses.map((s) => s.name),
    approvals: t.workflow.transitions.some((tr) => tr.approval),
    sla: Boolean(t.sla),
  }));
}
