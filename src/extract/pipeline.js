import { createHash } from "node:crypto";
import { mentionId } from "../ingest/index.js";
import { normEmail, normPersonName, normOrgName } from "../resolve/normalize.js";
import { PROMPT_VERSION, chunkBody, MAX_BODY_CHARS } from "./prompt.js";
import { extractConfig, generateExtraction, isAuthError } from "./client.js";

const MIN_BODY_CHARS = 40;
const MAX_CONTEXT_CHARS = 240;
const MAX_CONSECUTIVE_FAILURES = 3;

export function minConfidence() {
  const v = Number(process.env.FUNDGRAPH_EXTRACT_MIN_CONFIDENCE ?? 0.6);
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0.6;
}

/** Part of the skip decision: same body + same prompt + same model = same result. */
export function extractionHash(model, body) {
  return createHash("sha256")
    .update(`${PROMPT_VERSION}|${model}|`)
    .update(body.slice(0, MAX_BODY_CHARS))
    .digest("hex");
}

/**
 * Deterministic grounding: the model proposes, the code disposes. Every
 * extracted entity must literally appear in the document text — a mention the
 * body can't corroborate is discarded, which is what makes hallucinated or
 * prompt-injected entities inert. LLM output is treated as untrusted here in
 * exactly the way document bodies are treated as untrusted by the prompt.
 */
export function groundExtraction(doc, raw, { min = minConfidence(), structured = [] } = {}) {
  const haystack = (doc.body ?? "").toLowerCase();
  const dropped = [];
  const seen = new Set();
  const structuredNames = new Set(structured.map((m) => m.norm_name).filter(Boolean));
  const structuredEmails = new Set(structured.map((m) => m.norm_email).filter(Boolean));

  const inBody = (needle) => needle && haystack.includes(needle.toLowerCase());
  const nameGrounded = (name) => {
    const tokens = (name ?? "").split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}'’.-]/gu, "")).filter((t) => t.length > 1);
    return tokens.length > 0 && tokens.every((t) => inBody(t)) ? tokens : null;
  };
  const clamp = (n) => (Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0);

  const people = [];
  for (const p of raw.people ?? []) {
    const name = (p.name ?? "").trim();
    const confidence = clamp(p.confidence);
    const tokens = nameGrounded(name);
    // Emails are exact strings: keep one only when the body contains it
    // verbatim, so a model can never "complete" name@domain into existence.
    const email = p.email && inBody(p.email) ? p.email.trim() : null;
    const org = p.org && nameGrounded(p.org) ? p.org.trim() : null;
    if (!tokens) { dropped.push({ kind: "person", name, reason: "not in text" }); continue; }
    if (tokens.length < 2 && !email) { dropped.push({ kind: "person", name, reason: "single token, no grounded email" }); continue; }
    if (confidence < min) { dropped.push({ kind: "person", name, reason: `confidence ${confidence.toFixed(2)} < ${min}` }); continue; }
    const nn = normPersonName(name);
    const ne = normEmail(email);
    if ((ne && structuredEmails.has(ne)) || (!ne && nn && structuredNames.has(nn))) {
      dropped.push({ kind: "person", name, reason: "already in structured metadata" });
      continue;
    }
    const key = `person:${ne ?? ""}|${nn ?? ""}`;
    if (!nn && !ne) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({ name, email, org, confidence, context: (p.quote ?? "").slice(0, MAX_CONTEXT_CHARS) });
  }

  const orgs = [];
  for (const o of raw.orgs ?? []) {
    const name = (o.name ?? "").trim();
    const confidence = clamp(o.confidence);
    if (!nameGrounded(name)) { dropped.push({ kind: "org", name, reason: "not in text" }); continue; }
    if (confidence < min) { dropped.push({ kind: "org", name, reason: `confidence ${confidence.toFixed(2)} < ${min}` }); continue; }
    const nn = normOrgName(name);
    if (!nn) continue;
    if (structuredNames.has(nn)) { dropped.push({ kind: "org", name, reason: "already in structured metadata" }); continue; }
    const key = `org:${nn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    orgs.push({ name, confidence, context: (o.quote ?? "").slice(0, MAX_CONTEXT_CHARS) });
  }

  return { people, orgs, dropped };
}

/** Merge chunk results, keeping the highest-confidence copy of each identity. */
function mergeChunks(results) {
  const people = new Map();
  const orgs = new Map();
  for (const r of results) {
    for (const p of r.people ?? []) {
      const key = `${(p.email ?? "").toLowerCase()}|${(p.name ?? "").toLowerCase()}`;
      if (!people.has(key) || (p.confidence ?? 0) > (people.get(key).confidence ?? 0)) people.set(key, p);
    }
    for (const o of r.orgs ?? []) {
      const key = (o.name ?? "").toLowerCase();
      if (!orgs.has(key) || (o.confidence ?? 0) > (orgs.get(key).confidence ?? 0)) orgs.set(key, o);
    }
  }
  return { people: [...people.values()], orgs: [...orgs.values()] };
}

/**
 * Idempotent per-document write, mirroring ingest: stable mention ids (so
 * review decisions survive re-extraction), replace-on-change semantics, and
 * entity_id is never touched. Extracted people carry role='mentioned', which
 * the edge builder already damps by mentionedFactor — extraction strengthens
 * the graph, it never fabricates attendance.
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
    await db.query(
      `insert into extractions (document_id, status, model, input_sha256, mentions_found, input_tokens, output_tokens, error, updated_at)
       values ($1, 'ok', $2, $3, $4, $5, $6, null, now())
       on conflict (document_id) do update set status = 'ok', model = $2, input_sha256 = $3,
         mentions_found = $4, input_tokens = $5, output_tokens = $6, error = null, updated_at = now()`,
      [doc.id, meta.model, meta.hash, keep.length, meta.usage.input, meta.usage.output]
    );
  });
}

async function markFailed(db, docId, meta, message) {
  await db.query(
    `insert into extractions (document_id, status, model, input_sha256, mentions_found, input_tokens, output_tokens, error, updated_at)
     values ($1, 'failed', $2, $3, 0, $4, $5, $6, now())
     on conflict (document_id) do update set status = 'failed', model = $2, input_sha256 = $3,
       input_tokens = $4, output_tokens = $5, error = $6, updated_at = now()`,
    [docId, meta.model, meta.hash, meta.usage.input, meta.usage.output, String(message).slice(0, 500)]
  );
}

/**
 * Extract pending documents: anything with a body whose (prompt, model, body)
 * hash has no successful extraction yet. Failed documents are retried once
 * per run; three consecutive failures abort the run so a systemic problem
 * (bad key, outage) can't burn through a large backlog.
 */
export async function extractPending(db, { limit = Infinity, generate = generateExtraction, onProgress } = {}) {
  const cfg = extractConfig();
  const { rows: candidates } = await db.query(
    `select d.id, d.source, d.kind, d.title, d.body, e.status as prev_status, e.input_sha256 as prev_hash
     from documents d left join extractions e on e.document_id = d.id
     where d.body is not null and length(d.body) >= ${MIN_BODY_CHARS}
     order by d.occurred_at desc nulls last, d.id`
  );

  const stats = { scanned: candidates.length, extracted: 0, failed: 0, skipped: 0,
    mentions: 0, dropped: 0, tokens: { input: 0, output: 0 }, model: cfg.model };
  let consecutiveFailures = 0;
  let processed = 0;

  for (const doc of candidates) {
    const hash = extractionHash(cfg.model, doc.body);
    if (doc.prev_hash === hash && doc.prev_status === "ok") { stats.skipped++; continue; }
    if (processed >= limit) { stats.skipped++; continue; }
    processed++;

    const meta = { model: cfg.model, hash, usage: { input: 0, output: 0 } };
    try {
      const chunks = chunkBody(doc.body);
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
      stats.dropped += grounded.dropped.length;
      consecutiveFailures = 0;
    } catch (err) {
      if (err?.usage) {
        meta.usage.input += err.usage.input ?? 0;
        meta.usage.output += err.usage.output ?? 0;
      }
      if (isAuthError(err)) {
        throw new Error(
          `extraction aborted — ${err.message}. ` +
          `Set ANTHROPIC_API_KEY (or run \`ant auth login\`) and re-run; nothing was marked failed.`
        );
      }
      await markFailed(db, doc.id, meta, err.message);
      stats.failed++;
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stats.aborted = `stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures — last error: ${err.message}`;
        break;
      }
    } finally {
      stats.tokens.input += meta.usage.input;
      stats.tokens.output += meta.usage.output;
      onProgress?.({ ...stats });
    }
  }
  return stats;
}

/** Cheap status counts for dashboards; staleness detection happens at run time. */
export async function extractionStats(db) {
  const one = async (sql) => Number((await db.query(sql)).rows[0].n);
  const docsWithBody = await one(
    `select count(*) as n from documents where body is not null and length(body) >= ${MIN_BODY_CHARS}`
  );
  const extracted = await one(`select count(*) as n from extractions where status = 'ok'`);
  const failed = await one(`select count(*) as n from extractions where status = 'failed'`);
  const extractedMentions = await one(`select count(*) as n from mentions where origin = 'extracted'`);
  return {
    docsWithBody, extracted, failed,
    pending: Math.max(0, docsWithBody - extracted - failed),
    extractedMentions,
  };
}
