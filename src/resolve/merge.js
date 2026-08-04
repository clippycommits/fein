import { normPersonName, normOrgName } from "./normalize.js";
import { audit } from "../settings.js";

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

export async function mergeEntities(db, keepId, loseId) {
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
    const aliases = [...new Set([
      ...arr(keep.aliases), ...arr(lose.aliases),
      norm(keep.canonical_name), norm(lose.canonical_name),
    ].filter(Boolean))];
    // Keep the fuller display name; an email-derived one always loses.
    const keepIsEmail = keep.canonical_name.includes("@");
    const loseIsEmail = lose.canonical_name.includes("@");
    const canonical = keepIsEmail && !loseIsEmail ? lose.canonical_name
      : !keepIsEmail && loseIsEmail ? keep.canonical_name
      : lose.canonical_name.length > keep.canonical_name.length ? lose.canonical_name
      : keep.canonical_name;

    // Exactly what the survivor gained, so unmerge can give it back.
    const delta = {
      emails: emails.filter((x) => !keepEmails.includes(x)),
      orgs: orgs.filter((x) => !keepOrgs.includes(x)),
      aliases: aliases.filter((x) => !keepAliases.includes(x)),
      canonical_name: canonical === keep.canonical_name ? null : keep.canonical_name,
    };
    await tx.query(
      `update entities set canonical_name = $2, emails = $3, orgs = $4, aliases = $5 where id = $1`,
      [keepId, canonical, JSON.stringify(emails), JSON.stringify(orgs), JSON.stringify(aliases)]
    );
    await tx.query(`update mentions set entity_id = $1 where entity_id = $2`, [keepId, loseId]);
    await tx.query(`update review_queue set candidate_entity_id = $1 where candidate_entity_id = $2`,
      [keepId, loseId]);
    // Tombstone rather than delete: keeps the merge reversible and any stray
    // reference resolvable.
    await tx.query(`update entities set merged_into = $1, merge_delta = $3 where id = $2`,
      [keepId, loseId, JSON.stringify(delta)]);
    return { keptId: keepId, mergedId: loseId, canonical_name: canonical, emails, orgs };
  });

  await audit(db, "entity_merge", {
    kept: result.keptId, merged: result.mergedId, name: result.canonical_name,
  });
  return result;
}

/** Reverse a merge: the tombstone comes back, taking its own mentions with it. */
export async function unmergeEntity(db, mergedId) {
  const result = await db.tx(async (tx) => {
    const { rows } = await tx.query(`select * from entities where id = $1`, [mergedId]);
    const lose = rows[0];
    if (!lose) throw new Error(`no entity ${mergedId}`);
    if (!lose.merged_into) throw new Error(`${mergedId} is not merged into anything`);

    // Mentions matching this entity's own identity go back to it.
    const emails = arr(lose.emails);
    const aliases = arr(lose.aliases);
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
    // Take back exactly what the merge gave the survivor: leaving its emails
    // behind would let it keep claiming an address it no longer owns, and
    // future mentions of that address would resolve to the wrong person.
    const delta = typeof lose.merge_delta === "string" ? JSON.parse(lose.merge_delta) : lose.merge_delta;
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
    }
    await tx.query(`update entities set merged_into = null, merge_delta = null where id = $1`, [mergedId]);
    return { restored: mergedId, from: lose.merged_into, name: lose.canonical_name };
  });
  await audit(db, "entity_unmerge", result);
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
 * state and must not be silently lost.
 */
export async function snapshotMerges(db) {
  const merges = await listMerges(db);
  const { rows: keptRows } = await db.query(
    `select id, emails, aliases from entities where id in (
       select merged_into from entities where merged_into is not null)`
  );
  const keptById = new Map(keptRows.map((r) => [r.id, { emails: arr(r.emails), aliases: arr(r.aliases) }]));
  return merges.map((m) => ({
    loser: { emails: m.merged_emails, aliases: m.merged_aliases, name: m.merged_name },
    keeper: keptById.get(m.kept_id) ?? { emails: [], aliases: [] },
    keeperName: m.kept_name,
  }));
}

/** Re-apply snapshotted merges after a rebuild, matching on stable identity. */
export async function replayMerges(db, snapshot) {
  let replayed = 0;
  const dropped = [];
  for (const m of snapshot) {
    const find = async (ident) => {
      const conds = [];
      const params = [];
      if (ident.emails?.length) {
        conds.push(`exists (select 1 from jsonb_array_elements_text(emails) x where x in (${
          ident.emails.map((_, i) => `$${params.length + i + 1}`).join(", ")}))`);
        params.push(...ident.emails);
      }
      if (ident.aliases?.length) {
        conds.push(`exists (select 1 from jsonb_array_elements_text(aliases) y where y in (${
          ident.aliases.map((_, i) => `$${params.length + i + 1}`).join(", ")}))`);
        params.push(...ident.aliases);
      }
      if (!conds.length) return null;
      const { rows } = await db.query(
        `select id from entities where merged_into is null and (${conds.join(" or ")}) limit 1`, params
      );
      return rows[0]?.id ?? null;
    };
    const keeper = await find(m.keeper);
    const loser = await find(m.loser);
    if (keeper && loser && keeper !== loser) {
      await mergeEntities(db, keeper, loser);
      replayed++;
    } else if (!keeper || !loser) {
      dropped.push({ keeper: m.keeperName, loser: m.loser.name, reason: "identity not found after rebuild" });
    }
    // keeper === loser means resolution already merged them: nothing to do.
  }
  return { replayed, dropped };
}
