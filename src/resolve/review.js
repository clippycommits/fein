import { normOrgName } from "./normalize.js";
import { createEntityFromMention } from "./pipeline.js";

export async function listReviews(db) {
  const { rows } = await db.query(
    `select r.id, r.score, r.detail, r.status,
            m.name as mention_name, m.email as mention_email, m.org_hint,
            e.canonical_name as candidate_name, e.id as candidate_id,
            d.title as doc_title, d.source as doc_source
     from review_queue r
     join mentions m on m.id = r.mention_id
     join entities e on e.id = r.candidate_entity_id
     join documents d on d.id = m.document_id
     where r.status = 'pending'
     order by r.score desc`
  );
  return rows.map((r) => ({
    ...r,
    detail: typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail,
  }));
}

/** accept: mention belongs to the candidate entity. reject: it's a new entity. */
export async function resolveReview(db, reviewId, decision) {
  const { rows } = await db.query(
    `select r.*, m.* , m.id as mention_id_real
     from review_queue r join mentions m on m.id = r.mention_id
     where r.id = $1 and r.status = 'pending'`,
    [reviewId]
  );
  if (!rows.length) throw new Error(`no pending review ${reviewId}`);
  const row = rows[0];
  const mention = { ...row, id: row.mention_id_real };

  if (decision === "accept") {
    const { rows: ents } = await db.query(`select * from entities where id = $1`, [row.candidate_entity_id]);
    const e = ents[0];
    const emails = typeof e.emails === "string" ? JSON.parse(e.emails) : e.emails;
    const orgs = typeof e.orgs === "string" ? JSON.parse(e.orgs) : e.orgs;
    if (mention.norm_email && !emails.includes(mention.norm_email)) emails.push(mention.norm_email);
    const mOrg = normOrgName(mention.org_hint);
    if (mOrg && !orgs.includes(mOrg)) orgs.push(mOrg);
    await db.query(`update entities set emails = $2, orgs = $3 where id = $1`,
      [e.id, JSON.stringify(emails), JSON.stringify(orgs)]);
    await db.query(`update mentions set entity_id = $2 where id = $1`, [mention.id, e.id]);
  } else if (decision === "reject") {
    const entity = await createEntityFromMention(db, null, mention);
    await db.query(`update mentions set entity_id = $2 where id = $1`, [mention.id, entity.id]);
  } else {
    throw new Error(`decision must be accept or reject, got: ${decision}`);
  }
  await db.query(`update review_queue set status = $2 where id = $1`,
    [reviewId, decision === "accept" ? "accepted" : "rejected"]);
  return { reviewId, decision };
}
