import { id } from "./db.js";

/**
 * Tunable scoring configuration, persisted per-database. This is the
 * customization surface: what "a strong relationship" means differs by firm,
 * so the signal weights are data, not code.
 */
export const DEFAULT_SETTINGS = {
  weights: {
    meeting: 3,      // meeting notes (Granola etc.)
    event: 2,        // calendar co-attendance
    email: 2.5,      // direct from<->to email
    emailCc: 1,      // cc'd participation
    doc: 1.5,        // doc co-authorship
    note: 1.5,
    record: 1,       // CRM co-mention
    mentionedFactor: 0.5, // multiplier when a participant is merely mentioned
  },
  halfLifeDays: 180, // recency decay half-life
  saturation: 6,     // strength = 1 - e^(-W/saturation)
  // A document with more distinct resolved people than this contributes no
  // pair-edges: a 500-recipient blast is mass mail, not relationship evidence,
  // and one email's weight split across its 124,750 pairs is noise that buries
  // the real graph. The document and its mentions are always kept, so changing
  // the value applies retroactively on the next edge rebuild. Legitimate large
  // gatherings (a 60-person AGM) are why this is a setting — raise it knowingly.
  maxDocParticipants: 50,
  // Resolution thresholds: at or above autoMerge identities merge
  // deterministically; the band between review and autoMerge asks a human;
  // below review a new entity is created. Changes apply to future resolution
  // runs — Re-resolve re-judges the whole corpus under the new bar.
  resolution: {
    autoMerge: 0.95,
    review: 0.7,
  },
  // Radar policy: how late is late, as multiples of each pair's own learned
  // cadence, and when a no-cadence relationship stops being "new". The
  // data-hygiene floors (minimum cadence, minimum history span) stay in code —
  // they are definitional, not firm policy.
  radar: {
    overdueRatio: 1.5,     // daysSince / cadence at which a pair reads overdue
    coldRatio: 3,          // … and at which it reads cold
    dormantAfterDays: 180, // silent this long with no cadence → dormant
  },
  // Routing strength assumed for another member's private hop when finding
  // warm paths: enough to be found, never reported as a number. (The
  // dashboard's fixed 0.25 display strength for private links is cosmetic
  // and deliberately separate.)
  privateHopStrength: 0.5,
  // Privacy: may a viewer see that an entity EXISTS when every document
  // mentioning it lives in someone else's private layer?
  //   "hide"   — no. An entity with no visible evidence is invisible. Safest,
  //              and the default: a company name that appears only in a
  //              colleague's private email is itself confidential.
  //   "reveal" — yes. Names are shared, evidence is not, so you can ask
  //              "who can reach X" about people you'd otherwise never find.
  //              This is the model Vicunea describes; choose it knowingly.
  privateEntityVisibility: "hide",
};

const NUMERIC_LIMITS = { min: 0, max: 100 };

// Per-key ranges for the nested groups. autoMerge below 0.5 would merge on
// weaker evidence than the review band exists to question; privateHopStrength
// must stay inside (0, 1) so -ln(strength) path costs remain finite.
const GROUP_LIMITS = {
  resolution: { autoMerge: [0.5, 1], review: [0.1, 1] },
  radar: { overdueRatio: [1, 100], coldRatio: [1, 100], dormantAfterDays: [1, 3650] },
};

export async function getSettings(db) {
  const { rows } = await db.query(`select value from settings where key = 'scoring'`);
  if (!rows.length) return structuredClone(DEFAULT_SETTINGS);
  const stored = typeof rows[0].value === "string" ? JSON.parse(rows[0].value) : rows[0].value;
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...stored,
    weights: { ...DEFAULT_SETTINGS.weights, ...(stored.weights ?? {}) },
    // Deep-merge the nested groups like weights: a stored blob predating a
    // key must pick up its default, or ratio comparisons go NaN downstream.
    resolution: { ...DEFAULT_SETTINGS.resolution, ...(stored.resolution ?? {}) },
    radar: { ...DEFAULT_SETTINGS.radar, ...(stored.radar ?? {}) },
  };
}

export async function putSettings(db, patch) {
  const current = await getSettings(db);
  // Every persisted key must appear here: a key missing from this list is
  // silently dropped on the next unrelated save.
  const next = {
    weights: { ...current.weights },
    halfLifeDays: current.halfLifeDays,
    saturation: current.saturation,
    maxDocParticipants: current.maxDocParticipants,
    resolution: { ...current.resolution },
    radar: { ...current.radar },
    privateHopStrength: current.privateHopStrength,
    privateEntityVisibility: current.privateEntityVisibility,
  };
  for (const [k, v] of Object.entries(patch.weights ?? {})) {
    if (!Object.hasOwn(DEFAULT_SETTINGS.weights, k)) throw new Error(`unknown weight "${k}"`);
    next.weights[k] = clampNumber(v, `weights.${k}`);
  }
  if (patch.halfLifeDays !== undefined) {
    next.halfLifeDays = clampNumber(patch.halfLifeDays, "halfLifeDays", 1, 3650);
  }
  if (patch.saturation !== undefined) {
    next.saturation = clampNumber(patch.saturation, "saturation", 0.1, 100);
  }
  if (patch.maxDocParticipants !== undefined) {
    // Min 2: a two-person document is the base case for a pair-edge.
    next.maxDocParticipants = clampNumber(patch.maxDocParticipants, "maxDocParticipants", 2, 10000);
  }
  for (const group of ["resolution", "radar"]) {
    for (const [k, v] of Object.entries(patch[group] ?? {})) {
      // Own-property check mirrors the weights loop and blocks prototype names.
      if (!Object.hasOwn(DEFAULT_SETTINGS[group], k)) throw new Error(`unknown ${group} setting "${k}"`);
      next[group][k] = clampNumber(v, `${group}.${k}`, ...GROUP_LIMITS[group][k]);
    }
  }
  if (patch.privateHopStrength !== undefined) {
    next.privateHopStrength = clampNumber(patch.privateHopStrength, "privateHopStrength", 0.01, 0.99);
  }
  // Cross-field invariants hold on the RESULT, however it was patched: an
  // inverted resolution band auto-merges everything or reviews everything,
  // and overdue >= cold makes "overdue" unreachable.
  if (next.resolution.review >= next.resolution.autoMerge) {
    throw new Error("resolution.review must be below resolution.autoMerge");
  }
  if (next.radar.overdueRatio >= next.radar.coldRatio) {
    throw new Error("radar.overdueRatio must be below radar.coldRatio");
  }
  if (patch.privateEntityVisibility !== undefined) {
    if (!["hide", "reveal"].includes(patch.privateEntityVisibility)) {
      throw new Error('privateEntityVisibility must be "hide" or "reveal"');
    }
    next.privateEntityVisibility = patch.privateEntityVisibility;
  }
  await db.query(
    `insert into settings (key, value, updated_at) values ('scoring', $1, now())
     on conflict (key) do update set value = $1, updated_at = now()`,
    [JSON.stringify(next)]
  );
  return next;
}

function clampNumber(v, name, min = NUMERIC_LIMITS.min, max = NUMERIC_LIMITS.max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return n;
}

/** Append-only audit trail: who did what to the graph, when. The actor is a
 * member's display NAME (never an email), "agent"/"agent:<name>" for MCP
 * callers, or "local" — names stay readable after the member row is removed. */
export async function audit(db, action, detail = {}, actor = "local") {
  await db.query(
    `insert into audit_log (id, actor, action, detail) values ($1, $2, $3, $4)`,
    [id("aud"), actor, action, JSON.stringify(detail)]
  );
}

export async function listAudit(db, limit = 50) {
  const { rows } = await db.query(
    `select at, actor, action, detail from audit_log order by at desc limit $1`,
    [limit]
  );
  return rows.map((r) => ({
    ...r,
    detail: typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail,
  }));
}
