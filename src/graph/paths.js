/**
 * Warm-path finding: graph-based retrieval over weighted connection paths,
 * not vector search. Dijkstra with edge cost -ln(strength), so the best path
 * maximizes the product of hop strengths.
 */
async function loadGraph(db) {
  const { rows } = await db.query(`select a, b, strength from edges where strength > 0.01`);
  const adj = new Map();
  const add = (x, y, s) => {
    if (!adj.has(x)) adj.set(x, []);
    adj.get(x).push({ to: y, strength: s });
  };
  for (const e of rows) {
    add(e.a, e.b, e.strength);
    add(e.b, e.a, e.strength);
  }
  return adj;
}

export async function findWarmPath(db, fromId, toId, maxHops = 4) {
  const adj = await loadGraph(db);
  // Dijkstra over (node, hopCount) states: a cheap-but-long path must not
  // finalize a node and shadow a costlier path that fits the hop budget.
  const key = (n, h) => `${h}|${n}`;
  const dist = new Map([[key(fromId, 0), 0]]);
  const prev = new Map();
  const done = new Set();
  const frontier = [[0, fromId, 0]];
  let end = null;

  while (frontier.length) {
    frontier.sort((x, y) => x[0] - y[0]); // fine at this scale; swap for a heap later
    const [d, node, h] = frontier.shift();
    const k = key(node, h);
    if (done.has(k)) continue;
    done.add(k);
    if (node === toId) { end = { node, h }; break; }
    if (h >= maxHops) continue;
    for (const { to, strength } of adj.get(node) ?? []) {
      const nk = key(to, h + 1);
      const cost = d + -Math.log(Math.max(strength, 0.01));
      if (cost < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, cost);
        prev.set(nk, { node, h, strength });
        frontier.push([cost, to, h + 1]);
      }
    }
  }

  if (!end) return null;
  const path = [];
  let cur = end;
  while (cur.node !== fromId || cur.h !== 0) {
    const p = prev.get(key(cur.node, cur.h));
    path.unshift({ entity: cur.node, viaStrength: p.strength });
    cur = { node: p.node, h: p.h };
  }
  path.unshift({ entity: fromId, viaStrength: null });
  const product = path.slice(1).reduce((acc, s) => acc * s.viaStrength, 1);
  return { path, pathStrength: product };
}

/** Rank mutual connections as introducers: min(strength(from,m), strength(m,to)). */
export async function findIntroducers(db, fromId, toId, limit = 5) {
  const adj = await loadGraph(db);
  const fromN = new Map((adj.get(fromId) ?? []).map((e) => [e.to, e.strength]));
  const toN = new Map((adj.get(toId) ?? []).map((e) => [e.to, e.strength]));
  const mutual = [];
  for (const [m, sFrom] of fromN) {
    if (m === toId) continue;
    const sTo = toN.get(m);
    if (sTo) mutual.push({ entity: m, strengthToYou: sFrom, strengthToTarget: sTo, score: Math.min(sFrom, sTo) });
  }
  return mutual.sort((x, y) => y.score - x.score).slice(0, limit);
}

export async function strongestConnections(db, entityId, limit = 10) {
  const { rows } = await db.query(
    `select a, b, strength, signals, last_seen from edges
     where a = $1 or b = $1 order by strength desc limit $2`,
    [entityId, limit]
  );
  return rows.map((r) => ({
    entity: r.a === entityId ? r.b : r.a,
    strength: r.strength,
    signals: typeof r.signals === "string" ? JSON.parse(r.signals) : r.signals,
    last_seen: r.last_seen,
  }));
}
