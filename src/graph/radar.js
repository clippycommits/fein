import { visibleLayers } from "../members.js";

/**
 * Relationship radar — the timing layer.
 *
 * Strength answers "who do I know well". Radar answers "who should I contact
 * now": every pair has its own natural cadence, learned from how often they
 * have actually interacted, so being three weeks silent is unremarkable with a
 * quarterly contact and alarming with a weekly one. Entirely deterministic —
 * intervals and dates, no model in the loop.
 */

const DAY = 86400000;

/** Median is the right centre here: one burst of ten emails must not reset the norm. */
function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// A burst of contact inside one day is not a one-day cadence, and a history
// that spans a few days can't tell you what "normal" looks like for a pair.
const MIN_CADENCE_DAYS = 1;
const MIN_SPAN_DAYS = 7;

function classify({ daysSince, cadenceDays, contacts, spanDays }) {
  if (contacts < 2 || cadenceDays === null || spanDays < MIN_SPAN_DAYS) {
    // Not enough history to be late against — but it can still go stale.
    return daysSince > 180 ? "dormant" : "new";
  }
  const ratio = daysSince / Math.max(cadenceDays, MIN_CADENCE_DAYS);
  if (ratio >= 3) return "cold";
  if (ratio >= 1.5) return "overdue";
  if (ratio >= 1) return "due";
  return "active";
}

const RANK = { cold: 0, overdue: 1, due: 2, dormant: 3, new: 4, active: 5 };

/**
 * Contact history for one person's relationships, scoped to the viewer's
 * privacy layers. `now` is injectable so results are reproducible in tests.
 */
export async function relationshipRadar(db, entityId, { viewer = null, limit = 25, now = Date.now() } = {}) {
  const layers = visibleLayers(viewer);
  const lph = layers.map((_, i) => `$${i + 2}`).join(", ");

  // Every dated document the pair both appear in, newest first.
  const { rows } = await db.query(
    `select other.entity_id as other, d.occurred_at, d.kind, d.title, d.source
     from mentions me
     join documents d on d.id = me.document_id
     join mentions other on other.document_id = d.id and other.entity_id <> me.entity_id
     where me.entity_id = $1 and me.kind = 'person' and other.kind = 'person'
       and other.entity_id is not null
       and d.occurred_at is not null and d.owner in (${lph})
     order by other.entity_id, d.occurred_at desc`,
    [entityId, ...layers]
  );

  const byOther = new Map();
  for (const r of rows) {
    if (!byOther.has(r.other)) byOther.set(r.other, []);
    const list = byOther.get(r.other);
    // One document is one contact event, however many mentions it produced.
    if (list.at(-1)?.at === r.occurred_at) continue;
    list.push({ at: r.occurred_at, kind: r.kind, title: r.title, source: r.source });
  }

  const out = [];
  for (const [other, events] of byOther) {
    const times = events.map((e) => new Date(e.at).getTime()).sort((a, b) => b - a);
    const last = times[0];
    const daysSince = Math.floor((now - last) / DAY);
    const gaps = [];
    for (let i = 0; i + 1 < times.length; i++) gaps.push((times[i] - times[i + 1]) / DAY);
    const rawCadence = gaps.length ? median(gaps.sort((a, b) => a - b)) : null;
    const spanDays = (times[0] - times.at(-1)) / DAY;
    const cadenceDays = rawCadence === null ? null : Math.max(rawCadence, MIN_CADENCE_DAYS);

    // Trend: contact rate over the last 90 days vs the 90 before it. With no
    // contact in either window there is no trend to report — saying "steady"
    // would imply evidence we don't have (the status already says it's cold).
    const recent = times.filter((t) => t > now - 90 * DAY).length;
    const prior = times.filter((t) => t <= now - 90 * DAY && t > now - 180 * DAY).length;
    const trend = recent === 0 && prior === 0 ? null
      : recent > prior ? "warming" : recent < prior ? "cooling" : "steady";

    const status = classify({ daysSince, cadenceDays, contacts: times.length, spanDays });
    out.push({
      entity: other,
      status,
      contacts: times.length,
      lastContact: new Date(last).toISOString(),
      daysSinceContact: daysSince,
      cadenceDays: cadenceDays === null ? null : Math.round(cadenceDays * 10) / 10,
      overdueBy: cadenceDays === null ? null : Math.max(0, Math.round(daysSince - cadenceDays)),
      trend,
      lastTouch: { kind: events[0].kind, title: events[0].title, source: events[0].source },
    });
  }

  // Most actionable first: coldest relative to their own cadence.
  out.sort((a, b) => {
    if (RANK[a.status] !== RANK[b.status]) return RANK[a.status] - RANK[b.status];
    return (b.overdueBy ?? 0) - (a.overdueBy ?? 0);
  });
  return out.slice(0, limit);
}

/**
 * Radar across every person the viewer can see, for the dashboard: the same
 * per-pair cadence maths, aggregated to "which relationships need attention".
 */
export async function radarSummary(db, { viewer = null, limit = 20, now = Date.now() } = {}) {
  const layers = visibleLayers(viewer);
  const lph = layers.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await db.query(
    `select a.entity_id as x, b.entity_id as y, d.occurred_at
     from mentions a
     join documents d on d.id = a.document_id
     join mentions b on b.document_id = d.id and b.entity_id > a.entity_id
     where a.kind = 'person' and b.kind = 'person'
       and a.entity_id is not null and b.entity_id is not null
       and d.occurred_at is not null and d.owner in (${lph})`,
    layers
  );

  const pairs = new Map();
  for (const r of rows) {
    const key = `${r.x}|${r.y}`;
    if (!pairs.has(key)) pairs.set(key, { a: r.x, b: r.y, times: new Set() });
    pairs.get(key).times.add(new Date(r.occurred_at).getTime());
  }

  const items = [];
  const counts = { active: 0, due: 0, overdue: 0, cold: 0, dormant: 0, new: 0 };
  for (const p of pairs.values()) {
    const times = [...p.times].sort((x, y) => y - x);
    const daysSince = Math.floor((now - times[0]) / DAY);
    const gaps = [];
    for (let i = 0; i + 1 < times.length; i++) gaps.push((times[i] - times[i + 1]) / DAY);
    const rawCadence = gaps.length ? median(gaps.sort((x, y) => x - y)) : null;
    const spanDays = (times[0] - times.at(-1)) / DAY;
    const cadenceDays = rawCadence === null ? null : Math.max(rawCadence, MIN_CADENCE_DAYS);
    const status = classify({ daysSince, cadenceDays, contacts: times.length, spanDays });
    counts[status]++;
    items.push({
      a: p.a, b: p.b, status, contacts: times.length,
      daysSinceContact: daysSince,
      cadenceDays: cadenceDays === null ? null : Math.round(cadenceDays * 10) / 10,
      overdueBy: cadenceDays === null ? null : Math.max(0, Math.round(daysSince - cadenceDays)),
    });
  }
  items.sort((x, y) => {
    if (RANK[x.status] !== RANK[y.status]) return RANK[x.status] - RANK[y.status];
    return (y.overdueBy ?? 0) - (x.overdueBy ?? 0);
  });
  // Only relationships with a real cadence are worth nagging about.
  const needsAttention = items.filter((i) => i.status === "overdue" || i.status === "cold" || i.status === "due");
  return { counts, needsAttention: needsAttention.slice(0, limit), pairs: items.length };
}
