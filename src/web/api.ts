export interface Issue {
  field: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: Issue[];
  readonly details: Record<string, unknown>;
  constructor(status: number, code: string, message: string, issues: Issue[] = [], details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.details = details;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(res.status, e.code ?? "error", e.message ?? res.statusText, e.details?.issues ?? [], e.details ?? {});
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
  /** Upload one file as the raw body (the server requires the X-Tend-Upload header). */
  async upload<T>(path: string, file: File): Promise<T> {
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-tend-upload": "1",
        "x-filename": encodeURIComponent(file.name),
      },
      body: file,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const e = json?.error ?? {};
      throw new ApiError(res.status, e.code ?? "error", e.message ?? res.statusText, e.details?.issues ?? [], e.details ?? {});
    }
    return json as T;
  },
};

export function issuesByField(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  return Object.fromEntries(err.issues.map((i) => [i.field, i.message]));
}
