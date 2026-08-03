import { id } from "../db.js";
import { blockKeys, jaroWinkler, nameSimilarity, normOrgName } from "./normalize.js";

const AUTO_MERGE = 0.95;   // deterministic above this, per the four-stage design
const REVIEW = 0.7;        // below AUTO_MERGE but above this → human confirms
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
  // Exact-name fast path (mirrors scoreOrg): identical normalized names
  // auto-attach; the ambiguity guard in resolveMentions queues the case
  // where several entities share the name.
  if (best >= 0.999) return { score: 0.96, reason: "exact name match" };
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
  for (const r of rows) {
    const aliases = typeof r.aliases === "string" ? JSON.parse(r.aliases) : r.aliases;
    index.add({
      id: r.id,
      kind: r.kind,
      canonical_name: r.canonical_name,
      emails: typeof r.emails === "string" ? JSON.parse(r.emails) : r.emails,
      orgs: typeof r.orgs === "string" ? JSON.parse(r.orgs) : r.orgs,
      normNames: new Set(
        [...aliases,
         r.kind === "org" ? normOrgName(r.canonical_name) : null,
         r.kind === "person" ? mentionNormName(r.canonical_name) : null].filter(Boolean)
      ),
    });
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
    [e.id, e.canonical_name, JSON.stringify(e.emails), JSON.stringify(e.orgs),
     JSON.stringify([...e.normNames])]
  );
}

function absorb(entity, mention) {
  if (mention.norm_email && !entity.emails.includes(mention.norm_email)) {
    entity.emails.push(mention.norm_email);
  }
  const mOrg = normOrgName(mention.org_hint);
  if (mOrg && !entity.orgs.includes(mOrg)) entity.orgs.push(mOrg);
  if (mention.norm_name) {
    entity.normNames.add(mention.norm_name);
    // Prefer the fullest observed display name ("M. Chen" -> "Maya Chen").
    const current = mentionNormName(entity.canonical_name) ?? "";
    if (mention.norm_name.split(" ").length > current.split(" ").length) {
      entity.canonical_name = mention.name;
    }
  }
}

export async function createEntityFromMention(db, index, mention) {
  const entity = {
    id: id("ent"),
    kind: mention.kind,
    canonical_name: mention.name ?? mention.email ?? "unknown",
    emails: mention.norm_email ? [mention.norm_email] : [],
    orgs: [],
    normNames: new Set([mention.norm_name].filter(Boolean)),
  };
  const mOrg = normOrgName(mention.org_hint);
  if (mOrg) entity.orgs.push(mOrg);
  await db.query(
    `insert into entities (id, kind, canonical_name, emails, orgs, aliases) values ($1, $2, $3, $4, $5, $6)`,
    [entity.id, entity.kind, entity.canonical_name,
     JSON.stringify(entity.emails), JSON.stringify(entity.orgs),
     JSON.stringify([...entity.normNames])]
  );
  if (index) index.add(entity);
  return entity;
}

/**
 * Four stages: blocking -> candidate generation -> probabilistic matching -> review.
 * Deterministic merge at >= 0.95; 0.70-0.95 goes to the review queue; below
 * that a new entity is created. Order is fixed so runs are reproducible.
 */
export async function resolveMentions(db) {
  const index = await loadIndex(db);
  const { rows: mentions } = await db.query(
    `select m.* from mentions m
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
    // An exact email match is exempt: the address pins identity even when the
    // display name also matches some other entity (a merge candidate, not an
    // attachment ambiguity).
    const ambiguous = scored.length > 1 && scored[1].score >= AUTO_MERGE &&
      best.reason !== "exact email match";

    if (best && best.score >= AUTO_MERGE && !ambiguous) {
      absorb(best.entity, m);
      await persistEntity(db, best.entity);
      index.reindex(best.entity);
      await db.query(`update mentions set entity_id = $2 where id = $1`, [m.id, best.entity.id]);
      stats.attached++;
    } else if (best && (best.score >= REVIEW || ambiguous)) {
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
      // The new entity is indexed, so later mentions of the same person attach to it.
      const entity = await createEntityFromMention(db, index, m);
      await db.query(`update mentions set entity_id = $2 where id = $1`, [m.id, entity.id]);
      stats.created++;
    }
  }
  return stats;
}
