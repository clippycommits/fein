import { getSettings } from "../settings.js";
import { strengthOf } from "./edges.js";
import { visibleLayers } from "../members.js";

/**
 * Warm-path finding: graph-based retrieval over weighted connection paths,
 * not vector search. Dijkstra with edge cost -ln(strength), so the best path
 * maximizes the product of hop strengths.
 *
 * Privacy layers: a viewer sees the shared layer plus their own. Evidence from
 * other members' private layers is never revealed as strength or documents —
 * but its *existence* is, because "Seb can reach this person, ask him" is the
 * whole point of a relationship graph. Those hops come back marked private,
 * with the owner named and no numbers attached.
 */
async function loadGraph(db, viewerId) {
  const cfg = await getSettings(db);
  const layers = visibleLayers(viewerId);
  const placeholders = layers.map((_, i) => `$${i + 1}`).join(", ");

  // Visible: sum weight across the shared layer and the viewer's own, then
  // saturate once — private evidence reinforces shared evidence.
  const { rows: visible } = await db.query(
    `select a, b, sum(weight) as weight from edges
     where owner in (${placeholders}) group by a, b`,
    layers
  );
  const adj = new Map();
  const add = (map, x, y, value) => {
    if (!map.has(x)) map.set(x, []);
    map.get(x).push({ to: y, ...value });
  };
  for (const e of visible) {
    const strength = strengthOf(Number(e.weight), cfg);
    if (strength <= 0.01) continue;
    add(adj, e.a, e.b, { strength });
    add(adj, e.b, e.a, { strength });
  }

  // Present in someone else's layer only: existence, never magnitude.
  const { rows: foreign } = await db.query(
    `select e.a, e.b, e.owner, m.name as owner_name from edges e
     left join members m on m.id = e.owner
     where e.owner <> '' and e.owner not in (${placeholders})`,
    layers
  );
  const hidden = new Map();
  for (const e of foreign) {
    const meta = { owner: e.owner, ownerName: e.owner_name ?? e.owner, private: true };
    add(hidden, e.a, e.b, meta);
    add(hidden, e.b, e.a, meta);
  }
  return { adj, hidden };
}

/** Dijkstra over (node, hopCount) states so a cheap long path can't shadow a
 * hop-feasible shorter one. `edgesFor` supplies each node's usable neighbours. */
function search(fromId, toId, maxHops, edgesFor) {
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
    for (const edge of edgesFor(node)) {
      const nk = key(edge.to, h + 1);
      const cost = d + -Math.log(Math.max(edge.strength ?? PRIVATE_PRIOR, 0.01));
      if (cost < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, cost);
        prev.set(nk, { node, h, edge });
        frontier.push([cost, edge.to, h + 1]);
      }
    }
  }

  if (!end) return null;
  const path = [];
  let cur = end;
  while (cur.node !== fromId || cur.h !== 0) {
    const p = prev.get(key(cur.node, cur.h));
    path.unshift({
      entity: cur.node,
      // A private hop's magnitude is not the viewer's to see.
      viaStrength: p.edge.private ? null : p.edge.strength,
      ...(p.edge.private ? { private: true, via: p.edge.ownerName } : {}),
    });
    cur = { node: p.node, h: p.h };
  }
  path.unshift({ entity: fromId, viaStrength: null });
  return path;
}

// A private hop is treated as a mid-strength link for routing purposes only:
// enough to be found, never reported as a number.
const PRIVATE_PRIOR = 0.5;

export async function findWarmPath(db, fromId, toId, options = {}) {
  const { viewer = null, maxHops = 4 } = typeof options === "number" ? { maxHops: options } : options;
  const { adj, hidden } = await loadGraph(db, viewer);

  const visiblePath = search(fromId, toId, maxHops, (n) => adj.get(n) ?? []);
  const result = visiblePath
    ? {
        path: visiblePath,
        pathStrength: visiblePath.slice(1).reduce((acc, s) => acc * s.viaStrength, 1),
      }
    : null;

  // Would another member's private layer get there — sooner, or at all?
  const combined = search(fromId, toId, maxHops, (n) => [...(adj.get(n) ?? []), ...(hidden.get(n) ?? [])]);
  const usesPrivate = combined?.some((s) => s.private);
  if (combined && usesPrivate && (!visiblePath || combined.length < visiblePath.length)) {
    const owners = [...new Set(combined.filter((s) => s.private).map((s) => s.via))];
    return {
      ...(result ?? { path: null, pathStrength: null }),
      privatePath: {
        path: combined,
        owners,
        note: owners.length === 1
          ? `${owners[0]} has a private connection on this route — ask them for the intro.`
          : `Private connections on this route are held by: ${owners.join(", ")}.`,
      },
    };
  }
  return result;
}

/** Rank mutual connections as introducers: min(strength(from,m), strength(m,to)). */
export async function findIntroducers(db, fromId, toId, options = {}) {
  const { viewer = null, limit = 5 } = typeof options === "number" ? { limit: options } : options;
  const { adj, hidden } = await loadGraph(db, viewer);
  const fromN = new Map((adj.get(fromId) ?? []).map((e) => [e.to, e.strength]));
  const toN = new Map((adj.get(toId) ?? []).map((e) => [e.to, e.strength]));
  const mutual = [];
  for (const [m, sFrom] of fromN) {
    if (m === toId) continue;
    const sTo = toN.get(m);
    if (sTo) mutual.push({ entity: m, strengthToYou: sFrom, strengthToTarget: sTo, score: Math.min(sFrom, sTo) });
  }
  const ranked = mutual.sort((x, y) => y.score - x.score).slice(0, limit);

  // Someone whose private layer reaches the target is a real introducer route,
  // even though the viewer cannot see the evidence.
  const known = new Set(ranked.map((r) => r.entity));
  const privateOwners = new Map();
  for (const e of hidden.get(toId) ?? []) {
    if (!privateOwners.has(e.ownerName)) privateOwners.set(e.ownerName, new Set());
    privateOwners.get(e.ownerName).add(e.to);
  }
  const viaPrivate = [...privateOwners.keys()].map((ownerName) => ({
    owner: ownerName,
    private: true,
    note: `${ownerName} has a private connection to this person.`,
  }));
  return viaPrivate.length ? { introducers: ranked, viaPrivate } : ranked;
}

export async function strongestConnections(db, entityId, options = {}) {
  const { viewer = null, limit = 10 } = typeof options === "number" ? { limit: options } : options;
  const cfg = await getSettings(db);
  const layers = visibleLayers(viewer);
  const placeholders = layers.map((_, i) => `$${i + 2}`).join(", ");
  const { rows } = await db.query(
    `select case when a = $1 then b else a end as other,
            sum(weight) as weight,
            max(last_seen) as last_seen,
            jsonb_agg(signals) as signal_sets
     from edges
     where (a = $1 or b = $1) and owner in (${placeholders})
     group by other
     order by weight desc
     limit ${Number(limit) || 10}`,
    [entityId, ...layers]
  );
  return rows.map((r) => {
    const sets = typeof r.signal_sets === "string" ? JSON.parse(r.signal_sets) : r.signal_sets;
    const signals = Object.create(null);
    for (const s of sets ?? []) {
      for (const [k, v] of Object.entries(s ?? {})) signals[k] = (signals[k] ?? 0) + v;
    }
    return {
      entity: r.other,
      strength: strengthOf(Number(r.weight), cfg),
      signals,
      last_seen: r.last_seen,
    };
  });
}
