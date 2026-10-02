export type ErrorCode =
  | "bad_request"
  | "validation_failed"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "version_conflict"
  | "unsupported_media_type"
  | "unsafe_database"
  | "rate_limited"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  version_conflict: 409,
  unsupported_media_type: 415,
  unsafe_database: 503,
  rate_limited: 429,
  internal: 500,
};

export interface FieldIssue {
  field: string;
  message: string;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: { issues?: FieldIssue[]; [key: string]: unknown };
  constructor(code: ErrorCode, message: string, details?: { issues?: FieldIssue[]; [key: string]: unknown }) {
    super(message);
    this.code = code;
    this.details = details;
    this.status = STATUS[code];
  }
}

export const notFound = (what: string) => new AppError("not_found", `${what} not found`);
export const forbidden = (message = "You do not have permission to do that") => new AppError("forbidden", message);
export const invalid = (issues: FieldIssue[], message = "Some values are not valid") =>
  new AppError("validation_failed", message, { issues });

/** Translate well-known Postgres errors into API errors. */
export function fromPostgres(err: unknown): AppError | null {
  const e = err as { code?: string; constraint_name?: string; detail?: string };
  switch (e?.code) {
    case "23505":
      return new AppError("conflict", "That value is already in use", { constraint: e.constraint_name });
    case "23503":
      return new AppError("bad_request", "A referenced item does not exist", { constraint: e.constraint_name });
    case "23514":
      return new AppError("bad_request", "A value is out of range or badly formatted", { constraint: e.constraint_name });
    case "22P02":
      return new AppError("bad_request", "Malformed identifier or value");
    case "42501":
      return new AppError("forbidden", "Not allowed");
    default:
      return null;
  }
}
