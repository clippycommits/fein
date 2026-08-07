import { id } from "../db.js";
import { getSettings } from "../settings.js";
import { blockKeys, jaroWinkler, nameSimilarity, normOrgName } from "./normalize.js";

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com",
  "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com",
]);

class EntityIndex {
  constructor() {
    this.byId = new Map();
    this.byBlock = new Map(); // block key -> Set<entityId>
  }

  add(entity) {
    this.byId.set(entity.id, entity);
    this.reindex(entity);
  }

  reindex(entity) {
    for (const key of this.keysFor(entity)) {
      if (!this.byBlock.has(key)) this.byBlock.set(key, new Set());
      this.byBlock.get(key).add(entity.id);
    }
  }

  keysFor(entity) {
    const keys = new Set();
    for (const email of entity.emails) {
      for (const k of blockKeys({ normEmail: email, kind: entity.kind })) keys.add(k);
    }
    for (const name of entity.normNames) {
      for (const k of blockKeys({ normName: name, kind: entity.kind })) keys.add(k);
    }
    return keys;
  }

  candidates(mention) {
    const found = new Set();
    const keys = blockKeys({
      normName: mention.norm_name,
      normEmail: mention.norm_email,
      kind: mention.kind,
    });
    for (const key of keys) {
      for (const eid of this.byBlock.get(key) ?? []) {
        const e = this.byId.get(eid);
        if (e && e.kind === mention.kind) found.add(e);
      }
    }
    return [...found];
  }
}

function scorePerson(mention, entity) {
  if (mention.norm_email && entity.emails.includes(mention.norm_email)) {
    return { score: 0.98, reason: "exact email match" };
  }
  let best = 0;
  for (const n of entity.normNames) best = Math.max(best, nameSimilarity(mention.norm_name, n));
  // Exact-name fast path: identical normalized names auto-attach — but only
  // when nothing contradicts the match. Same-named strangers are common; a
  // conflicting work domain or org hint drops to the similarity path below
  // (0.90 for an exact name), which lands in the review band.
  const mDomain = mention.norm_email?.split("@")[1];
  const entDomains = entity.emails.map((e) => e.split("@")[1]);
  const domainConflict = mDomain && !FREEMAIL.has(mDomain) &&
    entDomains.some((d) => !FREEMAIL.has(d)) && !entDomains.includes(mDomain);
  const mentionOrg = normOrgName(mention.org_hint);
  const orgConflict = mentionOrg && entity.orgs.length > 0 && !entity.orgs.includes(mentionOrg);
  if (best >= 0.999 && !domainConflict && !orgConflict) {
    return { score: 0.96, reason: "exact name match" };
  }
  let score = 0.9 * best;
  const reasons = [`name similarity ${best.toFixed(2)}`];

  const mOrg = normOrgName(mention.org_hint);
  if (mOrg && entity.orgs.includes(mOrg)) {
    score += 0.08;
    reasons.push("org overlap");
  }
  const domain = mention.norm_email?.split("@")[1];
  if (domain && !FREEMAIL.has(domain) && entity.emails.some((e) => e.endsWith("@" + domain))) {
    score += 0.07;
    reasons.push("shared work domain");
  }
  return { score: Math.min(score, 0.99), reason: reasons.join(", ") };
}

function scoreOrg(mention, entity) {
  let best = 0;
  for (const n of entity.normNames) best = Math.max(best, jaroWinkler(mention.norm_name, n));
  return { score: best >= 0.999 ? 0.97 : best * 0.92, reason: `org name similarity ${best.toFixed(2)}` };
}

async function loadIndex(db) {
  const index = new EntityIndex();
  const { rows } = await db.query(
    `select id, kind, canonical_name, emails, orgs, aliases from entities where merged_into is null`
  );
  // Resolution is a global process, not a read surface: matching must see
  // every witnessed value regardless of layer, so private side rows join the
  // in-memory union. Only the shared* subsets ever get written back.
  const { rows: evidence } = await db.query(`select entity_id, kind, value from entity_evidence`);
  const evByEntity = new Map();
  for (const ev of evidence) {
    if (!evByEntity.has(ev.entity_id)) evByEntity.set(ev.entity_id, []);
    evByEntity.get(ev.entity_id).push(ev);
  }
  for (const r of rows) {
    const sharedEmails = typeof r.emails === "string" ? JSON.parse(r.emails) : r.emails;
    const sharedOrgs = typeof r.orgs === "string" ? JSON.parse(r.orgs) : r.orgs;
    const sharedAliases = typeof r.aliases === "string" ? JSON.parse(r.aliases) : r.aliases;
    const entity = {
      id: r.id,
      kind: r.kind,
      canonical_name: r.canonical_name,
      sharedEmails,
      sharedOrgs,
      sharedAliases,
      emails: [...sharedEmails],
      orgs: [...sharedOrgs],
      normNames: new Set(
        [...sharedAliases,
         r.kind === "org" ? normOrgName(r.canonical_name) : null,
         r.kind === "person" ? mentionNormName(r.canonical_name) : null].filter(Boolean)
      ),
    };
    for (const ev of evByEntity.get(r.id) ?? []) {
      if (ev.kind === "email" && !entity.emails.includes(ev.value)) entity.emails.push(ev.value);
      else if (ev.kind === "org" && !entity.orgs.includes(ev.value)) entity.orgs.push(ev.value);
      else if (ev.kind === "alias") entity.normNames.add(ev.value);
    }
    index.add(entity);
  }
  return index;
}

// entities store display names; re-normalize for matching
import { normPersonName } from "./normalize.js";
function mentionNormName(name) {
  return normPersonName(name);
}

async function persistEntity(db, e) {
  await db.query(
    `update entities set canonical_name = $2, emails = $3, orgs = $4, aliases = $5 where id = $1`,
    [e.id, e.canonical_name, JSON.stringify(e.sharedEmails), JSON.stringify(e.sharedOrgs),
     JSON.stringify(e.sharedAliases)]
  );
}

/** Record a privately-witnessed value against its owner's overlay. */
export async function addEvidence(db, entityId, owner, kind, value) {
  await db.query(
    `insert into entity_evidence (entity_id, owner, kind, value)
     values ($1, $2, $3, $4) on conflict do nothing`,
    [entityId, owner, kind, value]
  );
}

/** A shared witness makes side rows for the same values redundant: shared
 * covers them for every viewer, so the per-owner copies are deleted. */
export async function promoteEvidence(db, entityId, pairs) {
  const vals = pairs.filter(([, v]) => v);
  if (!vals.length) return;
  const conds = vals.map((_, i) => `(kind = $${i * 2 + 2} and value = $${i * 2 + 3})`).join(" or ");
  await db.query(`delete from entity_evidence where entity_id = $1 and (${conds})`,
    [entityId, ...vals.flat()]);
}

/**
 * Fold a mention's evidence into the entity. What the SHARED record learns
 * depends on where the mention was witnessed: a shared-layer mention updates
 * the shared emails/orgs/aliases columns and may upgrade the display name; a
 * private-layer mention's values go to entity_evidence for that owner alone
 * and never touch the shared record or its name. The in-memory union learns
 * everything either way — matching is global, reading is not.
 */
async function absorb(db, entity, mention) {
  const owner = mention.doc_owner ?? "";
  const mOrg = normOrgName(mention.org_hint);
  if (mention.norm_email && !entity.emails.includes(mention.norm_email)) {
    entity.emails.push(mention.norm_email);
  }
  if (mOrg && !entity.orgs.includes(mOrg)) entity.orgs.push(mOrg);
  if (mention.norm_name) entity.normNames.add(mention.norm_name);

  if (owner === "") {
    if (mention.norm_email && !entity.sharedEmails.includes(mention.norm_email)) {
      entity.sharedEmails.push(mention.norm_email);
    }
    if (mOrg && !entity.sharedOrgs.includes(mOrg)) entity.sharedOrgs.push(mOrg);
    if (mention.norm_name) {
      if (!entity.sharedAliases.includes(mention.norm_name)) entity.sharedAliases.push(mention.norm_name);
      // Prefer the fullest observed display name ("M. Chen" -> "Maya Chen"),
      // and any real name over an email-derived one ("tom@x.com" -> "Tom Merrill").
      const current = mentionNormName(entity.canonical_name) ?? "";
      const currentIsEmail = entity.canonical_name.includes("@");
      if (currentIsEmail || mention.norm_name.split(" ").length > current.split(" ").length) {
        entity.canonical_name = mention.name;
      }
    }
    await promoteEvidence(db, entity.id,
      [["email", mention.norm_email], ["org", mOrg], ["alias", mention.norm_name]]);
  } else {
    for (const [kind, value, shared] of [
      ["email", mention.norm_email, entity.sharedEmails],
      ["org", mOrg, entity.sharedOrgs],
      ["alias", mention.norm_name, entity.sharedAliases],
    ]) {
      if (value && !shared.includes(value)) await addEvidence(db, entity.id, owner, kind, value);
    }
  }
}

export async function createEntityFromMention(db, index, mention, owner = "") {
  const mOrg = normOrgName(mention.org_hint);
  const entity = {
    id: id("ent"),
    kind: mention.kind,
    // The name stays on the row even for a private owner: existence, not
    // evidence — under "hide" the entity is invisible to other viewers
    // anyway, and "reveal" shares names by deliberate choice.
    canonical_name: mention.name ?? mention.email ?? "unknown",
    emails: mention.norm_email ? [mention.norm_email] : [],
    orgs: mOrg ? [mOrg] : [],
    normNames: new Set([mention.norm_name].filter(Boolean)),
  };
  const priv = owner !== "";
  entity.sharedEmails = priv ? [] : [...entity.emails];
  entity.sharedOrgs = priv ? [] : [...entity.orgs];
  entity.sharedAliases = priv ? [] : [...entity.normNames];
  await db.query(
    `insert into entities (id, kind, canonical_name, emails, orgs, aliases) values ($1, $2, $3, $4, $5, $6)`,
    [entity.id, entity.kind, entity.canonical_name,
     JSON.stringify(entity.sharedEmails), JSON.stringify(entity.sharedOrgs),
     JSON.stringify(entity.sharedAliases)]
  );
  if (priv) {
    for (const [kind, value] of [
      ["email", mention.norm_email], ["org", mOrg], ["alias", mention.norm_name],
    ]) {
      if (value) await addEvidence(db, entity.id, owner, kind, value);
    }
  }
  if (index) index.add(entity);
  return entity;
}

/** Stable key for "the same person as far as a review decision is concerned". */
export function mentionIdentity(normName, normEmailValue) {
  return `${normName ?? ""} ${normEmailValue ?? ""}`;
}

/**
 * Four stages: blocking -> candidate generation -> probabilistic matching -> review.
 * Deterministic merge at or above the auto-merge threshold; the band between
 * the review floor and it goes to the review queue; below the floor a new
 * entity is created (settings.resolution, defaults 0.95 / 0.70). Order is
 * fixed so runs are reproducible.
 *
 * `defer` holds mention identities carrying a human decision that has not been
 * replayed yet (see reresolve): those must not be finalized as new entities
 * mid-replay, or the decision can never be applied.
 */
export async function resolveMentions(db, { defer } = {}) {
  // One settings read per run, never per mention: the bar must not move
  // mid-run. Needs only db.query, so reresolve's tx wrapper works here too.
  const { resolution } = await getSettings(db);
  const index = await loadIndex(db);
  const { rows: mentions } = await db.query(
    `select m.*, d.owner as doc_owner from mentions m
     join documents d on d.id = m.document_id
     where m.entity_id is null
       and not exists (select 1 from review_queue r
                       where r.mention_id = m.id and r.status = 'pending')
     order by d.occurred_at nulls last, m.id`
  );

  const stats = { attached: 0, created: 0, queued: 0 };
  for (const m of mentions) {
    if (!m.norm_name && !m.norm_email) continue;
    const candidates = index.candidates(m);
    const scored = candidates
      .map((c) => ({ entity: c, ...(m.kind === "person" ? scorePerson(m, c) : scoreOrg(m, c)) }))
      .sort((x, y) => y.score - x.score);
    let best = scored[0] ?? null;
    // Ambiguity guard: if two entities both clear the auto-merge bar (e.g. two
    // distinct "John Smith"s), a human decides — never merge on a coin flip.
    // A UNIQUE exact email match is exempt: the address pins identity even
    // when the display name also matches some other entity. If two entities
    // both hold the email, that is exactly a coin flip — queue it.
    const emailMatches = scored.filter((s) => s.reason === "exact email match").length;
    const ambiguous = scored.length > 1 && scored[1].score >= resolution.autoMerge &&
      (best.reason !== "exact email match" || emailMatches > 1);

    if (best && best.score >= resolution.autoMerge && !ambiguous) {
      await absorb(db, best.entity, m);
      await persistEntity(db, best.entity);
      index.reindex(best.entity);
      await db.query(`update mentions set entity_id = $2 where id = $1`, [m.id, best.entity.id]);
      stats.attached++;
    } else if (best && (best.score >= resolution.review || ambiguous)) {
      // One question per identity, not per mention: skip if an identical
      // pending review (same candidate, same normalized identity) exists.
      const { rows: dupes } = await db.query(
        `select 1 from review_queue r join mentions m2 on m2.id = r.mention_id
         where r.status = 'pending' and r.candidate_entity_id = $1
           and m2.norm_name is not distinct from $2
           and m2.norm_email is not distinct from $3
         limit 1`,
        [best.entity.id, m.norm_name, m.norm_email]
      );
      if (!dupes.length) {
        await db.query(
          `insert into review_queue (id, mention_id, candidate_entity_id, score, detail)
           values ($1, $2, $3, $4, $5)`,
          [id("rev"), m.id, best.entity.id, best.score,
           JSON.stringify({ reason: best.reason, mention_name: m.name, mention_email: m.email,
                            candidate_name: best.entity.canonical_name })]
        );
        stats.queued++;
      }
    } else {
      if (defer?.has(mentionIdentity(m.norm_name, m.norm_email))) continue;
      // The new entity is indexed, so later mentions of the same person attach to it.
      const entity = await createEntityFromMention(db, index, m, m.doc_owner ?? "");
      await db.query(`update mentions set entity_id = $2 where id = $1`, [m.id, entity.id]);
      stats.created++;
    }
  }
  return stats;
}
