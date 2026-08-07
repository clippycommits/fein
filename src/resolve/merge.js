import { normPersonName, normOrgName } from "./normalize.js";
import { audit } from "../settings.js";
import { evidenceAgg } from "./pipeline.js";

/**
 * Manual entity merge — the escape hatch for what automatic resolution missed.
 *
 * Resolution is deliberately conservative: conflicting evidence queues for
 * review rather than merging, which means real data always leaves some
 * duplicates ("Alex Rivera" and "alex@northgate.io" as two people). This makes
 * that fixable, and — like review decisions — the fix is human input, so it is
 * recorded durably and replayed after a rebuild rather than being lost.
 *
 * The loser is kept as a tombstone (`merged_into`), never deleted: mention
 * rows keep pointing somewhere real, and the merge stays reversible.
 */

const arr = (v) => (typeof v === "string" ? JSON.parse(v) : v ?? []);

export async function mergeEntities(db, keepId, loseId, { actor = "local" } = {}) {
  if (keepId === loseId) throw new Error("cannot merge an entity into itself");
  const result = await db.tx(async (tx) => {
    const { rows } = await tx.query(
      `select * from entities where id in ($1, $2) and merged_into is null`,
      [keepId, loseId]
    );
    const keep = rows.find((r) => r.id === keepId);
    const lose = rows.find((r) => r.id === loseId);
    if (!keep) throw new Error(`no live entity ${keepId}`);
    if (!lose) throw new Error(`no live entity ${loseId}`);
    if (keep.kind !== lose.kind) {
      throw new Error(`cannot merge a ${lose.kind} into a ${keep.kind}`);
    }

    const keepEmails = arr(keep.emails), keepOrgs = arr(keep.orgs), keepAliases = arr(keep.aliases);
    const emails = [...new Set([...keepEmails, ...arr(lose.emails)])];
    const orgs = [...new Set([...keepOrgs, ...arr(lose.orgs)])];
    const norm = keep.kind === "org" ? normOrgName : normPersonName;
    // An entity whose shared columns are all empty was never witnessed by a
    // shared source: its display name is private evidence, not shared
    // identity. Such a name stays out of the survivor's shared aliases and
    // canonical name — its normalized form already lives in entity_evidence
    // for the owners who witnessed it (createEntityFromMention wrote it), so
    // it keeps matching and overlaying for them.
    const privateOnly = (e) => !arr(e.emails).length && !arr(e.orgs).length && !arr(e.aliases).length;
    const keepPrivate = privateOnly(keep);
    const losePrivate = privateOnly(lose);
    const aliases = [...new Set([
      ...arr(keep.aliases), ...arr(lose.aliases),
      keepPrivate ? null : norm(keep.canonical_name),
      losePrivate ? null : norm(lose.canonical_name),
    ].filter(Boolean))];
    // Keep the fuller display name; an email-derived one always loses. When
    // exactly one side is shared-witnessed, only ITS name may be shown to
    // every viewer — however plain — never the privately-witnessed one.
    const keepIsEmail = keep.canonical_name.includes("@");
    const loseIsEmail = lose.canonical_name.includes("@");
    const canonical = keepPrivate !== losePrivate
      ? (keepPrivate ? lose.canonical_name : keep.canonical_name)
      : keepIsEmail && !loseIsEmail ? lose.canonical_name
      : !keepIsEmail && loseIsEmail ? keep.canonical_name
      : lose.canonical_name.length > keep.canonical_name.length ? lose.canonical_name
      : keep.canonical_name;

    // Exactly what the survivor gained, so unmerge can give it back. Private
    // side rows travel with the merge (the human merged identities, not
    // layers, and the shared columns stay clean); rows the keeper already
    // holds for the same (owner, kind, value) are its own and not in the
    // delta, so unmerge sends back exactly the loser's and no more.
    const { rows: movedEvidence } = await tx.query(
      `select owner, kind, value from entity_evidence l
       where l.entity_id = $2
         and not exists (select 1 from entity_evidence k
                         where k.entity_id = $1 and k.owner = l.owner
                           and k.kind = l.kind and k.value = l.value)`,
      [keepId, loseId]
    );
    const delta = {
      emails: emails.filter((x) => !keepEmails.includes(x)),
      orgs: orgs.filter((x) => !keepOrgs.includes(x)),
      aliases: aliases.filter((x) => !keepAliases.includes(x)),
      canonical_name: canonical === keep.canonical_name ? null : keep.canonical_name,
      evidence: movedEvidence,
    };
    await tx.query(
      `update entities set canonical_name = $2, emails = $3, orgs = $4, aliases = $5 where id = $1`,
      [keepId, canonical, JSON.stringify(emails), JSON.stringify(orgs), JSON.stringify(aliases)]
    );
    // A human's robot/human verdict travels with the merge: left on the
    // tombstone it would be invisible, silently losing human input. The
    // keeper's own pre-merge state goes into the delta so unmerge can hand
    // exactly this back too, like everything else the merge gave.
    if (lose.automated_override != null && keep.automated_override == null) {
      await tx.query(
        `update entities set automated = $2, automated_override = $2, automated_reason = $3
         where id = $1`,
        [keepId, lose.automated_override, lose.automated_reason]
      );
      delta.automatedTransfer = {
        automated: keep.automated,
        automated_override: keep.automated_override,
        automated_reason: keep.automated_reason,
      };
    }
    await tx.query(
      `insert into entity_evidence (entity_id, owner, kind, value)
       select $1::text, owner, kind, value from entity_evidence where entity_id = $2
       on conflict do nothing`,
      [keepId, loseId]
    );
    await tx.query(`delete from entity_evidence where entity_id = $1`, [loseId]);
    await tx.query(`update mentions set entity_id = $1 where entity_id = $2`, [keepId, loseId]);
    await tx.query(`update review_queue set candidate_entity_id = $1 where candidate_entity_id = $2`,
      [keepId, loseId]);
    // Tombstone rather than delete: keeps the merge reversible and any stray
    // reference resolvable.
    await tx.query(`update entities set merged_into = $1, merge_delta = $3 where id = $2`,
      [keepId, loseId, JSON.stringify(delta)]);
    return { keptId: keepId, mergedId: loseId, canonical_name: canonical, emails, orgs };
  });

  // Ids only: the audit trail is a shared surface and a merged name can be
  // witnessed solely in a private layer (review_accept/review_reject's rule).
  await audit(db, "entity_merge", { kept: result.keptId, merged: result.mergedId }, actor);
  return result;
}

/** Reverse a merge: the tombstone comes back, taking its own mentions with it. */
export async function unmergeEntity(db, mergedId, { actor = "local" } = {}) {
  const result = await db.tx(async (tx) => {
    const { rows } = await tx.query(`select * from entities where id = $1`, [mergedId]);
    const lose = rows[0];
    if (!lose) throw new Error(`no entity ${mergedId}`);
    if (!lose.merged_into) throw new Error(`${mergedId} is not merged into anything`);

    const delta = typeof lose.merge_delta === "string" ? JSON.parse(lose.merge_delta) : lose.merge_delta;
    const deltaEv = delta?.evidence ?? [];
    // Mentions matching this entity's own identity go back to it. A privately-
    // evidenced entity's identity lives in its side rows (the shared arrays
    // can be empty), so the values the merge moved over count too.
    const evVals = (kind) => deltaEv.filter((r) => r.kind === kind).map((r) => r.value);
    const emails = [...new Set([...arr(lose.emails), ...evVals("email")])];
    const aliases = [...new Set([...arr(lose.aliases), ...evVals("alias")])];
    const conds = [];
    const params = [lose.merged_into, mergedId];
    if (emails.length) {
      conds.push(`norm_email in (${emails.map((_, i) => `$${params.length + i + 1}`).join(", ")})`);
      params.push(...emails);
    }
    if (aliases.length) {
      conds.push(`norm_name in (${aliases.map((_, i) => `$${params.length + i + 1}`).join(", ")})`);
      params.push(...aliases);
    }
    if (conds.length) {
      await tx.query(
        `update mentions set entity_id = $2 where entity_id = $1 and (${conds.join(" or ")})`,
        params
      );
    }
    // Side rows the merge moved over go back with their entity — stranding a
    // private address on the survivor would keep serving it to its owner
    // against the wrong person.
    for (const r of deltaEv) {
      await tx.query(
        `delete from entity_evidence where entity_id = $1 and owner = $2 and kind = $3 and value = $4`,
        [lose.merged_into, r.owner, r.kind, r.value]
      );
      await tx.query(
        `insert into entity_evidence (entity_id, owner, kind, value)
         values ($1, $2, $3, $4) on conflict do nothing`,
        [mergedId, r.owner, r.kind, r.value]
      );
    }
    // Take back exactly what the merge gave the survivor: leaving its emails
    // behind would let it keep claiming an address it no longer owns, and
    // future mentions of that address would resolve to the wrong person.
    if (delta) {
      const { rows: keepRows } = await tx.query(`select * from entities where id = $1`, [lose.merged_into]);
      const keep = keepRows[0];
      if (keep) {
        const without = (list, remove) => arr(list).filter((x) => !remove.includes(x));
        await tx.query(
          `update entities set emails = $2, orgs = $3, aliases = $4, canonical_name = $5 where id = $1`,
          [keep.id,
           JSON.stringify(without(keep.emails, delta.emails ?? [])),
           JSON.stringify(without(keep.orgs, delta.orgs ?? [])),
           JSON.stringify(without(keep.aliases, delta.aliases ?? [])),
           delta.canonical_name ?? keep.canonical_name]
        );
      }
      // The merge may have copied the loser's robot/human verdict onto the
      // survivor; the survivor's own pre-merge state comes back with the rest.
      if (delta.automatedTransfer) {
        await tx.query(
          `update entities set automated = $2, automated_override = $3, automated_reason = $4
           where id = $1`,
          [lose.merged_into, delta.automatedTransfer.automated,
           delta.automatedTransfer.automated_override ?? null,
           delta.automatedTransfer.automated_reason ?? null]
        );
      }
    }
    await tx.query(`update entities set merged_into = null, merge_delta = null where id = $1`, [mergedId]);
    return { restored: mergedId, from: lose.merged_into, name: lose.canonical_name };
  });
  // Ids only in the audit detail — the restored name can be private evidence.
  await audit(db, "entity_unmerge", { restored: result.restored, from: result.from }, actor);
  return result;
}

/** Merges recorded so far, newest first — the replay list for a rebuild. */
export async function listMerges(db) {
  const { rows } = await db.query(
    `select l.id as merged_id, l.canonical_name as merged_name, l.emails as merged_emails,
            l.aliases as merged_aliases, k.id as kept_id, k.canonical_name as kept_name
     from entities l join entities k on k.id = l.merged_into
     where l.merged_into is not null
     order by l.created_at desc`
  );
  return rows.map((r) => ({ ...r, merged_emails: arr(r.merged_emails), merged_aliases: arr(r.merged_aliases) }));
}

/**
 * Snapshot merges by identity so they survive a full rebuild, which discards
 * entity ids. Same contract as review decisions: human input is not derived
 * state and must not be silently lost. Identity is the union of the shared
 * arrays with what the absorption policy keeps out of them: the keeper's
 * entity_evidence side rows, and — because the merge itself moved the loser's
 * side rows to the keeper — the values recorded in merge_delta.evidence for
 * the loser. The moved values are subtracted from the keeper's identity so
 * the two lookups cannot claim the same rebuilt entity.
 */
export async function snapshotMerges(db) {
  const { rows } = await db.query(
    `select l.emails as merged_emails, l.aliases as merged_aliases, l.merge_delta,
            k.emails || ${evidenceAgg("email", "k.id")} as kept_emails,
            k.aliases || ${evidenceAgg("alias", "k.id")} as kept_aliases
     from entities l join entities k on k.id = l.merged_into
     where l.merged_into is not null
     order by l.created_at desc`
  );
  return rows.map((r) => {
    const delta = typeof r.merge_delta === "string" ? JSON.parse(r.merge_delta) : r.merge_delta;
    const ev = (kind) => (delta?.evidence ?? []).filter((x) => x.kind === kind).map((x) => x.value);
    return {
      loser: {
        emails: [...new Set([...arr(r.merged_emails), ...ev("email")])],
        aliases: [...new Set([...arr(r.merged_aliases), ...ev("alias")])],
      },
      keeper: {
        emails: [...new Set(arr(r.kept_emails))].filter((x) => !ev("email").includes(x)),
        aliases: [...new Set(arr(r.kept_aliases))].filter((x) => !ev("alias").includes(x)),
      },
    };
  });
}

/** Re-apply snapshotted merges after a rebuild, matching on stable identity —
 * the same shared+evidence union the snapshot read. */
export async function replayMerges(db, snapshot, { actor } = {}) {
  let replayed = 0;
  const dropped = [];
  for (const m of snapshot) {
    const find = async (ident) => {
      const conds = [];
      const params = [];
      if (ident.emails?.length) {
        conds.push(`exists (select 1 from jsonb_array_elements_text(e.emails || ${evidenceAgg("email")}) x
          where x in (${ident.emails.map((_, i) => `$${params.length + i + 1}`).join(", ")}))`);
        params.push(...ident.emails);
      }
      if (ident.aliases?.length) {
        conds.push(`exists (select 1 from jsonb_array_elements_text(e.aliases || ${evidenceAgg("alias")}) y
          where y in (${ident.aliases.map((_, i) => `$${params.length + i + 1}`).join(", ")}))`);
        params.push(...ident.aliases);
      }
      if (!conds.length) return null;
      const { rows } = await db.query(
        `select e.id from entities e where e.merged_into is null and (${conds.join(" or ")}) limit 1`, params
      );
      return rows[0]?.id ?? null;
    };
    const keeper = await find(m.keeper);
    const loser = await find(m.loser);
    if (keeper && loser && keeper !== loser) {
      await mergeEntities(db, keeper, loser, { actor });
      replayed++;
    } else if (!keeper || !loser) {
      // Reason only: this list lands in the reresolve audit row, a shared
      // surface, and a merged identity can be privately witnessed.
      dropped.push({ reason: "identity not found after rebuild" });
    }
    // keeper === loser means resolution already merged them: nothing to do.
  }
  return { replayed, dropped };
}
