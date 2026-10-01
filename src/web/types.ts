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

export interface RecordType {
  id: string;
  projectId: string;
  key: string;
  name: string;
  description: string;
  archivedAt: string | null;
  fields: Field[];
}

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
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
  statusCategory: "todo" | "in_progress" | "done";
  priority: Priority;
  assigneeId: string | null;
  requesterId: string | null;
  custom: Record<string, unknown>;
  version: number;
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
