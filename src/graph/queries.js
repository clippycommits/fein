import { strongestConnections } from "./paths.js";
import { visibleLayers } from "../members.js";

export async function searchEntities(db, query, limit = 10) {
  const q = `%${query.toLowerCase()}%`;
  const { rows } = await db.query(
    `select id, kind, canonical_name, emails, orgs, aliases from entities
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

/**
 * Pre-meeting-brief building block: profile + top connections + recent docs.
 * Scoped to the viewer's layers — another member's private documents are not
 * listed, and their evidence is not in the connection strengths.
 */
export async function entityBrief(db, entityId, { viewer = null } = {}) {
  const entity = await getEntity(db, entityId);
  if (!entity) return null;

  const connections = await strongestConnections(db, entityId, { viewer, limit: 10 });
  for (const c of connections) {
    const e = await getEntity(db, c.entity);
    c.name = e?.canonical_name ?? c.entity;
  }

  const layers = visibleLayers(viewer);
  const ph = layers.map((_, i) => `$${i + 2}`).join(", ");
  const { rows: docs } = await db.query(
    `select distinct d.id, d.source, d.kind, d.title, d.occurred_at from documents d
     join mentions m on m.document_id = d.id
     where m.entity_id = $1 and d.owner in (${ph})
     order by d.occurred_at desc nulls last limit 10`,
    [entityId, ...layers]
  );

  // How much is being withheld: the count is shared, the content is not.
  const { rows: withheld } = await db.query(
    `select count(distinct d.id) as n from documents d
     join mentions m on m.document_id = d.id
     where m.entity_id = $1 and d.owner <> '' and d.owner not in (${ph})`,
    [entityId, ...layers]
  );

  // Fund memory: for an org, surface every deal signal recorded about it.
  // Linked at query time via normalized aliases, so rebuilds can't orphan it.
  let deals;
  if (entity.kind === "org") {
    const aliases = [...new Set([...(entity.aliases ?? [])].filter(Boolean))];
    if (aliases.length) {
      const aph = aliases.map((_, i) => `$${i + 1}`).join(", ");
      const lph = layers.map((_, i) => `$${aliases.length + i + 1}`).join(", ");
      ({ rows: deals } = await db.query(
        `select d.company, d.stage, d.status, d.summary, d.confidence, d.context,
                doc.title as document_title, doc.source as document_source, doc.occurred_at
         from deals d join documents doc on doc.id = d.document_id
         where d.company_norm in (${aph}) and doc.owner in (${lph})
         order by doc.occurred_at desc nulls last`,
        [...aliases, ...layers]
      ));
    }
  }
  const hidden = Number(withheld[0].n);
  return {
    entity,
    connections,
    recentDocuments: docs,
    ...(deals?.length ? { deals } : {}),
    ...(hidden ? { withheldDocuments: hidden } : {}),
  };
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
    // Bodies nobody has mined yet — agents see this via graph_stats and can
    // suggest running extraction. Same definition as extractionStats().pending:
    // hash column only (no body detoast), exhausted failures excluded.
    pendingExtraction: await one(
      `select count(*) as n from documents d
       where d.body_sha256 is not null
         and not exists (select 1 from extractions e where e.document_id = d.id
                         and (e.status = 'ok' or (e.status = 'failed' and e.attempts >= 3)))`
    ),
  };
}

function parseEntity(r) {
  const parsed = { ...r };
  for (const col of ["emails", "orgs", "aliases"]) {
    if (typeof parsed[col] === "string") parsed[col] = JSON.parse(parsed[col]);
  }
  return parsed;
}
