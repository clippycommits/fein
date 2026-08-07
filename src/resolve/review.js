import { normOrgName } from "./normalize.js";
import { addEvidence, createEntityFromMention, promoteEvidence } from "./pipeline.js";
import { audit } from "../settings.js";
import { visibleLayers } from "../members.js";

/**
 * Review cards quote the document a mention came from — its title, and for
 * extracted mentions a verbatim snippet of its body. That is private content,
 * so the queue is scoped to the viewer's layers like every other read.
 */
export async function listReviews(db, { viewer = null } = {}) {
  const layers = visibleLayers(viewer);
  const lph = layers.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await db.query(
    `select r.id, r.score, r.detail, r.status,
            m.name as mention_name, m.email as mention_email, m.org_hint,
            m.origin as mention_origin, m.context as mention_context,
            e.canonical_name as candidate_name, e.id as candidate_id,
            d.title as doc_title, d.source as doc_source
     from review_queue r
     join mentions m on m.id = r.mention_id
     join entities e on e.id = r.candidate_entity_id
     join documents d on d.id = m.document_id
     where r.status = 'pending' and d.owner in (${lph})
     order by r.score desc`,
    layers
  );
  return rows.map((r) => ({
    ...r,
    detail: typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail,
  }));
}

/** accept: mention belongs to the candidate entity. reject: it's a new entity.
 * Called with the real db handle or a transaction wrapper — assume only .query. */
export async function resolveReview(db, reviewId, decision, { actor = "local" } = {}) {
  const { rows } = await db.query(
    `select r.*, m.* , m.id as mention_id_real, d.owner as doc_owner
     from review_queue r
     join mentions m on m.id = r.mention_id
     join documents d on d.id = m.document_id
     where r.id = $1 and r.status = 'pending'`,
    [reviewId]
  );
  if (!rows.length) throw new Error(`no pending review ${reviewId}`);
  const row = rows[0];
  const mention = { ...row, id: row.mention_id_real };
  const owner = row.doc_owner ?? "";

  let entityId; // the entity whose evidence changed — callers refresh its edges
  if (decision === "accept") {
    const { rows: ents } = await db.query(`select * from entities where id = $1`, [row.candidate_entity_id]);
    const e = ents[0];
    const emails = typeof e.emails === "string" ? JSON.parse(e.emails) : e.emails;
    const orgs = typeof e.orgs === "string" ? JSON.parse(e.orgs) : e.orgs;
    const aliases = typeof e.aliases === "string" ? JSON.parse(e.aliases) : e.aliases;
    const mOrg = normOrgName(mention.org_hint);
    if (owner === "") {
      // First shared witness of a previously private-only candidate: the name
      // on its row was witnessed only privately and is about to become visible
      // to everyone — re-derive it from the shared mention (absorb()'s rule).
      const firstSharedWitness = !emails.length && !orgs.length && !aliases.length;
      const canonical = firstSharedWitness && (mention.name || mention.email)
        ? mention.name ?? mention.email : e.canonical_name;
      if (mention.norm_email && !emails.includes(mention.norm_email)) emails.push(mention.norm_email);
      if (mOrg && !orgs.includes(mOrg)) orgs.push(mOrg);
      if (mention.norm_name && !aliases.includes(mention.norm_name)) aliases.push(mention.norm_name);
      await db.query(`update entities set emails = $2, orgs = $3, aliases = $4, canonical_name = $5 where id = $1`,
        [e.id, JSON.stringify(emails), JSON.stringify(orgs), JSON.stringify(aliases), canonical]);
      await db.query(`update mentions set entity_id = $2 where id = $1`, [mention.id, e.id]);
      await promoteEvidence(db, e.id,
        [["email", mention.norm_email], ["org", mOrg], ["alias", mention.norm_name]]);
    } else {
      // The decision is human, but the evidence was witnessed privately: it
      // stays in the owner's overlay, never in the shared columns.
      for (const [kind, value, shared] of [
        ["email", mention.norm_email, emails],
        ["org", mOrg, orgs],
        ["alias", mention.norm_name, aliases],
      ]) {
        if (value && !shared.includes(value)) await addEvidence(db, e.id, owner, kind, value);
      }
      await db.query(`update mentions set entity_id = $2 where id = $1`, [mention.id, e.id]);
    }
    entityId = e.id;
  } else if (decision === "reject") {
    const entity = await createEntityFromMention(db, null, mention, owner);
    await db.query(`update mentions set entity_id = $2 where id = $1`, [mention.id, entity.id]);
    entityId = entity.id;
  } else {
    throw new Error(`decision must be accept or reject, got: ${decision}`);
  }
  await db.query(`update review_queue set status = $2 where id = $1`,
    [reviewId, decision === "accept" ? "accepted" : "rejected"]);
  // The audit trail is readable by every viewer, and the mention text can
  // quote a private document — record ids only: existence, not evidence.
  await audit(db, `review_${decision}`, {
    review: reviewId,
    mention: mention.id,
    candidate: row.candidate_entity_id,
    score: row.score,
  }, actor);
  return { reviewId, decision, entity: entityId };
}
