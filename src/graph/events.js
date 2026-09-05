import { visibleLayers } from "../members.js";

/**
 * Events — the guest-side view of the graph.
 *
 * Event documents (kinds `event`, `rsvp`, `invite`, from the Attio events
 * adapter or any JSONL with the same `raw.event` shape) carry a tier per
 * guest. These queries read them back as history: what a person was
 * invited to and showed up for, who was in a given room, and league tables
 * across events — the loyal, the lapsed, and the over-invited. All
 * deterministic, all scoped to the viewer's layers like every other read.
 */

// The guest's mention on a touch document has role `attendee` (attended) or
// `to` (invited / RSVP'd / declined); hosts are `author`, inviters `from`.

function layerClause(layers, offset) {
  return layers.map((_, i) => `$${offset + i}`).join(", ");
}

/** Every event known to the graph, with per-tier guest counts. */
export async function listEvents(db, { viewer = null, since = null, until = null } = {}) {
  const layers = visibleLayers(viewer);
  const params = [...layers];
  let dateFilter = "";
  if (since) { params.push(since); dateFilter += ` and d.occurred_at >= $${params.length}`; }
  if (until) { params.push(until); dateFilter += ` and d.occurred_at <= $${params.length}`; }
  const { rows } = await db.query(
    `select d.raw->>'event' as slug, d.raw->>'event_name' as name, d.raw->>'event_date' as date,
            d.raw->>'tier' as tier, count(distinct m.entity_id) as n
     from documents d join mentions m on m.document_id = d.id
     where d.raw->>'event' is not null and d.raw->>'tier' is not null
       and m.kind = 'person' and m.entity_id is not null and m.role in ('attendee', 'to')
       and d.owner in (${layerClause(layers, 1)})${dateFilter}
     group by 1, 2, 3, 4 order by 3, 2`,
    params
  );
  const byEvent = new Map();
  for (const r of rows) {
    if (!byEvent.has(r.slug)) byEvent.set(r.slug, { slug: r.slug, name: r.name, date: r.date, attended: 0, rsvp: 0, declined: 0, invited: 0 });
    byEvent.get(r.slug)[r.tier] = Number(r.n);
  }
  const out = [...byEvent.values()];
  for (const e of out) e.contacted = e.attended + e.rsvp + e.declined + e.invited;
  return out;
}

/** Resolve an event by slug or (case-insensitive, partial) name. */
export async function resolveEvent(db, ref, { viewer = null } = {}) {
  const events = await listEvents(db, { viewer });
  const q = String(ref ?? "").trim().toLowerCase();
  if (!q) return { error: "give an event slug or name" };
  const exact = events.find((e) => e.slug === q || e.name.toLowerCase() === q);
  if (exact) return { event: exact };
  const partial = events.filter((e) => e.name.toLowerCase().includes(q) || e.slug.includes(q));
  if (partial.length === 1) return { event: partial[0] };
  if (!partial.length) return { error: `no event matches "${ref}"`, events: events.map((e) => e.name) };
  return { error: `"${ref}" is ambiguous`, candidates: partial.map((e) => ({ slug: e.slug, name: e.name, date: e.date })) };
}

/**
 * One person's event history, newest first: every event they were
 * contacted about, the tier they reached, who brought them, and the
 * receipt (which attribute said so).
 */
export async function eventHistory(db, entityId, { viewer = null, limit = 100 } = {}) {
  const layers = visibleLayers(viewer);
  const { rows } = await db.query(
    `select d.id as doc_id, d.raw->>'event' as slug, d.raw->>'event_name' as event, d.raw->>'event_date' as date,
            d.raw->>'tier' as tier, d.raw->>'evidence' as evidence, d.raw->>'invited_by' as invited_by,
            d.raw->>'via' as via, d.raw->'host'->>'name' as host, d.raw->'attributes' as attributes
     from documents d join mentions m on m.document_id = d.id
     where m.entity_id = $1 and m.kind = 'person' and m.role in ('attendee', 'to')
       and d.raw->>'event' is not null and d.raw->>'tier' is not null
       and d.owner in (${layerClause(layers, 2)})
     order by d.occurred_at desc nulls last limit $${layers.length + 2}`,
    [entityId, ...layers, limit]
  );
  const history = rows.map((r) => ({
    event: r.event, slug: r.slug, date: r.date, tier: r.tier, evidence: r.evidence,
    ...(r.host ? { host: r.host } : {}),
    ...(r.invited_by ? { invitedBy: r.invited_by } : {}),
    ...(r.via ? { via: r.via } : {}),
    ...(r.attributes ? { attributes: typeof r.attributes === "string" ? JSON.parse(r.attributes) : r.attributes } : {}),
  }));
  return { history, summary: summarize(history) };
}

function summarize(history) {
  const s = { events: history.length, attended: 0, rsvp: 0, declined: 0, invited: 0, firstEvent: null, lastEvent: null, lastAttended: null };
  for (const h of history) {
    s[h.tier] = (s[h.tier] ?? 0) + 1;
    if (h.date) {
      if (!s.firstEvent || h.date < s.firstEvent) s.firstEvent = h.date;
      if (!s.lastEvent || h.date > s.lastEvent) s.lastEvent = h.date;
      if (h.tier === "attended" && (!s.lastAttended || h.date > s.lastAttended)) s.lastAttended = h.date;
    }
  }
  s.showRate = s.events ? Number((s.attended / s.events).toFixed(2)) : null;
  return s;
}

/** Who was contacted about one event, grouped by tier, with who brought them. */
export async function eventGuests(db, slug, { viewer = null, tier = null, limit = 500 } = {}) {
  const layers = visibleLayers(viewer);
  const params = [slug, ...layers];
  let tierFilter = "";
  if (tier) { params.push(tier); tierFilter = ` and d.raw->>'tier' = $${params.length}`; }
  params.push(limit);
  const { rows } = await db.query(
    `select e.id as entity, e.canonical_name as name, e.orgs, d.raw->>'tier' as tier,
            d.raw->>'invited_by' as invited_by, d.raw->>'via' as via, d.raw->'host'->>'name' as host,
            d.raw->'attributes' as attributes
     from documents d join mentions m on m.document_id = d.id
     join entities e on e.id = m.entity_id
     where d.raw->>'event' = $1 and d.raw->>'tier' is not null
       and m.kind = 'person' and m.role in ('attendee', 'to')
       and d.owner in (${layerClause(layers, 2)})${tierFilter}
     order by case d.raw->>'tier' when 'attended' then 0 when 'rsvp' then 1 when 'declined' then 2 else 3 end, e.canonical_name
     limit $${params.length}`,
    params
  );
  const guests = rows.map((r) => ({
    entity: r.entity, name: r.name, tier: r.tier,
    org: (typeof r.orgs === "string" ? JSON.parse(r.orgs) : r.orgs)?.[0] ?? null,
    ...(r.host ? { host: r.host } : {}),
    ...(r.invited_by ? { invitedBy: r.invited_by } : {}),
    ...(r.via ? { via: r.via } : {}),
    ...(r.attributes ? { attributes: typeof r.attributes === "string" ? JSON.parse(r.attributes) : r.attributes } : {}),
  }));
  const counts = { attended: 0, rsvp: 0, declined: 0, invited: 0 };
  for (const g of guests) counts[g.tier] = (counts[g.tier] ?? 0) + 1;
  return { guests, counts };
}

/**
 * League tables across events. `sort`:
 *   most_attended   — the loyal: most events attended
 *   never_attended  — the over-invited: many invitations, never in the room
 *   most_invited    — most contacted, whatever came of it
 *   lapsed          — attended before `since` (or ever) but nothing since;
 *                     ordered by how much they used to show up
 *   best_show_rate  — highest attended/contacted with at least `minEvents`
 * `since`/`until` bound the events counted (YYYY-MM-DD); `lapsed` uses
 * `since` as the cut: activity before it, silence after it.
 */
export async function guestLeague(db, { viewer = null, sort = "most_attended", since = null, until = null, minEvents = 1, limit = 25, includeHosts = false } = {}) {
  const layers = visibleLayers(viewer);
  const params = [...layers];
  let dateFilter = "";
  if (sort !== "lapsed") {
    if (since) { params.push(since); dateFilter += ` and d.raw->>'event_date' >= $${params.length}`; }
    if (until) { params.push(until); dateFilter += ` and d.raw->>'event_date' <= $${params.length}`; }
  }
  const { rows } = await db.query(
    `select e.id as entity, e.canonical_name as name, e.orgs, d.raw->>'tier' as tier, d.raw->>'event_date' as date, d.raw->>'event_name' as event
     from documents d join mentions m on m.document_id = d.id
     join entities e on e.id = m.entity_id
     where d.raw->>'event' is not null and d.raw->>'tier' is not null
       and m.kind = 'person' and m.role in ('attendee', 'to')
       and not e.automated
       and d.owner in (${layerClause(layers, 1)})${dateFilter}`,
    params
  );
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.entity)) {
      by.set(r.entity, { entity: r.entity, name: r.name, org: (typeof r.orgs === "string" ? JSON.parse(r.orgs) : r.orgs)?.[0] ?? null,
        attended: 0, rsvp: 0, declined: 0, invited: 0, events: 0, lastEvent: null, lastAttended: null, attendedBefore: 0, attendedAfter: 0, contactedAfter: 0, recent: [] });
    }
    const g = by.get(r.entity);
    g[r.tier] = (g[r.tier] ?? 0) + 1;
    g.events++;
    if (r.date && (!g.lastEvent || r.date > g.lastEvent)) g.lastEvent = r.date;
    if (r.tier === "attended") {
      if (r.date && (!g.lastAttended || r.date > g.lastAttended)) g.lastAttended = r.date;
      if (since && r.date && r.date < since) g.attendedBefore++;
      if (since && r.date && r.date >= since) g.attendedAfter++;
    }
    if (since && r.date && r.date >= since) g.contactedAfter++;
    if (g.recent.length < 3 && r.tier === "attended") g.recent.push(`${r.event}`);
  }
  let list = [...by.values()];
  if (!includeHosts) {
    // A host appears as a guest only when someone put them on a list; keep
    // them out of league tables unless asked.
    const hostNames = new Set(await hostNamesOf(db));
    list = list.filter((g) => !(g.name && hostNames.has(g.name)));
  }
  for (const g of list) g.showRate = g.events ? Number((g.attended / g.events).toFixed(2)) : 0;
  const key = {
    most_attended: (g) => g.attended >= Math.max(1, minEvents),
    never_attended: (g) => g.attended === 0 && g.events >= Math.max(2, minEvents),
    most_invited: (g) => g.events >= Math.max(1, minEvents),
    lapsed: (g) => g.attendedBefore >= Math.max(1, minEvents) && g.attendedAfter === 0,
    best_show_rate: (g) => g.events >= Math.max(2, minEvents) && g.attended > 0,
  }[sort];
  if (!key) throw new Error(`unknown sort "${sort}" — use most_attended, never_attended, most_invited, lapsed or best_show_rate`);
  const cmp = {
    most_attended: (a, b) => b.attended - a.attended || b.events - a.events || cmpDate(b.lastAttended, a.lastAttended),
    never_attended: (a, b) => b.events - a.events || cmpDate(b.lastEvent, a.lastEvent),
    most_invited: (a, b) => b.events - a.events || b.attended - a.attended,
    lapsed: (a, b) => b.attendedBefore - a.attendedBefore || cmpDate(b.lastAttended, a.lastAttended),
    best_show_rate: (a, b) => b.showRate - a.showRate || b.attended - a.attended,
  }[sort];
  if (sort === "lapsed" && !since) throw new Error("lapsed needs `since` (YYYY-MM-DD): attended before it, nothing after");
  list = list.filter(key).sort(cmp).slice(0, limit);
  for (const g of list) {
    delete g.attendedBefore; delete g.attendedAfter; delete g.contactedAfter;
    if (!g.recent.length) delete g.recent;
  }
  return { sort, since, until, minEvents, guests: list };
}

function cmpDate(a, b) {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return a < b ? -1 : 1;
}

/** Host names are learned from the documents themselves (raw.host.name). */
export async function hostNamesOf(db) {
  const { rows } = await db.query(
    `select distinct d.raw->'host'->>'name' as name from documents d where d.raw->'host'->>'name' is not null`
  );
  return rows.map((r) => r.name).filter(Boolean);
}
