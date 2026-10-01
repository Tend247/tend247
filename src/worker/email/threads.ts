// Reply-to addresses: reply+<16-character code>@<inbound domain>. The code is random and maps
// to one record in the email_threads routing table, so a reply lands on the right record
// without exposing record ids or keys in the address.
import type { Tx } from "../db/client.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function newThreadCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => ALPHABET[b & 31]).join("");
}

export async function threadAddress(tx: Tx, tenantId: string, recordId: string, domain: string): Promise<string> {
  const [existing] = await tx<{ code: string }[]>`select code from email_threads where record_id = ${recordId}`;
  let code = existing?.code;
  if (!code) {
    const [row] = await tx<{ code: string }[]>`
      insert into email_threads (code, tenant_id, record_id) values (${newThreadCode()}, ${tenantId}, ${recordId})
      on conflict (record_id) do update set record_id = excluded.record_id
      returning code`;
    code = row!.code;
  }
  return `reply+${code}@${domain}`;
}
