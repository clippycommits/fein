import { visibleLayers } from "../members.js";
import { PREDICATES } from "./vocab.js";

/**
 * Reading temporal facts. Two query shapes carry the whole product promise:
 * what is true now, and what was true on a given day. The second is one
 * predicate away from the first, which is the point of storing validity
 * windows instead of overwriting rows.
 *
 * Layer scoping mirrors deals and entityBrief exactly — facts are evidence and
 * are never served across privacy layers.
 */

const SELECT = `select f.id, f.subject, f.subject_norm, f.predicate, f.object, f.value,
                       f.valid_at, f.invalid_at, f.created_at, f.confidence, f.quote,
                       f.invalidated_by, f.document_id,
                       d.title as document_title, d.source as document_source,
                       d.occurred_at as document_occurred_at`;

function decorate(rows) {
  return rows.map((r) => ({ ...r, label: PREDICATES[r.predicate]?.label ?? r.predicate }));
}

/** Facts true today. */
export async function liveFacts(db, subjectNorms, { viewer = null } = {}) {
  const subs = [].concat(subjectNorms).filter(Boolean);
  if (!subs.length) return [];
  const layers = visibleLayers(viewer);
  const sp = subs.map((_, i) => `$${i + 1}`).join(",");
  const lp = layers.map((_, i) => `$${subs.length + i + 1}`).join(",");
  const { rows } = await db.query(
    `${SELECT}
       from facts f join documents d on d.id = f.document_id
      where f.subject_norm in (${sp}) and f.owner in (${lp})
        and f.invalid_at is null and f.expired_at is null
      order by f.valid_at asc, f.created_at asc`,
    [...subs, ...layers]
  );
  return decorate(rows);
}

/** Facts that have been retired, newest retirement first. Kept, never deleted. */
export async function retiredFacts(db, subjectNorms, { viewer = null } = {}) {
  const subs = [].concat(subjectNorms).filter(Boolean);
  if (!subs.length) return [];
  const layers = visibleLayers(viewer);
  const sp = subs.map((_, i) => `$${i + 1}`).join(",");
  const lp = layers.map((_, i) => `$${subs.length + i + 1}`).join(",");
  const { rows } = await db.query(
    `${SELECT}
       from facts f join documents d on d.id = f.document_id
      where f.subject_norm in (${sp}) and f.owner in (${lp})
        and f.invalid_at is not null and f.expired_at is null
      order by f.invalid_at desc`,
    [...subs, ...layers]
  );
  return decorate(rows);
}

/**
 * What was true on a given day — the "day you passed" query. A fact counts if
 * its validity window contains the instant: it had started, and had not yet
 * been closed.
 */
export async function factsAsOf(db, subjectNorms, asOf, { viewer = null } = {}) {
  const subs = [].concat(subjectNorms).filter(Boolean);
  if (!subs.length) return [];
  const layers = visibleLayers(viewer);
  const sp = subs.map((_, i) => `$${i + 1}`).join(",");
  const lp = layers.map((_, i) => `$${subs.length + i + 1}`).join(",");
  const at = `$${subs.length + layers.length + 1}`;
  const { rows } = await db.query(
    `${SELECT}
       from facts f join documents d on d.id = f.document_id
      where f.subject_norm in (${sp}) and f.owner in (${lp})
        and f.expired_at is null
        and f.valid_at <= ${at}
        and (f.invalid_at is null or f.invalid_at > ${at})
      order by f.valid_at asc`,
    [...subs, ...layers, asOf]
  );
  return decorate(rows);
}

/**
 * The full validity timeline for one attribute, oldest first — the audit view.
 * Includes retired windows, because showing only what survived is exactly the
 * thing a CRM already does badly.
 */
export async function factHistory(db, subjectNorms, predicate, { viewer = null } = {}) {
  const subs = [].concat(subjectNorms).filter(Boolean);
  if (!subs.length) return [];
  const layers = visibleLayers(viewer);
  const sp = subs.map((_, i) => `$${i + 1}`).join(",");
  const lp = layers.map((_, i) => `$${subs.length + i + 1}`).join(",");
  const pi = `$${subs.length + layers.length + 1}`;
  const { rows } = await db.query(
    `${SELECT}
       from facts f join documents d on d.id = f.document_id
      where f.subject_norm in (${sp}) and f.owner in (${lp})
        and f.expired_at is null and f.predicate = ${pi}
      order by f.valid_at asc, f.created_at asc`,
    [...subs, ...layers, predicate]
  );
  return decorate(rows);
}

/**
 * What changed in a window: facts that started being true, and facts that
 * stopped. This is the standing-brief query — the thing a partner runs on
 * Monday morning — so it reports the document behind each change, not just
 * the change.
 */
export async function whatChanged(db, subjectNorms, since, { viewer = null, until = null } = {}) {
  const subs = [].concat(subjectNorms).filter(Boolean);
  if (!subs.length) return { written: [], retired: [] };
  const layers = visibleLayers(viewer);
  const sp = subs.map((_, i) => `$${i + 1}`).join(",");
  const lp = layers.map((_, i) => `$${subs.length + i + 1}`).join(",");
  const s = `$${subs.length + layers.length + 1}`;
  const u = `$${subs.length + layers.length + 2}`;
  // 'infinity' is the timestamptz idiom for an open upper bound. JS's max Date
  // serializes to year 275760, which Postgres rejects outright.
  const args = [...subs, ...layers, since, until ?? "infinity"];

  const { rows: written } = await db.query(
    `${SELECT}
       from facts f join documents d on d.id = f.document_id
      where f.subject_norm in (${sp}) and f.owner in (${lp}) and f.expired_at is null
        and f.valid_at > ${s} and f.valid_at <= ${u}
      order by f.valid_at asc`,
    args
  );
  const { rows: retired } = await db.query(
    `${SELECT}
       from facts f join documents d on d.id = f.document_id
      where f.subject_norm in (${sp}) and f.owner in (${lp}) and f.expired_at is null
        and f.invalid_at > ${s} and f.invalid_at <= ${u}
      order by f.invalid_at asc`,
    args
  );
  return { written: decorate(written), retired: decorate(retired) };
}

/** Counts for the dashboard header and company_memory summary. */
export async function factStats(db, subjectNorms, { viewer = null } = {}) {
  const subs = [].concat(subjectNorms).filter(Boolean);
  if (!subs.length) return { total: 0, live: 0, retired: 0 };
  const layers = visibleLayers(viewer);
  const sp = subs.map((_, i) => `$${i + 1}`).join(",");
  const lp = layers.map((_, i) => `$${subs.length + i + 1}`).join(",");
  const { rows } = await db.query(
    `select count(*)::int as total,
            count(*) filter (where invalid_at is null)::int as live,
            count(*) filter (where invalid_at is not null)::int as retired
       from facts
      where subject_norm in (${sp}) and owner in (${lp}) and expired_at is null`,
    [...subs, ...layers]
  );
  return rows[0] ?? { total: 0, live: 0, retired: 0 };
}
