// Object storage behind one small interface: Cloudflare R2 in the Worker, memory in tests.

export interface StoredBlob {
  body: ReadableStream<Uint8Array> | Uint8Array;
  size: number;
  contentType: string;
}

export interface BlobStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredBlob | null>;
  delete(key: string): Promise<void>;
  /** Keys under a prefix (backup retention). */
  list?(prefix: string): Promise<string[]>;
}

/** Minimal shape of an R2 bucket binding, so this file needs no Workers types. */
interface R2Like {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

export class R2BlobStore implements BlobStore {
  private readonly bucket: R2Like;
  constructor(bucket: unknown) {
    this.bucket = bucket as R2Like;
  }
  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.bucket.put(key, body, { httpMetadata: { contentType } });
  }
  async get(key: string): Promise<StoredBlob | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return { body: obj.body, size: obj.size, contentType: obj.httpMetadata?.contentType ?? "application/octet-stream" };
  }
  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor });
      keys.push(...page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }
}

export class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { body: body.slice(), contentType });
  }
  async get(key: string): Promise<StoredBlob | null> {
    const o = this.objects.get(key);
    return o ? { body: o.body, size: o.body.byteLength, contentType: o.contentType } : null;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
