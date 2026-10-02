// Connection strings copied from a provider's dashboard (PlanetScale, Neon, Supabase, RDS…)
// are written for libpq, and can carry client-side settings postgres.js does not understand.
// postgres.js sends any query parameter it does not recognise to the server as a run-time
// setting, so `?sslrootcert=system` fails with "unrecognized configuration parameter". This
// turns such a URL into what postgres.js expects.

/** libpq client options with no meaning to the server; removed before connecting. */
const CLIENT_ONLY = new Set([
  "sslrootcert",
  "sslcert",
  "sslkey",
  "sslpassword",
  "sslcertmode",
  "sslcrl",
  "sslcrldir",
  "sslsni",
  "sslcompression",
  "ssl_min_protocol_version",
  "ssl_max_protocol_version",
  "requiressl",
  "gssencmode",
  "gsslib",
  "gssdelegation",
  "krbsrvname",
  "channel_binding",
  "require_auth",
  "passfile",
  "service",
  "hostaddr",
  "keepalives",
  "keepalives_idle",
  "keepalives_interval",
  "keepalives_count",
  "tcp_user_timeout",
  "load_balance_hosts",
]);

export interface NormalizedConnection {
  /** The URL with client-only options removed (and sslmode set where they implied one). */
  url: string;
  /** A CA certificate file named by `sslrootcert=<path>`, for the caller to read and trust. */
  caFile: string | null;
  /** Options that were removed, for a warning. */
  dropped: string[];
}

export function normalizeConnectionString(connectionString: string): NormalizedConnection {
  let u: URL;
  try {
    u = new URL(connectionString);
  } catch {
    return { url: connectionString, caFile: null, dropped: [] };
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return { url: connectionString, caFile: null, dropped: [] };
  const params = u.searchParams;
  const sslmode = params.get("sslmode");
  const rootcert = params.get("sslrootcert");
  let caFile: string | null = null;
  if (rootcert && sslmode !== "disable") {
    if (rootcert === "system") {
      // libpq: verify against the system's trusted CAs (and imply verify-full).
      // postgres.js: verify-full checks the certificate against Node's trusted CAs.
      if (!sslmode || sslmode === "require" || sslmode === "prefer" || sslmode === "allow") params.set("sslmode", "verify-full");
    } else {
      caFile = rootcert;
      if (!sslmode || sslmode === "prefer" || sslmode === "allow") params.set("sslmode", "verify-full");
    }
  }
  const dropped: string[] = [];
  for (const key of [...new Set(params.keys())]) {
    if (!CLIENT_ONLY.has(key.toLowerCase())) continue;
    params.delete(key);
    if (key.toLowerCase() !== "sslrootcert") dropped.push(key); // translated above, not lost
  }
  return { url: u.toString(), caFile, dropped };
}

/** Read a CA file named by sslrootcert (Node scripts only; the Worker connects through Hyperdrive). */
export function readCaFile(path: string): string {
  const fs = (globalThis as { process?: { getBuiltinModule?: (id: string) => { readFileSync: (p: string, e: string) => string } } }).process?.getBuiltinModule?.("node:fs");
  if (!fs) throw new Error(`sslrootcert=${path} can only be used from Node scripts`);
  return fs.readFileSync(path, "utf8");
}
