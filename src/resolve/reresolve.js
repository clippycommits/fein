import { resolveMentions } from "./pipeline.js";
import { resolveReview } from "./review.js";
import { rebuildEdges } from "../graph/edges.js";
import { audit } from "../settings.js";

/**
 * Wipe derived state and re-run resolution from raw mentions. Human review
 * decisions are input, not derived state: they are snapshotted by identity
 * (entity ids do not survive the wipe) and replayed against the re-queued
 * questions afterwards.
 */
export async function reresolveAll(db) {
  const { rows: decided } = await db.query(
    `select r.status, m.norm_name, m.norm_email, e.canonical_name as cand_name
     from review_queue r
     join mentions m on m.id = r.mention_id
     join entities e on e.id = r.candidate_entity_id
     where r.status in ('accepted', 'rejected')`
  );

  await db.query(`delete from review_queue`);
  await db.query(`update mentions set entity_id = null`);
  await db.query(`delete from entities`);
  await db.query(`delete from edges`);
  const resolved = await resolveMentions(db);

  let replayed = 0;
  for (const d of decided) {
    // Match on candidate canonical name too, so a decision is not replayed
    // onto a different entity if scoring has changed since.
    const { rows } = await db.query(
      `select r.id from review_queue r
       join mentions m on m.id = r.mention_id
       join entities e on e.id = r.candidate_entity_id
       where r.status = 'pending'
         and m.norm_name is not distinct from $1
         and m.norm_email is not distinct from $2
         and e.canonical_name = $3
       limit 1`,
      [d.norm_name, d.norm_email, d.cand_name]
    );
    if (rows.length) {
      await resolveReview(db, rows[0].id, d.status === "accepted" ? "accept" : "reject");
      replayed++;
    }
  }
  // Replayed accepts teach the entities new emails/aliases — give remaining
  // unresolved mentions one more pass to attach with that knowledge.
  if (replayed) await resolveMentions(db);

  const edges = await rebuildEdges(db);
  await audit(db, "reresolve", { decisions: decided.length, replayed });
  return { resolved, replayed, edges };
}
