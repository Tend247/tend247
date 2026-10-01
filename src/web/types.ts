// Shapes of the JSON the API returns (dates arrive as ISO strings).

export type Role = "admin" | "agent" | "requester";
export type FieldType =
  | "text"
  | "long_text"
  | "number"
  | "currency"
  | "date"
  | "select"
  | "multi_select"
  | "user"
  | "checkbox"
  | "url";

export interface Me {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  workspaceId: string;
}

export interface Choice {
  value: string;
  label: string;
}

export interface Field {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: { maxLength?: number; min?: number; max?: number; integer?: boolean; currency?: string; choices?: Choice[] };
  defaultValue: unknown;
  helpText: string;
  position: number;
  archivedAt: string | null;
}

export type Category = "todo" | "in_progress" | "done";

export interface WorkflowStatus {
  key: string;
  name: string;
  category: Category;
}

export type WorkflowAction = { type: "assign_self" } | { type: "unassign" } | { type: "set_field"; field: string; value: unknown };

export interface WorkflowTransition {
  key: string;
  name: string;
  from: string[];
  to: string;
  roles: Role[];
  requiredFields: string[];
  approval?: { mode: "any" | "sequential"; approvers: string[] };
  actions: WorkflowAction[];
}

export interface Workflow {
  initial: string;
  statuses: WorkflowStatus[];
  transitions: WorkflowTransition[];
}

export interface LayoutSection {
  title: string;
  fields: string[];
}

export interface Layout {
  create: { sections: LayoutSection[] };
  view: { sections: LayoutSection[] };
  requiredOnCreate: string[];
}

export interface RecordType {
  id: string;
  projectId: string;
  key: string;
  name: string;
  description: string;
  archivedAt: string | null;
  fields: Field[];
  workflow: Workflow;
  layout: Layout;
}

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  restricted: boolean;
  requesterAccess: boolean;
  assignment: "manual" | "round_robin";
  defaultTeamId: string | null;
  inbound: { address: string; recordTypeId: string } | null;
  archivedAt: string | null;
  recordTypes: RecordType[];
}

export interface Person {
  id: string;
  displayName: string;
  email: string;
  role: Role;
  active?: boolean;
}

export interface Team {
  id: string;
  name: string;
  archivedAt: string | null;
  members: { id: string; displayName: string; email: string; role: Role; active: boolean }[];
}

export type Priority = "low" | "medium" | "high" | "urgent";

export interface WorkRecord {
  id: string;
  key: string;
  number: number;
  projectId: string;
  recordTypeId: string;
  title: string;
  description: string;
  status: string;
  statusCategory: Category;
  priority: Priority;
  assigneeId: string | null;
  assigneeName: string | null;
  requesterId: string | null;
  requesterName: string | null;
  teamId: string | null;
  teamName: string | null;
  custom: Record<string, unknown>;
  version: number;
  pendingApprovalId: string | null;
  firstRespondedAt: string | null;
  resolvedAt: string | null;
  via: "app" | "email" | "automation" | "api";
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface RecordEvent {
  id: string;
  kind: string;
  data: { changes?: { field: string; from: unknown; to: unknown }[]; [k: string]: unknown };
  actorId: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface AvailableTransition {
  key: string;
  name: string;
  to: string;
  requiredFields: string[];
  needsApproval: boolean;
}

export interface SlaClock {
  id: string;
  metric: "first_response" | "resolution";
  policyName: string;
  targetMinutes: number;
  status: "running" | "paused" | "met" | "cancelled";
  dueAt: string | null;
  warnAt: string | null;
  warnedAt: string | null;
  breachedAt: string | null;
  metAt: string | null;
  consumedMinutes: number;
}

export interface Approval {
  id: string;
  recordId: string;
  transitionKey: string;
  transitionName: string;
  toStatus: string;
  requestedBy: string | null;
  requestedByName: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  mode: "any" | "sequential";
  steps: { approvers: string[]; decision?: "approved" | "rejected"; decidedBy?: string; decidedAt?: string }[];
  currentStep: number;
  createdAt: string;
  decidedAt: string | null;
  recordKey?: string;
  recordTitle?: string;
}

export interface RecordLink {
  id: string;
  kind: "relates" | "blocks" | "duplicates" | "parent";
  direction: "outward" | "inward";
  other: { id: string; key: string; title: string; status: string; statusCategory: Category };
}

export interface RecordDetailData {
  record: WorkRecord;
  transitions: AvailableTransition[];
  sla: SlaClock[];
  approvals: Approval[];
  links: RecordLink[];
  watching: boolean;
}

export interface Comment {
  id: string;
  recordId: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  internal: boolean;
  mentions: string[];
  via: "app" | "email" | "automation";
  createdAt: string;
  editedAt: string | null;
  recordKey?: string;
  deletedAt?: string | null;
}

export interface Attachment {
  id: string;
  recordId: string;
  commentId: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  uploadedByName: string | null;
  createdAt: string;
  recordKey?: string;
  deletedAt?: string | null;
}

export interface SavedView {
  id: string;
  ownerId: string;
  ownerName: string | null;
  name: string;
  shared: boolean;
  definition: { filters: Record<string, string | string[]>; sort?: string; mode: "list" | "board" };
}

export interface Notification {
  id: string;
  kind: string;
  recordId: string | null;
  recordKey: string | null;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface ConfigVersion<D = unknown> {
  id: string;
  version: number;
  state: "draft" | "published" | "superseded";
  definition: D;
  createdByName?: string | null;
  createdAt: string;
  publishedAt: string | null;
}

export interface ConfigBundle<D = unknown> {
  published: ConfigVersion<D> | null;
  draft: ConfigVersion<D> | null;
  effective: D | null;
  versions: Omit<ConfigVersion<D>, "definition">[];
}
