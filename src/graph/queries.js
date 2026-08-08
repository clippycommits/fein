import { strongestConnections } from "./paths.js";
import { visibleLayers } from "../members.js";
import { getSettings } from "../settings.js";

export async function searchEntities(db, query, limit = 10, { viewer = null, after = null } = {}) {
  const q = `%${query.toLowerCase()}%`;
  const { privateEntityVisibility } = await getSettings(db);
  const layers = visibleLayers(viewer);
  const params = [q, limit];
  // The shared columns hold only shared-witnessed values, so the LIKEs below
  // cannot surface another member's private address — the owner still finds
  // their own through this side-table clause.
  let evMatch = "";
  if (viewer) {
    params.push(viewer);
    evMatch = ` or exists (
         select 1 from entity_evidence ev
         where ev.entity_id = entities.id and ev.owner = $${params.length}
           and lower(ev.value) like $1)`;
  }
  // Under the default "hide" policy an entity whose every mention lives in a
  // layer the viewer can't see is invisible: the NAME itself can be the secret.
  let gate = "";
  if (privateEntityVisibility !== "reveal") {
    const base = params.length;
    gate = `
       and exists (
         select 1 from mentions mm join documents dd on dd.id = mm.document_id
         where mm.entity_id = entities.id and dd.owner in (${layers.map((_, i) => `$${base + i + 1}`).join(", ")})
       )`;
    params.push(...layers);
  }
  // Optional keyset bound: resume strictly after the (canonical_name, id) tuple
  // of the previous page's last row. Off by default, so every existing caller
  // is unchanged; the only visible difference is a deterministic id tie-break
  // in the ORDER BY below. Scoping stays entirely in the clauses above — the
  // cursor carries position, never a layer.
  let afterClause = "";
  if (after && after.name != null && after.id != null) {
    const base = params.length;
    afterClause = ` and (canonical_name, id) > ($${base + 1}, $${base + 2})`;
    params.push(after.name, after.id);
  }
  const { rows } = await db.query(
    `select id, kind, canonical_name, emails, orgs, aliases from entities
     where merged_into is null
       and (lower(canonical_name) like $1 or lower(emails::text) like $1 or lower(orgs::text) like $1${evMatch})
       ${gate}${afterClause}
     order by canonical_name, id limit $2`,
    params
  );
  return overlayEvidence(db, rows.map(parseEntity), viewer);
}

/**
 * Overlay the viewer's private evidence onto entity records at read time.
 * The shared row never carries what only a private layer witnessed, so every
 * other viewer gets the row exactly as stored — this is the read half of the
 * absorption policy (the write half lives in resolve/pipeline.js).
 */
async function overlayEvidence(db, entities, viewer) {
  if (!viewer || !entities.length) return entities;
  const ph = entities.map((_, i) => `$${i + 2}`).join(", ");
  const { rows } = await db.query(
    `select entity_id, kind, value from entity_evidence
     where owner = $1 and entity_id in (${ph})`,
    [viewer, ...entities.map((e) => e.id)]
  );
  const cols = { email: "emails", org: "orgs", alias: "aliases" };
  const byId = new Map(entities.map((e) => [e.id, e]));
  for (const r of rows) {
    const e = byId.get(r.entity_id);
    const col = cols[r.kind];
    if (e && col && !e[col].includes(r.value)) e[col].push(r.value);
  }
  return entities;
}

export async function getEntity(db, entityId, { viewer = null } = {}) {
  const { rows } = await db.query(`select * from entities where id = $1`, [entityId]);
  if (!rows.length) return null;
  const [entity] = await overlayEvidence(db, [parseEntity(rows[0])], viewer);
  return entity;
}

/**
 * Whether this viewer may see the entity at all under the current
 * privateEntityVisibility policy — the same gate searchEntities applies,
 * usable for a single known id. Guessed or leaked ids must not become a
 * side door around the "hide" policy.
 */
export async function entityVisible(db, entityId, viewer = null) {
  const { privateEntityVisibility } = await getSettings(db);
  if (privateEntityVisibility === "reveal") return true;
  const layers = visibleLayers(viewer);
  const ph = layers.map((_, i) => `$${i + 2}`).join(", ");
  const { rows } = await db.query(
    `select 1 from mentions m join documents d on d.id = m.document_id
     where m.entity_id = $1 and d.owner in (${ph}) limit 1`,
    [entityId, ...layers]
  );
  return rows.length > 0;
}

/** Resolve a name/email/id string to a single entity, or explain the ambiguity.
 * Viewer-scoped: an entity this viewer can't see doesn't resolve, even by id. */
export async function resolveRef(db, ref, { viewer = null } = {}) {
  const direct = await getEntity(db, ref);
  if (direct && (await entityVisible(db, direct.id, viewer))) return { entity: direct };
  const matches = await searchEntities(db, ref, 5, { viewer });
  if (matches.length === 1) return { entity: matches[0] };
  if (matches.length === 0) return { error: `no entity matching "${ref}"` };
  return {
    error: `ambiguous ref "${ref}"`,
    candidates: matches.map((m) => ({ id: m.id, name: m.canonical_name, orgs: m.orgs })),
  };
}

/**
 * Attach display names to warm-path steps. A private hop's job is to say
 * *who to ask* (via), not who the contact is: an intermediate entity the
 * viewer couldn't otherwise see stays anonymous, and its id is withheld —
 * the id is a lookup key.
 */
export async function nameSteps(db, steps, { viewer = null } = {}) {
  for (const step of steps ?? []) {
    if (step.private && !(await entityVisible(db, step.entity, viewer))) {
      step.name = "(private contact)";
      step.redacted = true;
      delete step.entity;
    } else {
      step.name = (await getEntity(db, step.entity))?.canonical_name ?? step.entity;
    }
  }
  return steps;
}

/**
 * Pre-meeting-brief building block: profile + top connections + recent docs.
 * Scoped to the viewer's layers — another member's private documents are not
 * listed, and their evidence is not in the connection strengths.
 */
export async function entityBrief(db, entityId, { viewer = null } = {}) {
  // Overlaid for the viewer: a privately-learned alias below still links
  // deals for its owner, and the emails/orgs arrays show their own evidence.
  const entity = await getEntity(db, entityId, { viewer });
  if (!entity) return null;
  // A raw id must not bypass the visibility policy the search gate enforces.
  if (!(await entityVisible(db, entity.id, viewer))) return null;

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

/**
 * Stat counts, scoped to the viewer's layers like every other read: a null
 * viewer means the shared layer only, never global totals. withheldDocuments
 * hints at hidden volume without leaking it (documentsPayload's pattern).
 */
export async function counts(db, { viewer = null } = {}) {
  const { privateEntityVisibility } = await getSettings(db);
  const layers = visibleLayers(viewer);
  const lph = layers.map((_, i) => `$${i + 1}`).join(", ");
  const one = (sql, params = []) => db.query(sql, params).then((r) => Number(r.rows[0].n));
  const [documents, mentions, unresolvedMentions, entities, pendingReviews, edges, withheldDocuments] =
    await Promise.all([
      one(`select count(*) as n from documents where owner in (${lph})`, layers),
      one(`select count(*) as n from mentions m join documents d on d.id = m.document_id
           where d.owner in (${lph})`, layers),
      one(`select count(*) as n from mentions m join documents d on d.id = m.document_id
           where m.entity_id is null and d.owner in (${lph})`, layers),
      // Same gate as searchEntities: under "hide", an entity mentioned only in
      // layers the viewer can't see doesn't exist for them — even as a number.
      privateEntityVisibility === "reveal"
        ? one(`select count(*) as n from entities where merged_into is null`)
        : one(`select count(*) as n from entities
               where merged_into is null
                 and exists (select 1 from mentions mm join documents dd on dd.id = mm.document_id
                             where mm.entity_id = entities.id and dd.owner in (${lph}))`, layers),
      // The COUNT twin of listReviews, so badge === queue length by construction.
      one(`select count(*) as n from review_queue r
           join mentions m on m.id = r.mention_id
           join documents d on d.id = m.document_id
           where r.status = 'pending' and d.owner in (${lph})`, layers),
      // Distinct visible pairs — how every reader collapses per-owner rows.
      one(`select count(*) as n from (select 1 from edges where owner in (${lph}) group by a, b) t`, layers),
      one(`select count(*) as n from documents where owner <> '' and owner not in (${lph})`, layers),
    ]);
  return {
    documents,
    mentions,
    unresolvedMentions,
    entities,
    pendingReviews,
    edges,
    ...(withheldDocuments ? { withheldDocuments } : {}),
    // Bodies nobody has mined yet — agents see this via graph_stats and can
    // suggest running extraction. Same predicate as extractionStats().pending
    // (hash column only, no body detoast, exhausted failures excluded) but
    // scoped to the viewer's layers, so the Data tab's global extraction
    // panel may legitimately show more.
    pendingExtraction: await one(
      `select count(*) as n from documents d
       where d.owner in (${lph})
         and d.body_sha256 is not null
         and not exists (select 1 from extractions e where e.document_id = d.id
                         and (e.status = 'ok' or (e.status = 'failed' and e.attempts >= 3)))`,
      layers
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
