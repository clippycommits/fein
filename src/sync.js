/**
 * Connector sync — the one code path every pull goes through, manual
 * (dashboard, CLI) or scheduled, plus the scheduler itself.
 *
 * All schedule state rides in the connector's existing config blob:
 * syncIntervalMinutes (0 = off), lastAttemptAt, consecutiveFailures, and
 * lastRun. lastSyncAt / lastDocCount keep meaning "last success" — a failed
 * run never touches them. Dueness is measured from the last ATTEMPT, not the
 * last success, so a failing connector spaces out (exponential backoff)
 * instead of retrying every tick.
 */

import { CONNECTOR_PROVIDERS, resolveConnectorKey, putConnector } from "./connectors.js";
import { ingestDocs } from "./ingest/index.js";
import { resolveMentions } from "./resolve/pipeline.js";
import { rebuildEdges } from "./graph/edges.js";
import { audit } from "./settings.js";

let syncingConnector = null; // provider name — one sync at a time, they share resolve + edge rebuilds
export const syncingProvider = () => syncingConnector;

function withStatus(err, code) {
  err.statusCode = code;
  return err;
}

/**
 * Pull the provider's workspace, ingest, resolve, rebuild edges, and record
 * the outcome in the connector blob + audit trail — success and failure
 * alike. Throws 409 when another sync holds the single-flight claim, 400 when
 * no key is configured; provider errors are recorded first, then rethrown.
 */
export async function runConnectorSync(db, provider, { actor = "local", trigger = "manual", now = () => new Date() } = {}) {
  const { label, envVar } = CONNECTOR_PROVIDERS[provider];
  if (syncingConnector) {
    throw withStatus(new Error(`a ${CONNECTOR_PROVIDERS[syncingConnector].label} sync is already running`), 409);
  }
  syncingConnector = provider; // claim BEFORE the first await — the check-and-set must be atomic
  const t0 = Date.now();
  try {
    const { key, config } = await resolveConnectorKey(db, provider, envVar);
    if (!key) throw withStatus(new Error(`connect an ${label} API key first`), 400);
    try {
      const docs = await CONNECTOR_PROVIDERS[provider].fetch({ key, includeNotes: config.includeNotes !== false });
      const ingested = await ingestDocs(db, docs);
      const resolved = await resolveMentions(db);
      const edges = await rebuildEdges(db);
      const iso = now().toISOString();
      // Bookkeeping is wrapped so it can never mask a real result or error.
      await putConnector(db, provider, {
        lastSyncAt: iso,
        lastDocCount: ingested.docCount,
        lastAttemptAt: iso,
        consecutiveFailures: 0,
        lastRun: {
          at: iso, ok: true, trigger, durationMs: Date.now() - t0,
          docCount: ingested.docCount, mentionCount: ingested.mentionCount,
          resolved: resolved.attached + resolved.created, queued: resolved.queued,
        },
      }).catch(() => {});
      await audit(db, "ingest", { file: `${provider} workspace`, trigger, ...ingested }, actor).catch(() => {});
      return { ingested, resolved, edges };
    } catch (err) {
      const iso = now().toISOString();
      const error = String(err.message).slice(0, 300);
      await putConnector(db, provider, {
        lastAttemptAt: iso,
        consecutiveFailures: (config.consecutiveFailures ?? 0) + 1,
        lastRun: { at: iso, ok: false, trigger, durationMs: Date.now() - t0, error },
      }).catch(() => {});
      await audit(db, "sync_failed", { connector: provider, trigger, error }, actor).catch(() => {});
      throw err;
    }
  } finally {
    syncingConnector = null;
  }
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * When the next run is due, epoch ms — null when auto-sync is off. Pure.
 * Never attempted -> due now. Each consecutive failure doubles the spacing
 * (capped at 16x and, beyond the configured interval itself, at 24h); success
 * zeroes the count, so the backoff resets automatically.
 */
export function nextDueAt(config, tickNow = Date.now()) {
  if (!(Number(config?.syncIntervalMinutes) > 0)) return null;
  const base = config.lastAttemptAt ?? config.lastSyncAt ?? null;
  if (!base) return tickNow;
  const intervalMs = Number(config.syncIntervalMinutes) * 60_000;
  const backoff = 2 ** Math.min(config.consecutiveFailures ?? 0, 4);
  const effectiveMs = Math.min(intervalMs * backoff, Math.max(intervalMs, DAY_MS));
  return new Date(base).getTime() + effectiveMs;
}

/**
 * One scheduler pass: run every registered connector that is configured,
 * armed, and due. Sequential — providers share resolve + edge rebuilds, the
 * same reason manual syncs are single-flight. A tick never throws; a failed
 * run is already persisted + audited by runConnectorSync, so it only logs.
 */
export async function schedulerTick(db, { now = Date.now } = {}) {
  const ran = [];
  const skipped = [];
  for (const [provider, { envVar }] of Object.entries(CONNECTOR_PROVIDERS)) {
    // Key + interval re-checked every tick, so disconnecting or setting the
    // interval to 0 stops the schedule immediately.
    const { key, config } = await resolveConnectorKey(db, provider, envVar);
    if (!key || !(Number(config.syncIntervalMinutes) > 0) ||
        syncingConnector || now() < nextDueAt(config, now())) {
      skipped.push(provider);
      continue;
    }
    await runConnectorSync(db, provider, { actor: "scheduler", trigger: "scheduled", now: () => new Date(now()) })
      .catch((err) => console.error(`scheduled ${provider} sync failed:`, err.message));
    ran.push(provider);
  }
  return { ran, skipped };
}

/**
 * Plain interval, no immediate tick: boot is never a sync trigger (startup
 * stays cheap, tests stay deterministic) — an overdue connector runs on the
 * first tick, at most everyMs later. unref'd so it never holds the process
 * open. Returns the stop function.
 */
export function startScheduler(db, { everyMs = 60_000, now = Date.now } = {}) {
  const t = setInterval(() => {
    schedulerTick(db, { now }).catch((err) => console.error("scheduler tick:", err));
  }, everyMs);
  t.unref();
  return () => clearInterval(t);
}

/**
 * The sync-status surface the CLI prints and the server's connectorStatus
 * builds on (the server adds keyHint + syncing). The key itself never leaves.
 */
export async function connectorSyncStatus(db, provider, tickNow = Date.now()) {
  const { label, envVar } = CONNECTOR_PROVIDERS[provider];
  const { key, origin, config } = await resolveConnectorKey(db, provider, envVar);
  const due = key ? nextDueAt(config, tickNow) : null;
  return {
    provider,
    label,
    envVar,
    connected: Boolean(key),
    origin,                       // "stored" (pasted here) | "env" (the provider's env var) | null
    workspace: config.workspace ?? null,
    includeNotes: config.includeNotes !== false,
    syncIntervalMinutes: config.syncIntervalMinutes ?? 0,
    lastSyncAt: config.lastSyncAt ?? null,
    lastDocCount: config.lastDocCount ?? null,
    lastRun: config.lastRun ?? null,
    consecutiveFailures: config.consecutiveFailures ?? 0,
    nextSyncAt: due == null ? null : new Date(due).toISOString(),
  };
}
