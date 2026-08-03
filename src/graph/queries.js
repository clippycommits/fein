import { strongestConnections } from "./paths.js";

export async function searchEntities(db, query, limit = 10) {
  const q = `%${query.toLowerCase()}%`;
  const { rows } = await db.query(
    `select id, kind, canonical_name, emails, orgs from entities
     where merged_into is null
       and (lower(canonical_name) like $1 or lower(emails::text) like $1 or lower(orgs::text) like $1)
     order by canonical_name limit $2`,
    [q, limit]
  );
  return rows.map(parseEntity);
}

export async function getEntity(db, entityId) {
  const { rows } = await db.query(`select * from entities where id = $1`, [entityId]);
  return rows.length ? parseEntity(rows[0]) : null;
}

/** Resolve a name/email/id string to a single entity, or explain the ambiguity. */
export async function resolveRef(db, ref) {
  const direct = await getEntity(db, ref);
  if (direct) return { entity: direct };
  const matches = await searchEntities(db, ref, 5);
  if (matches.length === 1) return { entity: matches[0] };
  if (matches.length === 0) return { error: `no entity matching "${ref}"` };
  return {
    error: `ambiguous ref "${ref}"`,
    candidates: matches.map((m) => ({ id: m.id, name: m.canonical_name, orgs: m.orgs })),
  };
}

/** Pre-meeting-brief building block: profile + top connections + recent docs. */
export async function entityBrief(db, entityId) {
  const entity = await getEntity(db, entityId);
  if (!entity) return null;

  const connections = await strongestConnections(db, entityId, 10);
  for (const c of connections) {
    const e = await getEntity(db, c.entity);
    c.name = e?.canonical_name ?? c.entity;
  }

  const { rows: docs } = await db.query(
    `select d.source, d.kind, d.title, d.occurred_at from documents d
     join mentions m on m.document_id = d.id
     where m.entity_id = $1
     order by d.occurred_at desc nulls last limit 10`,
    [entityId]
  );
  return { entity, connections, recentDocuments: docs };
}

export async function counts(db) {
  const one = async (sql) => Number((await db.query(sql)).rows[0].n);
  return {
    documents: await one(`select count(*) as n from documents`),
    mentions: await one(`select count(*) as n from mentions`),
    unresolvedMentions: await one(`select count(*) as n from mentions where entity_id is null`),
    entities: await one(`select count(*) as n from entities where merged_into is null`),
    pendingReviews: await one(`select count(*) as n from review_queue where status = 'pending'`),
    edges: await one(`select count(*) as n from edges`),
  };
}

function parseEntity(r) {
  return {
    ...r,
    emails: typeof r.emails === "string" ? JSON.parse(r.emails) : r.emails,
    orgs: typeof r.orgs === "string" ? JSON.parse(r.orgs) : r.orgs,
  };
}
