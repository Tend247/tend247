import postgres from "postgres";

export type Sql = postgres.Sql<{}>;
export type Tx = postgres.TransactionSql<{}>;
export type Db = Sql | Tx;

/**
 * Create a client. In the Worker this is called per request with the Hyperdrive connection
 * string (Hyperdrive does the pooling); in Node scripts and tests it is created once.
 * Column NAMES come back camelCased. Deliberately not `postgres.camel`: that also rewrites
 * keys inside jsonb values, which would mangle custom-field keys such as `invoice_amount`.
 */
export function createSql(connectionString: string, options: { max?: number } = {}): Sql {
  return postgres(connectionString, {
    max: options.max ?? 5,
    fetch_types: false,
    prepare: true,
    onnotice: () => {},
    transform: { column: { from: postgres.toCamel, to: postgres.fromCamel } },
  });
}

/**
 * Run `fn` in a transaction scoped to one workspace. Hyperdrive pools connections per
 * transaction and resets them afterwards, so the workspace is set with a transaction-local
 * set_config — never a session-level SET — and row-level security does the rest.
 */
export async function withTenant<T>(sql: Sql, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  })) as T;
}
