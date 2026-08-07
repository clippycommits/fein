import { insertMany } from "../db.js";
import { getSettings } from "../settings.js";

/**
 * Connection strength is derived deterministically from interaction signals —
 * never LLM-judged. Signal weights and the recency half-life are tunable per
 * database (settings table); strength = 1 - exp(-W/saturation) saturates
 * toward 1.
 */
function pairWeight(cfg, kind, roleA, roleB) {
  // Being mentioned in a doc is far weaker evidence than attending/authoring it.
  const damp = (r) => (r === "mentioned" ? cfg.weights.mentionedFactor : 1);
  if (kind === "email") {
    const direct = (r) => r === "from" || r === "to";
    const base = direct(roleA) && direct(roleB) ? cfg.weights.email : cfg.weights.emailCc;
    return base * damp(roleA) * damp(roleB);
  }
  // `kind` is ingested data: own-property lookup only, never the prototype chain.
  const base = Object.hasOwn(cfg.weights, kind) ? cfg.weights[kind] : 1;
  return base * damp(roleA) * damp(roleB);
}

function decay(cfg, occurredAt, now) {
  if (!occurredAt) return 0.7; // undated docs count, but less
  const days = Math.max(0, (now - new Date(occurredAt).getTime()) / 86400000);
  return Math.pow(0.5, days / cfg.halfLifeDays);
}

// Full and incremental rebuilds accumulate from this one projection — the
// incremental path only restricts it to a document subset, so they can't drift.
const PROJECTION = `select m.entity_id, m.role, d.id as doc_id, d.kind, d.occurred_at, d.owner
     from mentions m join documents d on d.id = m.document_id
     where m.entity_id is not null and m.kind = 'person'`;
const ORDERING = ` order by d.id, m.entity_id`;

function groupByDoc(rows) {
  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.doc_id)) {
      byDoc.set(r.doc_id, { kind: r.kind, occurred_at: r.occurred_at, owner: r.owner ?? "", people: [] });
    }
    byDoc.get(r.doc_id).people.push({ entity: r.entity_id, role: r.role });
  }
  return byDoc;
}

const ROLE_RANK = { from: 5, to: 4, attendee: 4, author: 3, cc: 2, mentioned: 1 };

/** Fold one document's pair evidence into the accumulator, keyed
 * "owner|a|b". Returns true when the participant cap skipped the doc. */
function accumulateDoc(acc, doc, cfg, now) {
  const seen = new Map(); // entity -> strongest role within this doc
  for (const p of doc.people) {
    const cur = seen.get(p.entity);
    if (!cur || (ROLE_RANK[p.role] ?? 0) > (ROLE_RANK[cur] ?? 0)) seen.set(p.entity, p.role);
  }
  const people = [...seen.entries()];
  // Mass mail is not relationship evidence: above the cap (counted on
  // distinct RESOLVED people, the actual fanout driver), skip the pair
  // fanout but keep the document and its mentions — edges are rebuilt
  // wholesale, so a settings change applies or undoes this retroactively.
  if (people.length > cfg.maxDocParticipants) return true;
  const d = decay(cfg, doc.occurred_at, now);
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const [ea, ra] = people[i];
      const [eb, rb] = people[j];
      const [a, b] = ea < eb ? [ea, eb] : [eb, ea];
      const key = `${doc.owner}|${a}|${b}`;
      if (!acc.has(key)) {
        acc.set(key, { owner: doc.owner, a, b, signals: Object.create(null), weight: 0, lastSeen: null });
      }
      const rec = acc.get(key);
      rec.signals[doc.kind] = (rec.signals[doc.kind] ?? 0) + 1;
      rec.weight += pairWeight(cfg, doc.kind, ra, rb) * d;
      const ts = doc.occurred_at ? new Date(doc.occurred_at).toISOString() : null;
      if (ts && (!rec.lastSeen || ts > rec.lastSeen)) rec.lastSeen = ts;
    }
  }
  return false;
}

/** Validate + batch-insert accumulator records. The caller owns the delete
 * (full and incremental rebuilds scope it differently) and the transaction. */
async function writeEdges(tx, recs, cfg) {
  // Validate while building rows so a bad edge rolls back the whole swap.
  const edgeRows = [];
  for (const rec of recs) {
    const strength = 1 - Math.exp(-rec.weight / cfg.saturation);
    if (!Number.isFinite(strength)) throw new Error(`non-finite strength for ${rec.a}|${rec.b}`);
    edgeRows.push([rec.a, rec.b, rec.owner, JSON.stringify(rec.signals), rec.weight, strength, rec.lastSeen]);
  }
  await insertMany(tx, {
    table: "edges",
    cols: ["a", "b", "owner", "signals", "weight", "strength", "last_seen"],
    rows: edgeRows,
  });
}

/**
 * Full deterministic rebuild — edges are a read model over resolved mentions.
 * Evidence is accumulated per privacy layer: documents in the shared layer
 * (owner '') produce shared edges, and each member's private documents produce
 * edges only they can see. A viewer's strength is the saturation of the summed
 * weight across the layers visible to them, so private evidence adds to shared
 * evidence rather than replacing it.
 */
export async function rebuildEdges(db, now = Date.now()) {
  const cfg = await getSettings(db);
  const { rows } = await db.query(PROJECTION + ORDERING);

  const acc = new Map();
  let capped = 0;
  for (const doc of groupByDoc(rows).values()) {
    if (accumulateDoc(acc, doc, cfg, now)) capped++;
  }

  // One transaction so readers never observe a half-rebuilt graph.
  await db.tx(async (tx) => {
    await tx.query(`delete from edges`);
    await writeEdges(tx, [...acc.values()], cfg);
  });
  const layers = new Set([...acc.values()].map((r) => r.owner));
  return { edges: acc.size, layers: layers.size, cappedDocs: capped };
}

/**
 * Incremental rebuild: recompute only the edges touching `entityIds`, in every
 * layer, leaving all other rows exactly as they were. Used after targeted
 * writes (a review decision, a merge/unmerge) where the affected entities are
 * known — ingest-scale changes still take the full rebuild.
 *
 * The accumulator filter below is load-bearing: a document mentioning a dirty
 * entity A also yields pairs between its OTHER participants, but the document
 * subset undercounts those pairs (B and C co-occur in docs outside it), so
 * only dirty-touching pairs may be swapped. Weights are baselined to `now`
 * like the full rebuild's; the routine full rebuilds on ingest/sync paths
 * keep the baselines from drifting apart.
 */
export async function rebuildEdgesFor(db, entityIds, now = Date.now()) {
  const dirty = [...new Set((entityIds ?? []).filter(Boolean))];
  if (!dirty.length) return { edges: 0, layers: 0, cappedDocs: 0, mode: "incremental" };
  const cfg = await getSettings(db);
  const ph = dirty.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await db.query(
    PROJECTION +
      ` and d.id in (select document_id from mentions where entity_id in (${ph}))` +
      ORDERING,
    dirty
  );

  const acc = new Map();
  let capped = 0;
  for (const doc of groupByDoc(rows).values()) {
    if (accumulateDoc(acc, doc, cfg, now)) capped++;
  }
  const dirtySet = new Set(dirty);
  const recs = [...acc.values()].filter((r) => dirtySet.has(r.a) || dirtySet.has(r.b));

  // One transaction so readers never observe a half-rebuilt graph.
  await db.tx(async (tx) => {
    await tx.query(`delete from edges where a in (${ph}) or b in (${ph})`, dirty);
    await writeEdges(tx, recs, cfg);
  });
  const layers = new Set(recs.map((r) => r.owner));
  return { edges: recs.length, layers: layers.size, cappedDocs: capped, mode: "incremental" };
}

/** Saturation is applied to summed weight, so callers can combine layers. */
export function strengthOf(weight, cfg) {
  return 1 - Math.exp(-weight / cfg.saturation);
}
