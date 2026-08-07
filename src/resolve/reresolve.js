import { mentionIdentity, resolveMentions } from "./pipeline.js";
import { resolveReview } from "./review.js";
import { rebuildEdges } from "../graph/edges.js";
import { audit } from "../settings.js";
import { snapshotMerges, replayMerges } from "./merge.js";

/**
 * Wipe derived state and re-run resolution from raw mentions. Human review
 * decisions are input, not derived state: they are snapshotted by identity
 * (entity ids do not survive the wipe) and replayed against the re-queued
 * questions afterwards.
 *
 * Decisions can chain: an accepted review teaches the entity an email/alias,
 * and a LATER review question only exists because of that knowledge. So
 * mentions holding a decision are deferred (never finalized as new entities
 * mid-replay) and replay iterates with resolution to a fixpoint; only then
 * are still-undecidable mentions finalized.
 *
 * Snapshot, wipe, resolve, and replay run in ONE transaction: the snapshot
 * lives only in process memory, so a crash mid-rebuild would otherwise leave
 * the database wiped with every human decision lost.
 */
export async function reresolveAll(db, { actor = "local" } = {}) {
  // Manual merges are human input too: snapshot by identity before the wipe.
  const mergeSnapshot = await snapshotMerges(db);
  const outcome = await db.tx(async (tx) => {
    const { rows: decided } = await tx.query(
      `select r.status, m.norm_name, m.norm_email, e.canonical_name as cand_name,
              e.emails as cand_emails, e.aliases as cand_aliases
       from review_queue r
       join mentions m on m.id = r.mention_id
       join entities e on e.id = r.candidate_entity_id
       where r.status in ('accepted', 'rejected')`
    );

    await tx.query(`delete from review_queue`);
    await tx.query(`update mentions set entity_id = null`);
    await tx.query(`delete from entities`);
    await tx.query(`delete from edges`);

    const arr = (v) => (typeof v === "string" ? JSON.parse(v) : v ?? []);
    const identities = (ds) => new Set(ds.map((d) => mentionIdentity(d.norm_name, d.norm_email)));
    const addStats = (into, s) => { for (const k of Object.keys(into)) into[k] += s[k] ?? 0; };

    const resolved = await resolveMentions(tx, { defer: identities(decided) });

    let replayed = 0;
    let remaining = [...decided];
    let progress = remaining.length > 0;
    while (progress) {
      progress = false;
      const next = [];
      for (const d of remaining) {
        // Match the candidate by stable identity, so a decision is not replayed
        // onto a different entity if scoring has changed since. The snapshot's
        // canonical name may be newer than the rebuilt (pre-decision) entity's —
        // post-decision absorbs upgrade display names — so also accept overlap
        // on emails/aliases, which only grow and so contain every earlier form.
        const { rows } = await tx.query(
          `select r.id, e.canonical_name, e.emails, e.aliases
           from review_queue r
           join mentions m on m.id = r.mention_id
           join entities e on e.id = r.candidate_entity_id
           where r.status = 'pending'
             and m.norm_name is not distinct from $1
             and m.norm_email is not distinct from $2`,
          [d.norm_name, d.norm_email]
        );
        const snapEmails = new Set(arr(d.cand_emails));
        const snapAliases = new Set(arr(d.cand_aliases));
        const match = rows.find((r) =>
          r.canonical_name === d.cand_name ||
          arr(r.emails).some((e) => snapEmails.has(e)) ||
          arr(r.aliases).some((a) => snapAliases.has(a))
        );
        if (match) {
          // Replays re-audit each replayed decision under the replaying actor;
          // the original decision's row survives (append-only), so one logical
          // decision shows two actors. Acceptable: both facts are true.
          await resolveReview(tx, match.id, d.status === "accepted" ? "accept" : "reject", { actor });
          replayed++;
          progress = true;
        } else {
          next.push(d);
        }
      }
      remaining = next;
      // Replayed accepts teach the entities new emails/aliases; another pass may
      // attach more mentions or queue the review a chained decision waits for.
      if (progress) addStats(resolved, await resolveMentions(tx, { defer: identities(remaining) }));
    }
    // Fixpoint reached: decisions left in `remaining` have no matching question
    // in the rebuilt world. Stop deferring their mentions and finalize them.
    addStats(resolved, await resolveMentions(tx));
    const dropped = remaining.map((d) => ({
      mention: { norm_name: d.norm_name, norm_email: d.norm_email },
      candidate: d.cand_name, status: d.status,
    }));
    return { resolved, replayed, dropped, decisions: decided.length };
  });

  if (outcome.dropped.length) {
    console.warn(
      `reresolve: ${outcome.dropped.length} review decision(s) could not be replayed:`,
      JSON.stringify(outcome.dropped)
    );
  }
  const merges = await replayMerges(db, mergeSnapshot, { actor });
  if (merges.dropped.length) {
    console.warn(`reresolve: ${merges.dropped.length} manual merge(s) could not be replayed:`,
      JSON.stringify(merges.dropped));
  }
  const edges = await rebuildEdges(db);
  await audit(db, "reresolve", {
    decisions: outcome.decisions,
    replayed: outcome.replayed,
    dropped: outcome.dropped,
    merges,
  }, actor);
  return {
    resolved: outcome.resolved, replayed: outcome.replayed, dropped: outcome.dropped,
    merges, edges,
  };
}
