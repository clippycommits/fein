/**
 * Connector credentials, stored per-database in the settings table.
 *
 * The secret is WRITE-ONLY across the API surface: it can be set, used, and
 * deleted, but no endpoint ever returns it — status reports presence and a
 * masked hint only. It is stored in plain text in your local database, the
 * same trust level as the graph itself; treat the data directory accordingly
 * (an env var is still the better choice for shared or server deployments).
 */

const KEY_PREFIX = "connector:";

// Adding a CRM connector = one entry here (+ a card in app.js). Each module
// exposes verify(key) -> {workspace} and fetch({key, includeNotes}) -> docs.
// Everything registered here is a true API re-pull with idempotent ingest, so
// the scheduler may run it unattended. gog / Granola / Google stay CLI-only:
// they depend on local binaries, OAuth credential files, or OS cache paths the
// web server generally lacks — registering them needs a no-op verify plus a
// "binary/cache present" configured-check first.
export const CONNECTOR_PROVIDERS = {
  attio: {
    label: "Attio",
    envVar: "ATTIO_API_KEY",
    verify: async (key) => (await import("./ingest/attio.js")).verifyAttioKey(key),
    fetch: async ({ key, includeNotes }) => (await import("./ingest/attio.js")).fetchAttio({ key, includeNotes }),
  },
  affinity: {
    label: "Affinity",
    envVar: "AFFINITY_API_KEY",
    verify: async (key) => (await import("./ingest/affinity.js")).verifyAffinityKey(key),
    fetch: async ({ key, includeNotes }) => (await import("./ingest/affinity.js")).fetchAffinity({ key, includeNotes }),
  },
};

/**
 * Per-connector auto-sync interval, minutes. 0 = off (the default); anything
 * else must land between 5 minutes and 7 days — the scheduler ticks once a
 * minute, so a 5-minute floor keeps the granularity exact.
 */
export function clampSyncInterval(v) {
  const n = Number(v);
  if (n === 0) return 0;
  if (!Number.isFinite(n) || n < 5 || n > 10080) {
    throw new Error("syncIntervalMinutes must be 0 (off) or a number of minutes between 5 and 10080");
  }
  return n;
}

export async function getConnector(db, name) {
  const { rows } = await db.query(`select value from settings where key = $1`, [KEY_PREFIX + name]);
  if (!rows.length) return null;
  return typeof rows[0].value === "string" ? JSON.parse(rows[0].value) : rows[0].value;
}

export async function putConnector(db, name, patch) {
  const current = (await getConnector(db, name)) ?? {};
  const next = { ...current, ...patch };
  await db.query(
    `insert into settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = $2, updated_at = now()`,
    [KEY_PREFIX + name, JSON.stringify(next)]
  );
  return next;
}

export async function deleteConnector(db, name) {
  await db.query(`delete from settings where key = $1`, [KEY_PREFIX + name]);
}

/** Last 4 characters only — enough to tell two keys apart, useless if leaked. */
export function maskKey(key) {
  if (!key || key.length < 8) return "····";
  return "····" + key.slice(-4);
}

/**
 * The key in use: an explicitly stored one wins, else the environment. Lets
 * the dashboard and the CLI share one connector without duplicating config.
 */
export async function resolveConnectorKey(db, name, envVar) {
  const stored = await getConnector(db, name);
  if (stored?.apiKey) return { key: stored.apiKey, origin: "stored", config: stored };
  if (process.env[envVar]) return { key: process.env[envVar], origin: "env", config: stored ?? {} };
  return { key: null, origin: null, config: stored ?? {} };
}
