/**
 * Automated-sender detection.
 *
 * A relationship graph built from a real inbox fills up with things that are
 * not relationships: no-reply robots, notification services, mailing lists,
 * "The Google Workspace Team". They inflate the graph, distort strength, and
 * dominate the radar. This flags them deterministically — no model, and every
 * decision is explainable by the rule that fired.
 *
 * Flags are advisory: they hide entities from relationship views by default,
 * never delete anything, and can be overridden per entity.
 */

// Tier 1 — machines. These addresses cannot hold a conversation, so the
// pattern alone is enough.
const ROBOT_PATTERNS = [
  /^no-?reply@/i, /^do-?not-?reply@/i, /^donotreply@/i, /^noreply[+-]/i,
  /^notifications?@/i, /^alerts?@/i, /^news(letter)?@/i,
  /^mailer-daemon@/i, /^postmaster@/i, /^bounces?[@+-]/i, /-bounces@/i,
  /^automated@/i, /^robot@/i, /^bot@/i, /^daemon@/i, /^mailer@/i,
  /^receipts?@/i, /^digest@/i, /^updates@/i,
];

// Tier 2 — ROLE addresses. A shared mailbox usually has a human behind it:
// your own team@, a client's hello@, a founder answering info@. The pattern is
// only a hint; it flags nothing on its own and needs broadcast behaviour to
// confirm. Getting this wrong means calling a real client a robot.
const ROLE_PATTERNS = [
  /^team@/i, /^hello@/i, /^hi@/i, /^info@/i, /^contact@/i, /^admin@/i,
  /^support@/i, /^help@/i, /^billing@/i, /^invoices?@/i, /^accounts?@/i,
  /^security@/i, /^sales@/i, /^marketing@/i, /^careers@/i, /^press@/i,
];

const NAME_PATTERNS = [
  /\bnotifications?\b/i, /\bno.?reply\b/i, /\bnewsletter\b/i,
  /\bdaemon\b/i, /\bmailer\b/i, /\bdigest\b/i,
];

/** Subdomains that only ever exist to send machine mail. */
const DOMAIN_PATTERNS = [
  /^(mail|email|em|mailer|notify|notifications|alerts|bounce|bounces|smtp|sendgrid|mailgun|amazonses)\./i,
];

/** Returns { automated, role, reason }: `role` means "hint only, needs behaviour". */
export function classifyAddress(email, name) {
  if (email) {
    for (const re of ROBOT_PATTERNS) if (re.test(email)) return { automated: true, reason: `no-reply style address (${re.source})` };
    const domain = email.split("@")[1] ?? "";
    for (const re of DOMAIN_PATTERNS) if (re.test(domain)) return { automated: true, reason: `machine-mail domain ${domain}` };
    for (const re of ROLE_PATTERNS) if (re.test(email)) return { automated: false, role: true, reason: `role address` };
  }
  if (name) {
    for (const re of NAME_PATTERNS) if (re.test(name)) return { automated: true, reason: `display name reads as a service (${re.source})` };
  }
  return { automated: false, reason: null };
}

/**
 * Behavioural pass: an entity that only ever appears as a sender, never in a
 * meeting, and never receives anything, is broadcasting rather than relating.
 * Requires enough volume to be confident — a person who happens to have sent
 * three emails and received none is not a robot.
 */
const BROADCAST_MIN_SENDS = 5;
// Role addresses get a lower bar because the pattern is corroborating evidence,
// but still need to actually behave like a broadcaster.
const ROLE_MIN_SENDS = 3;

export async function detectAutomated(db) {
  const { rows } = await db.query(
    `select e.id, e.canonical_name, e.emails,
            count(*) filter (where m.role = 'from') as sends,
            count(*) filter (where m.role in ('to', 'cc')) as receives,
            count(*) filter (where d.kind in ('meeting', 'event')) as meetings,
            count(distinct d.id) as documents
     from entities e
     join mentions m on m.entity_id = e.id
     join documents d on d.id = m.document_id
     where e.kind = 'person' and e.merged_into is null
     group by e.id, e.canonical_name, e.emails`
  );

  const flagged = [];
  for (const r of rows) {
    const emails = typeof r.emails === "string" ? JSON.parse(r.emails) : r.emails;
    let verdict = { automated: false, reason: null };
    let roleHint = false;
    for (const email of emails ?? []) {
      const v = classifyAddress(email, null);
      if (v.automated) { verdict = v; break; }
      if (v.role) roleHint = true;
    }
    if (!verdict.automated) {
      const nameVerdict = classifyAddress(null, r.canonical_name);
      if (nameVerdict.automated) verdict = nameVerdict;
    }

    if (!verdict.automated) {
      const sends = Number(r.sends), receives = Number(r.receives), meetings = Number(r.meetings);
      const broadcasts = receives === 0 && meetings === 0;
      // A role address that never replies and never meets is a service desk.
      // A role address that does either is a person, and stays a person.
      if (roleHint && broadcasts && sends >= ROLE_MIN_SENDS) {
        verdict = { automated: true, reason: `role address broadcasting only: ${sends} sends, no replies, never in a meeting` };
      } else if (broadcasts && sends >= BROADCAST_MIN_SENDS) {
        verdict = { automated: true, reason: `broadcast only: ${sends} sends, no replies, never in a meeting` };
      }
    }
    if (verdict.automated) flagged.push({ id: r.id, name: r.canonical_name, reason: verdict.reason });
  }

  // Never override a human decision recorded via setAutomated().
  await db.tx(async (tx) => {
    await tx.query(`update entities set automated = false, automated_reason = null
                    where automated_override is null and automated = true`);
    for (const f of flagged) {
      await tx.query(
        `update entities set automated = true, automated_reason = $2
         where id = $1 and automated_override is null`,
        [f.id, f.reason]
      );
    }
  });
  return { flagged: flagged.length, examples: flagged.slice(0, 10) };
}

/** Explicit human override: true = definitely automated, false = definitely a person. */
export async function setAutomated(db, entityId, automated) {
  await db.query(
    `update entities set automated = $2, automated_override = $2,
            automated_reason = $3 where id = $1`,
    [entityId, automated, automated ? "marked automated by a person" : "confirmed human by a person"]
  );
  return { entityId, automated };
}
