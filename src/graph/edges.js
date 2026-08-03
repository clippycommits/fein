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

/** Full deterministic rebuild — edges are a read model over resolved mentions. */
export async function rebuildEdges(db, now = Date.now()) {
  const cfg = await getSettings(db);
  const { rows } = await db.query(
    `select m.entity_id, m.role, d.id as doc_id, d.kind, d.occurred_at
     from mentions m join documents d on d.id = m.document_id
     where m.entity_id is not null and m.kind = 'person'
     order by d.id, m.entity_id`
  );

  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.doc_id)) byDoc.set(r.doc_id, { kind: r.kind, occurred_at: r.occurred_at, people: [] });
    byDoc.get(r.doc_id).people.push({ entity: r.entity_id, role: r.role });
  }

  const ROLE_RANK = { from: 5, to: 4, attendee: 4, author: 3, cc: 2, mentioned: 1 };
  const acc = new Map(); // "a|b" -> {signals, weight, lastSeen}
  for (const doc of byDoc.values()) {
    const seen = new Map(); // entity -> strongest role within this doc
    for (const p of doc.people) {
      const cur = seen.get(p.entity);
      if (!cur || (ROLE_RANK[p.role] ?? 0) > (ROLE_RANK[cur] ?? 0)) seen.set(p.entity, p.role);
    }
    const people = [...seen.entries()];
    const d = decay(cfg, doc.occurred_at, now);
    for (let i = 0; i < people.length; i++) {
      for (let j = i + 1; j < people.length; j++) {
        const [ea, ra] = people[i];
        const [eb, rb] = people[j];
        const [a, b] = ea < eb ? [ea, eb] : [eb, ea];
        const key = `${a}|${b}`;
        if (!acc.has(key)) acc.set(key, { a, b, signals: Object.create(null), weight: 0, lastSeen: null });
        const rec = acc.get(key);
        rec.signals[doc.kind] = (rec.signals[doc.kind] ?? 0) + 1;
        rec.weight += pairWeight(cfg, doc.kind, ra, rb) * d;
        const ts = doc.occurred_at ? new Date(doc.occurred_at).toISOString() : null;
        if (ts && (!rec.lastSeen || ts > rec.lastSeen)) rec.lastSeen = ts;
      }
    }
  }

  // One transaction so readers never observe a half-rebuilt graph.
  await db.tx(async (tx) => {
    await tx.query(`delete from edges`);
    for (const rec of acc.values()) {
      const strength = 1 - Math.exp(-rec.weight / cfg.saturation);
      if (!Number.isFinite(strength)) throw new Error(`non-finite strength for ${rec.a}|${rec.b}`);
      await tx.query(
        `insert into edges (a, b, signals, strength, last_seen) values ($1, $2, $3, $4, $5)`,
        [rec.a, rec.b, JSON.stringify(rec.signals), strength, rec.lastSeen]
      );
    }
  });
  return { edges: acc.size };
}
