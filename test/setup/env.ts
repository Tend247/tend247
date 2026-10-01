// Connection strings for the disposable test database. CI overrides them via env vars.
export const OWNER_URL =
  process.env.TEND247_TEST_DB_OWNER_URL ?? "postgres://tend247_owner:owner_dev_pw@127.0.0.1:54329/tend247_test";
export const APP_URL =
  process.env.TEND247_TEST_DB_APP_URL ?? "postgres://tend247_app:app_dev_pw@127.0.0.1:54329/tend247_test";
export const APP_ROLE = process.env.TEND247_DB_APP_ROLE ?? "tend247_app";
/** Optional superuser URL, used only to prove the app refuses unsafe roles. */
export const SUPERUSER_URL = process.env.TEND247_TEST_DB_SUPERUSER_URL ?? "postgres://postgres@127.0.0.1:54329/tend247_test";
