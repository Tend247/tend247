// node --experimental-strip-types scripts/decrypt-export.ts <file.ndjson.gz[.enc]> [out.ndjson]
// Decode one nightly-export part (gunzip, and AES-GCM decrypt when it is .enc) with
// TEND247_BACKUP_ENCRYPTION_KEY from the environment or .env.
import { readFileSync, writeFileSync } from "node:fs";
import { decodeExportFile } from "../src/worker/backup/export.ts";
import { loadDotEnv } from "./lib/dotenv.ts";

loadDotEnv();
const [file, out] = process.argv.slice(2);
if (!file) {
  console.error("usage: scripts/decrypt-export.ts <file.ndjson.gz[.enc]> [out.ndjson]");
  process.exit(1);
}
const text = await decodeExportFile(new Uint8Array(readFileSync(file)), process.env.TEND247_BACKUP_ENCRYPTION_KEY || null);
if (out) writeFileSync(out, text);
else process.stdout.write(text);
