import { createHash } from "node:crypto";
import { env } from "../brand.js";
import { mentionId } from "../ingest/index.js";
import { normEmail, normPersonName, normOrgName } from "../resolve/normalize.js";
import { PROMPT_VERSION, chunkBody, MIN_BODY_CHARS, MAX_BODY_CHARS, CHUNK_CHARS } from "./prompt.js";
import { extractConfig, generateExtraction, isAuthError, priceFor } from "./client.js";

const MAX_CONTEXT_CHARS = 240;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_ATTEMPTS = 3; // per (prompt, model, body) hash; a changed hash resets the count

export { MIN_BODY_CHARS };

export function minConfidence() {
  const v = Number(env("EXTRACT_MIN_CONFIDENCE") ?? 0.6);
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0.6;
}

export function bodySha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * The skip key. Everything that changes what a run would produce is in here —
 * prompt version, model, effort, confidence floor, and the body itself (via
 * its stored hash, so skip decisions never need the body in memory).
 */
export function extractionHash(cfg, docBodySha) {
  return createHash("sha256")
    .update(`${PROMPT_VERSION}|${cfg.model}|${cfg.effort}|${minConfidence()}|${docBodySha}`)
    .digest("hex");
}

/* ---------- grounding ---------- */

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NON_WORD = "[^\\p{L}\\p{N}]";

/** Contiguous-phrase, word-boundary regex for a person/org name. */
function phraseRegex(name) {
  const tokens = (name ?? "").split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}'’.\-&]/gu, ""))
    .filter((t) => t.replace(/[^\p{L}\p{N}]/gu, "").length >= 1);
  if (!tokens.length) return null;
  // Tokens must appear in order, adjacent up to short separators (", " etc.) —
  // "Maya Chen" cannot be assembled from "Maya Chen and Daniel Roth"'s spare parts.
  const body = tokens.map(escRe).join(`${NON_WORD}{1,4}`);
  try {
    return new RegExp(`(?:^|${NON_WORD})(${body})(?:${NON_WORD}|$)`, "iu");
  } catch {
    return null;
  }
}

function emailRegex(email) {
  const CHARS = "[A-Za-z0-9._%+\\-]";
  try {
    return new RegExp(`(?:^|(?!${CHARS}).)(${escRe(email)})(?:(?!${CHARS}).|$)`, "i");
  } catch {
    return null;
  }
}

/** Verbatim-by-construction snippet around the grounded match. */
function snippetAround(body, matchIndex, matchLength) {
  const start = Math.max(0, matchIndex - 100);
  const end = Math.min(body.length, matchIndex + matchLength + 110);
  return ((start > 0 ? "…" : "") + body.slice(start, end).replace(/\s+/g, " ").trim() +
    (end < body.length ? "…" : "")).slice(0, MAX_CONTEXT_CHARS);
}

/**
 * Deterministic grounding: the model proposes, the code disposes. Every
 * extracted entity must appear in the document text as a contiguous phrase on
 * word boundaries (names) or as an exact delimited string (emails) — so
 * hallucinated entities, token-recombined names ("Maya Roth" from a text
 * containing Maya Chen and Daniel Roth), and truncated/completed addresses
 * are all inert. The stored context snippet is cut from the document by code,
 * never taken from the model, so the review card can't be used as an
 * injection channel aimed at the human reviewer.
 */
const EMAIL_TOKEN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g;

export function groundExtraction(doc, raw, { min = minConfidence(), structured = [] } = {}) {
  const body = doc.body ?? "";
  // Names and orgs must ground in prose, not inside email addresses — a
  // domain is not a discussion of the org, and a local-part is not a name.
  // Length-preserving mask keeps match indexes valid against the raw body,
  // so context snippets still cut from the real text.
  const prose = body.replace(EMAIL_TOKEN, (m) => " ".repeat(m.length));
  const dropped = [];
  const seen = new Set();
  const structuredNames = new Set(structured.map((m) => m.norm_name).filter(Boolean));
  const structuredEmails = new Set(structured.map((m) => m.norm_email).filter(Boolean));
  const clamp = (n) => (Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0);

  const people = [];
  for (const p of raw.people ?? []) {
    const name = (p.name ?? "").trim();
    const confidence = clamp(p.confidence);
    const nameRe = phraseRegex(name);
    const nameMatch = nameRe ? nameRe.exec(prose) : null;
    const emailRe = p.email ? emailRegex(p.email.trim()) : null;
    const emailMatch = emailRe ? emailRe.exec(body) : null;
    const email = emailMatch ? p.email.trim() : null;
    const orgRe = p.org ? phraseRegex(p.org.trim()) : null;
    const org = orgRe && orgRe.test(prose) ? p.org.trim() : null;

    if (!nameMatch) { dropped.push({ kind: "person", name, reason: "name not in text as a phrase" }); continue; }
    const tokenCount = name.split(/\s+/).filter(Boolean).length;
    if (tokenCount < 2 && !email) { dropped.push({ kind: "person", name, reason: "single token, no grounded email" }); continue; }
    if (confidence < min) { dropped.push({ kind: "person", name, reason: `confidence ${confidence.toFixed(2)} < ${min}` }); continue; }
    const nn = normPersonName(name);
    const ne = normEmail(email);
    if ((ne && structuredEmails.has(ne)) || (!ne && nn && structuredNames.has(nn))) {
      dropped.push({ kind: "person", name, reason: "already in structured metadata" });
      continue;
    }
    if (!nn && !ne) continue;
    const key = `person:${ne ?? ""}|${nn ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({
      name, email, org, confidence,
      context: snippetAround(body, nameMatch.index, nameMatch[0].length),
    });
  }

  const orgs = [];
  for (const o of raw.orgs ?? []) {
    const name = (o.name ?? "").trim();
    const confidence = clamp(o.confidence);
    const re = phraseRegex(name);
    const match = re ? re.exec(prose) : null;
    if (!match) { dropped.push({ kind: "org", name, reason: "name not in text as a phrase" }); continue; }
    if (confidence < min) { dropped.push({ kind: "org", name, reason: `confidence ${confidence.toFixed(2)} < ${min}` }); continue; }
    const nn = normOrgName(name);
    if (!nn) continue;
    if (structuredNames.has(nn)) { dropped.push({ kind: "org", name, reason: "already in structured metadata" }); continue; }
    const key = `org:${nn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    orgs.push({ name, confidence, context: snippetAround(body, match.index, match[0].length) });
  }

  const DEAL_STATUSES = new Set(["active", "invested", "passed", "exited", "unknown"]);
  const deals = [];
  for (const d of raw.deals ?? []) {
    const company = (d.company ?? "").trim();
    const confidence = clamp(d.confidence);
    const re = phraseRegex(company);
    const match = re ? re.exec(prose) : null;
    if (!match) { dropped.push({ kind: "deal", name: company, reason: "company not in text as a phrase" }); continue; }
    if (confidence < min) { dropped.push({ kind: "deal", name: company, reason: `confidence ${confidence.toFixed(2)} < ${min}` }); continue; }
    const nn = normOrgName(company);
    if (!nn) continue;
    const key = `deal:${nn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const snippet = snippetAround(body, match.index, match[0].length);
    deals.push({
      company,
      company_norm: nn,
      stage: (d.stage ?? "").trim().slice(0, 60) || null,
      status: DEAL_STATUSES.has(d.status) ? d.status : "unknown",
      summary: (d.summary ?? "").trim().slice(0, 300) || null,
      confidence,
      context: snippet,
    });
    // A recorded deal means the company matters to the fund: make sure it
    // becomes an org entity even when the model didn't list it under orgs
    // (and it isn't already in the structured metadata).
    if (!orgs.some((o) => normOrgName(o.name) === nn) && !structuredNames.has(nn)) {
      orgs.push({ name: company, confidence, context: snippet });
    }
  }

  return { people, orgs, deals, dropped };
}

/** Merge chunk results, keeping the highest-confidence copy of each identity. */
function mergeChunks(results) {
  const people = new Map();
  const orgs = new Map();
  const deals = new Map();
  for (const r of results) {
    for (const p of r.people ?? []) {
      const key = `${(p.email ?? "").toLowerCase()}|${(p.name ?? "").toLowerCase()}`;
      if (!people.has(key) || (p.confidence ?? 0) > (people.get(key).confidence ?? 0)) people.set(key, p);
    }
    for (const o of r.orgs ?? []) {
      const key = (o.name ?? "").toLowerCase();
      if (!orgs.has(key) || (o.confidence ?? 0) > (orgs.get(key).confidence ?? 0)) orgs.set(key, o);
    }
    for (const d of r.deals ?? []) {
      const key = (d.company ?? "").toLowerCase();
      if (!deals.has(key) || (d.confidence ?? 0) > (deals.get(key).confidence ?? 0)) deals.set(key, d);
    }
  }
  return { people: [...people.values()], orgs: [...orgs.values()], deals: [...deals.values()] };
}

/* ---------- persistence ---------- */

/**
 * Idempotent per-document write, mirroring ingest: stable mention ids (so
 * review decisions survive re-extraction), per-doc transactions, and
 * entity_id never touched. Extracted people carry role='mentioned', which the
 * edge builder damps by mentionedFactor — extraction strengthens the graph,
 * it never fabricates attendance.
 */
async function writeDoc(outerDb, doc, grounded, meta) {
  await outerDb.tx(async (db) => {
    const ordinals = new Map();
    const keep = [];
    for (const p of grounded.people) {
      const nn = normPersonName(p.name);
      const ne = normEmail(p.email);
      const okey = `xperson:${ne ?? ""}|${nn ?? ""}`;
      const ordinal = ordinals.get(okey) ?? 0;
      ordinals.set(okey, ordinal + 1);
      const mid = mentionId(doc.id, "person", "extracted", nn, ne, ordinal);
      keep.push(mid);
      await db.query(
        `insert into mentions (id, document_id, kind, name, email, org_hint, role, norm_name, norm_email, origin, confidence, context)
         values ($1, $2, 'person', $3, $4, $5, 'mentioned', $6, $7, 'extracted', $8, $9)
         on conflict (id) do update set name = $3, email = $4, org_hint = $5,
           norm_name = $6, norm_email = $7, confidence = $8, context = $9`,
        [mid, doc.id, p.name, p.email, p.org, nn, ne, p.confidence, p.context]
      );
    }
    for (const o of grounded.orgs) {
      const nn = normOrgName(o.name);
      const okey = `xorg:${nn}`;
      const ordinal = ordinals.get(okey) ?? 0;
      ordinals.set(okey, ordinal + 1);
      const mid = mentionId(doc.id, "org", "extracted", nn, null, ordinal);
      keep.push(mid);
      await db.query(
        `insert into mentions (id, document_id, kind, name, role, norm_name, origin, confidence, context)
         values ($1, $2, 'org', $3, 'mentioned', $4, 'extracted', $5, $6)
         on conflict (id) do update set name = $3, norm_name = $4, confidence = $5, context = $6`,
        [mid, doc.id, o.name, nn, o.confidence, o.context]
      );
    }
    if (keep.length) {
      const placeholders = keep.map((_, i) => `$${i + 2}`).join(", ");
      await db.query(
        `delete from mentions where document_id = $1 and origin = 'extracted' and id not in (${placeholders})`,
        [doc.id, ...keep]
      );
    } else {
      await db.query(`delete from mentions where document_id = $1 and origin = 'extracted'`, [doc.id]);
    }

    // Deals: same replace-on-change contract as mentions, keyed per document.
    const dealIds = [];
    for (const d of grounded.deals ?? []) {
      const dealId = "deal_" + createHash("sha1").update(`${doc.id}:${d.company_norm}`).digest("hex").slice(0, 20);
      dealIds.push(dealId);
      await db.query(
        `insert into deals (id, document_id, company, company_norm, stage, status, summary, confidence, context, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         on conflict (id) do update set company = $3, company_norm = $4, stage = $5,
           status = $6, summary = $7, confidence = $8, context = $9, updated_at = now()`,
        [dealId, doc.id, d.company, d.company_norm, d.stage, d.status, d.summary, d.confidence, d.context]
      );
    }
    if (dealIds.length) {
      const ph = dealIds.map((_, i) => `$${i + 2}`).join(", ");
      await db.query(`delete from deals where document_id = $1 and id not in (${ph})`, [doc.id, ...dealIds]);
    } else {
      await db.query(`delete from deals where document_id = $1`, [doc.id]);
    }

    await db.query(
      `insert into extractions (document_id, status, model, input_sha256, attempts, mentions_found, input_tokens, output_tokens, error, updated_at)
       values ($1, 'ok', $2, $3, 0, $4, $5, $6, null, now())
       on conflict (document_id) do update set status = 'ok', model = $2, input_sha256 = $3,
         attempts = 0, mentions_found = $4, input_tokens = $5, output_tokens = $6, error = null, updated_at = now()`,
      [doc.id, meta.model, meta.hash, keep.length, meta.usage.input, meta.usage.output]
    );
  });
}

async function markFailed(outerDb, doc, meta, message) {
  await outerDb.tx(async (db) => {
    // The body changed and its re-extraction failed: the previous run's
    // mentions and deals are grounded only in a body that no longer exists —
    // drop them rather than serving stale rows as if they were current.
    if (doc.prev_hash && doc.prev_hash !== meta.hash) {
      await db.query(`delete from mentions where document_id = $1 and origin = 'extracted'`, [doc.id]);
      await db.query(`delete from deals where document_id = $1`, [doc.id]);
    }
    await db.query(
      `insert into extractions (document_id, status, model, input_sha256, attempts, mentions_found, input_tokens, output_tokens, error, updated_at)
       values ($1, 'failed', $2, $3, 1, 0, $4, $5, $6, now())
       on conflict (document_id) do update set status = 'failed', model = $2,
         attempts = case when extractions.input_sha256 = $3 then extractions.attempts + 1 else 1 end,
         input_sha256 = $3, input_tokens = $4, output_tokens = $5, error = $6, updated_at = now()`,
      [doc.id, meta.model, meta.hash, meta.usage.input, meta.usage.output, String(message).slice(0, 500)]
    );
  });
}

/** Backfill body_sha256 for rows ingested before the column existed; scrub sub-floor bodies. */
async function backfillBodyHashes(db) {
  for (;;) {
    const { rows } = await db.query(
      `select id, body from documents where body is not null and body_sha256 is null limit 200`
    );
    if (!rows.length) return;
    for (const r of rows) {
      if (r.body.length < MIN_BODY_CHARS) {
        await db.query(`update documents set body = null, body_sha256 = null where id = $1`, [r.id]);
      } else {
        await db.query(`update documents set body_sha256 = $2 where id = $1`, [r.id, bodySha256(r.body)]);
      }
    }
    if (rows.length < 200) return;
  }
}

/** Documents whose body disappeared keep no extraction artifacts behind. */
async function sweepBodylessDocs(db) {
  await db.query(
    `delete from mentions where origin = 'extracted'
       and document_id in (select id from documents where body_sha256 is null)`
  );
  await db.query(
    `delete from deals where document_id in (select id from documents where body_sha256 is null)`
  );
  await db.query(
    `delete from extractions where document_id in (select id from documents where body_sha256 is null)`
  );
}

/**
 * Extract pending documents: anything with a body whose (prompt, model,
 * effort, floor, body) hash has no successful extraction yet. Failed
 * documents retry up to MAX_ATTEMPTS per hash, then park as `exhausted`
 * until something about the inputs changes. Bodies are fetched one at a
 * time — skip decisions run entirely on stored hashes, so a 100k-document
 * corpus never gets materialized in memory.
 */
export async function extractPending(db, { limit = Infinity, generate = generateExtraction, onProgress, shouldStop } = {}) {
  const cfg = extractConfig();
  await backfillBodyHashes(db);
  await sweepBodylessDocs(db);

  const { rows: candidates } = await db.query(
    `select d.id, d.source, d.kind, d.title, d.body_sha256,
            e.status as prev_status, e.input_sha256 as prev_hash, e.attempts as prev_attempts
     from documents d left join extractions e on e.document_id = d.id
     where d.body_sha256 is not null
     order by d.occurred_at desc nulls last, d.id`
  );

  const stats = { scanned: candidates.length, extracted: 0, failed: 0, skipped: 0, exhausted: 0,
    mentions: 0, deals: 0, dropped: 0, tokens: { input: 0, output: 0 }, model: cfg.model };
  let consecutiveFailures = 0;
  let processed = 0;

  for (const doc of candidates) {
    // Externally-triggered cancellation, checked between documents before any
    // token is spent. Cancellation is NOT a failure: everything already
    // written stays durable and the next run resumes via hashes, exactly like
    // the consecutive-failure abort below — but through the success path.
    if (shouldStop?.()) { stats.cancelled = "cancelled by user"; break; }
    const hash = extractionHash(cfg, doc.body_sha256);
    const sameHash = doc.prev_hash === hash;
    if (sameHash && doc.prev_status === "ok") { stats.skipped++; continue; }
    if (sameHash && doc.prev_status === "failed" && (doc.prev_attempts ?? 0) >= MAX_ATTEMPTS) {
      stats.exhausted++;
      continue;
    }
    if (processed >= limit) { stats.skipped++; continue; }
    processed++;

    const meta = { model: cfg.model, hash, usage: { input: 0, output: 0 } };
    try {
      const { rows: bodyRows } = await db.query(`select body from documents where id = $1`, [doc.id]);
      const body = bodyRows[0]?.body;
      if (!body) { stats.skipped++; processed--; continue; }
      doc.body = body;

      const chunks = chunkBody(body);
      const results = [];
      for (let i = 0; i < chunks.length; i++) {
        const r = await generate(doc, chunks[i], i, chunks.length);
        meta.usage.input += r.usage?.input ?? 0;
        meta.usage.output += r.usage?.output ?? 0;
        results.push(r);
      }
      const { rows: structured } = await db.query(
        `select norm_name, norm_email from mentions where document_id = $1 and origin = 'structured'`,
        [doc.id]
      );
      const grounded = groundExtraction(doc, mergeChunks(results), { structured });
      await writeDoc(db, doc, grounded, meta);
      stats.extracted++;
      stats.mentions += grounded.people.length + grounded.orgs.length;
      stats.deals += grounded.deals.length;
      stats.dropped += grounded.dropped.length;
      consecutiveFailures = 0;
    } catch (err) {
      if (err?.usage) {
        meta.usage.input += err.usage.input ?? 0;
        meta.usage.output += err.usage.output ?? 0;
      }
      if (isAuthError(err)) {
        stats.tokens.input += meta.usage.input;
        stats.tokens.output += meta.usage.output;
        throw Object.assign(new Error(
          `extraction aborted — ${err.message}. ` +
          `Set ANTHROPIC_API_KEY (or run \`ant auth login\`) and re-run; nothing was marked failed.`
        ), { stats });
      }
      await markFailed(db, doc, meta, err.message);
      stats.failed++;
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stats.aborted = `stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures — last error: ${err.message}`;
      }
    } finally {
      delete doc.body;
      stats.tokens.input += meta.usage.input;
      stats.tokens.output += meta.usage.output;
      onProgress?.({ ...stats });
    }
    if (stats.aborted) break;
  }
  return stats;
}

/**
 * Status counts for dashboards. Shares its pending definition with
 * counts().pendingExtraction: no successful extraction row and not exhausted.
 * (A model/prompt change makes this an undercount until the next run — the
 * run itself is the source of truth for staleness.)
 */
export async function extractionStats(db) {
  const one = async (sql) => Number((await db.query(sql)).rows[0].n);
  const docsWithBody = await one(`select count(*) as n from documents where body_sha256 is not null`);
  const extracted = await one(`select count(*) as n from extractions where status = 'ok'`);
  const exhausted = await one(
    `select count(*) as n from extractions where status = 'failed' and attempts >= ${MAX_ATTEMPTS}`
  );
  const failed = await one(`select count(*) as n from extractions where status = 'failed'`);
  const pending = await one(
    `select count(*) as n from documents d
     where d.body_sha256 is not null
       and not exists (select 1 from extractions e where e.document_id = d.id
                       and (e.status = 'ok' or (e.status = 'failed' and e.attempts >= ${MAX_ATTEMPTS})))`
  );
  const extractedMentions = await one(`select count(*) as n from mentions where origin = 'extracted'`);
  const deals = await one(`select count(*) as n from deals`);
  return { docsWithBody, extracted, failed, exhausted, pending, extractedMentions, deals };
}

const PROMPT_OVERHEAD_TOKENS = 700; // system prompt + schema + metadata, per request
const OUTPUT_TOKENS_PER_REQUEST = 300; // grounded JSON is small

/**
 * Cost/size preview for the next run: how many documents a `limit`-bounded run
 * would touch, and roughly what it would spend. Applies the run's own skip
 * key — the extraction hash, computed in SQL — plus the run's ordering, so
 * the batch it prices is the batch extractPending would take, INCLUDING
 * stale-'ok' docs a model/effort/floor/prompt change will re-extract (which
 * extractionStats' cheaper pending count deliberately ignores). Deliberately
 * approximate — ~4 chars/token on body lengths, chunk counts ignore
 * paragraph-boundary overlap, list prices only — and every surface showing
 * these figures labels them approximate. The char sums read bodies only
 * inside the limited batch; the corpus-wide figure stays a count.
 */
export async function estimateExtraction(db, { limit = Infinity } = {}) {
  const cfg = extractConfig();
  // extractionHash(cfg, body_sha256) in SQL: the config prefix is computed
  // once here, the per-doc body hash joined in the query — so "pending" means
  // exactly what the run's loop means (an ok/exhausted row only counts under
  // the CURRENT hash; anything else gets processed and charged to `limit`).
  const hashPrefix = `${PROMPT_VERSION}|${cfg.model}|${cfg.effort}|${minConfidence()}|`;
  const currentHash = `encode(sha256(convert_to($1 || d.body_sha256, 'UTF8')), 'hex')`;
  const pendingFrom = `
    from documents d
    where d.body_sha256 is not null
      and not exists (select 1 from extractions e where e.document_id = d.id
                      and e.input_sha256 = ${currentHash}
                      and (e.status = 'ok' or (e.status = 'failed' and e.attempts >= ${MAX_ATTEMPTS})))`;
  const totalPending = Number((await db.query(`select count(*) as n ${pendingFrom}`, [hashPrefix])).rows[0].n);
  const lim = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
  const { rows: [batch] } = await db.query(
    `select count(*) as docs,
            coalesce(sum(least(length(body), ${MAX_BODY_CHARS})), 0) as chars,
            coalesce(sum(ceil(least(length(body), ${MAX_BODY_CHARS})::numeric / ${CHUNK_CHARS})), 0) as requests
     from (select d.body ${pendingFrom}
           order by d.occurred_at desc nulls last, d.id${lim !== null ? ` limit ${lim}` : ""}) as batch`,
    [hashPrefix]
  );
  const requests = Number(batch.requests);
  const approxInputTokens = Math.ceil(Number(batch.chars) / 4) + requests * PROMPT_OVERHEAD_TOKENS;
  const approxOutputTokens = requests * OUTPUT_TOKENS_PER_REQUEST;
  const price = priceFor(cfg.model);
  return {
    model: cfg.model,
    totalPending,
    docsThisRun: Number(batch.docs),
    approxInputTokens,
    approxOutputTokens,
    approxCostUsd: price
      ? (approxInputTokens * price.input + approxOutputTokens * price.output) / 1e6
      : null,
    priceKnown: !!price,
    note: "approximate: ~4 chars/token on body lengths, list prices",
  };
}
