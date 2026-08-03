/**
 * Connection strength is derived deterministically from interaction signals —
 * never LLM-judged. Signal weights by document kind, with a 180-day half-life
 * recency decay. strength = 1 - exp(-W/6), so it saturates toward 1.
 */
const KIND_WEIGHT = { meeting: 3, event: 2, email: 2, doc: 1.5, note: 1.5, record: 1 };
const HALF_LIFE_DAYS = 180;

function pairWeight(kind, roleA, roleB) {
  let w = KIND_WEIGHT[kind] ?? 1;
  if (kind === "email") {
    const direct = (r) => r === "from" || r === "to";
    w = direct(roleA) && direct(roleB) ? 2.5 : 1; // cc'd participants are weak signal
  }
  return w;
}

function decay(occurredAt, now) {
  if (!occurredAt) return 0.7; // undated docs count, but less
  const days = Math.max(0, (now - new Date(occurredAt).getTime()) / 86400000);
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

/** Full deterministic rebuild — edges are a read model over resolved mentions. */
export async function rebuildEdges(db, now = Date.now()) {
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

  const acc = new Map(); // "a|b" -> {signals, weight, lastSeen}
  for (const doc of byDoc.values()) {
    const seen = new Map(); // entity -> role (dedupe within doc)
    for (const p of doc.people) if (!seen.has(p.entity)) seen.set(p.entity, p.role);
    const people = [...seen.entries()];
    const d = decay(doc.occurred_at, now);
    for (let i = 0; i < people.length; i++) {
      for (let j = i + 1; j < people.length; j++) {
        const [ea, ra] = people[i];
        const [eb, rb] = people[j];
        const [a, b] = ea < eb ? [ea, eb] : [eb, ea];
        const key = `${a}|${b}`;
        if (!acc.has(key)) acc.set(key, { a, b, signals: {}, weight: 0, lastSeen: null });
        const rec = acc.get(key);
        rec.signals[doc.kind] = (rec.signals[doc.kind] ?? 0) + 1;
        rec.weight += pairWeight(doc.kind, ra, rb) * d;
        const ts = doc.occurred_at ? new Date(doc.occurred_at).toISOString() : null;
        if (ts && (!rec.lastSeen || ts > rec.lastSeen)) rec.lastSeen = ts;
      }
    }
  }

  await db.query(`delete from edges`);
  for (const rec of acc.values()) {
    const strength = 1 - Math.exp(-rec.weight / 6);
    await db.query(
      `insert into edges (a, b, signals, strength, last_seen) values ($1, $2, $3, $4, $5)`,
      [rec.a, rec.b, JSON.stringify(rec.signals), strength, rec.lastSeen]
    );
  }
  return { edges: acc.size };
}
