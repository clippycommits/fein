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
  const { rows } = await db.query(
    `select m.entity_id, m.role, d.id as doc_id, d.kind, d.occurred_at, d.owner
     from mentions m join documents d on d.id = m.document_id
     where m.entity_id is not null and m.kind = 'person'
     order by d.id, m.entity_id`
  );

  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.doc_id)) {
      byDoc.set(r.doc_id, { kind: r.kind, occurred_at: r.occurred_at, owner: r.owner ?? "", people: [] });
    }
    byDoc.get(r.doc_id).people.push({ entity: r.entity_id, role: r.role });
  }

  const ROLE_RANK = { from: 5, to: 4, attendee: 4, author: 3, cc: 2, mentioned: 1 };
  const acc = new Map(); // "owner|a|b" -> {owner, a, b, signals, weight, lastSeen}
  let capped = 0;
  for (const doc of byDoc.values()) {
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
    if (people.length > cfg.maxDocParticipants) { capped++; continue; }
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
  }

  // Validate while building rows so a bad edge is caught before any write.
  const edgeRows = [];
  for (const rec of acc.values()) {
    const strength = 1 - Math.exp(-rec.weight / cfg.saturation);
    if (!Number.isFinite(strength)) throw new Error(`non-finite strength for ${rec.a}|${rec.b}`);
    edgeRows.push([rec.a, rec.b, rec.owner, JSON.stringify(rec.signals), rec.weight, strength, rec.lastSeen]);
  }
  // One transaction so readers never observe a half-rebuilt graph.
  await db.tx(async (tx) => {
    await tx.query(`delete from edges`);
    await insertMany(tx, {
      table: "edges",
      cols: ["a", "b", "owner", "signals", "weight", "strength", "last_seen"],
      rows: edgeRows,
    });
  });
  const layers = new Set([...acc.values()].map((r) => r.owner));
  return { edges: acc.size, layers: layers.size, cappedDocs: capped };
}

/** Saturation is applied to summed weight, so callers can combine layers. */
export function strengthOf(weight, cfg) {
  return 1 - Math.exp(-weight / cfg.saturation);
}
