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
  const dist = new Map([[fromId, 0]]);
  const hops = new Map([[fromId, 0]]);
  const prev = new Map();
  const done = new Set();
  const frontier = [[0, fromId]];

  while (frontier.length) {
    frontier.sort((x, y) => x[0] - y[0]); // fine at this scale; swap for a heap later
    const [d, node] = frontier.shift();
    if (done.has(node)) continue;
    done.add(node);
    if (node === toId) break;
    if ((hops.get(node) ?? 0) >= maxHops) continue;
    for (const { to, strength } of adj.get(node) ?? []) {
      const cost = d + -Math.log(Math.max(strength, 0.01));
      if (cost < (dist.get(to) ?? Infinity)) {
        dist.set(to, cost);
        hops.set(to, (hops.get(node) ?? 0) + 1);
        prev.set(to, { node, strength });
        frontier.push([cost, to]);
      }
    }
  }

  if (!done.has(toId)) return null;
  const path = [];
  let cur = toId;
  while (cur !== fromId) {
    const p = prev.get(cur);
    path.unshift({ entity: cur, viaStrength: p.strength });
    cur = p.node;
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
