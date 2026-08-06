/**
 * Affinity adapter — pulls people, organizations, and (optionally) notes from
 * an Affinity CRM via the REST API v1.
 *
 * Auth: Affinity → Settings → API → generate a key, then paste it in the
 * dashboard's Data tab or set AFFINITY_API_KEY. v1 uses HTTP Basic with the
 * key as the password and an empty username.
 *
 * Same privacy stance as every connector: identity attributes and note
 * *participants* only — note bodies and deal content are never read.
 */

const API = "https://api.affinity.co";
const PAGE = 500; // Affinity's max page_size

function authHeader(key) {
  return "Basic " + Buffer.from(":" + key).toString("base64");
}

function apiKey(explicit) {
  const key = explicit ?? process.env.AFFINITY_API_KEY;
  if (!key) {
    throw new Error(
      "no Affinity API key — paste one in the dashboard's Data tab, or set " +
      "AFFINITY_API_KEY. Generate it in Affinity under Settings → API"
    );
  }
  return key;
}

async function affinity(path, key) {
  const res = await fetch(API + path, {
    headers: { authorization: authHeader(apiKey(key)), "content-type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Affinity rejected the API key (${res.status}). Check it was copied whole: ${text.slice(0, 200)}`);
    }
    if (res.status === 429) {
      throw new Error("Affinity rate limit hit — wait a minute and sync again");
    }
    throw new Error(`Affinity ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** Cheap credential check. Returns { workspace, scopes } like verifyAttioKey. */
export async function verifyAffinityKey(key) {
  const res = await fetch(`${API}/auth/whoami`, {
    headers: { authorization: authHeader(key), "content-type": "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("Affinity rejected that API key — check it was copied whole and is still active");
  }
  if (!res.ok) throw new Error(`Affinity /auth/whoami -> ${res.status}`);
  const body = await res.json().catch(() => ({}));
  return { workspace: body.tenant?.name ?? body.tenant?.subdomain ?? null, scopes: [] };
}

/** Page through a v1 collection: { <plural>: [...], next_page_token }. */
async function pageThrough(path, field, max, key) {
  const out = [];
  let token = null;
  while (out.length < max) {
    const sep = path.includes("?") ? "&" : "?";
    const page = await affinity(
      `${path}${sep}page_size=${Math.min(PAGE, max - out.length)}${token ? `&page_token=${encodeURIComponent(token)}` : ""}`,
      key,
    );
    const batch = page[field] ?? [];
    out.push(...batch);
    token = page.next_page_token;
    if (!token || !batch.length) break;
  }
  return out;
}

/* ---------- pure mapping (unit-tested offline in scripts/test-connectors.js) ---------- */

const personName = (p) => [p.first_name, p.last_name].filter(Boolean).join(" ") || null;
const personEmails = (p) =>
  [...new Set([p.primary_email, ...(p.emails ?? [])])]
    .filter((e) => typeof e === "string" && e.includes("@"));

const iso = (t) => {
  if (!t) return null;
  const d = new Date(t);
  return isNaN(d) ? null : d.toISOString();
};

/** Persons/orgs/notes (already fetched) -> fein documents. */
export function docsFromAffinity({ persons = [], organizations = [], notes = [] }) {
  const orgNameById = new Map();
  for (const o of organizations) if (o.id != null && o.name) orgNameById.set(o.id, o.name);

  const docs = [];
  for (const o of organizations) {
    if (!o.name) continue;
    docs.push({
      source: "affinity",
      kind: "record",
      external_id: `affinity-org-${o.id}`,
      title: `Company: ${o.name}`,
      occurred_at: null,
      people: [],
      orgs: [o.name],
      ...(o.domain ? { raw: { domain: o.domain } } : {}),
    });
  }

  const personById = new Map();
  for (const p of persons) {
    const name = personName(p);
    const emails = personEmails(p);
    if (!name && !emails.length) continue;
    const org = (p.organization_ids ?? []).map((id) => orgNameById.get(id)).find(Boolean) ?? null;
    personById.set(p.id, { name, email: emails[0] ?? null });
    const mentions = emails.length
      ? emails.map((email) => ({ name, email, org, role: "mentioned" }))
      : [{ name, email: null, org, role: "mentioned" }];
    docs.push({
      source: "affinity",
      kind: "record",
      external_id: `affinity-person-${p.id}`,
      title: `Contact: ${name ?? emails[0]}`,
      occurred_at: null,
      people: mentions,
      orgs: org ? [org] : [],
    });
  }

  // A note on a person's record is evidence of contact — participants only,
  // the content field is deliberately never read.
  for (const n of notes) {
    const participants = (n.person_ids ?? [])
      .map((id) => personById.get(id))
      .filter((p) => p && (p.name || p.email));
    if (!participants.length) continue;
    docs.push({
      source: "affinity",
      kind: "note",
      external_id: `affinity-note-${n.id}`,
      title: "(CRM note)",
      occurred_at: iso(n.created_at),
      people: participants.map((p) => ({ name: p.name, email: p.email, role: "mentioned" })),
    });
  }
  return docs;
}

/** Fetch people + organizations (+ note participants) as documents. */
export async function fetchAffinity({ maxPeople = 5000, maxCompanies = 5000, includeNotes = true, key } = {}) {
  const organizations = await pageThrough("/organizations", "organizations", maxCompanies, key);
  const persons = await pageThrough("/persons", "persons", maxPeople, key);
  let notes = [];
  if (includeNotes) {
    try {
      notes = await pageThrough("/notes", "notes", 10000, key);
    } catch (err) {
      // Notes can be permission-gated; missing them shouldn't fail the pull.
      console.error(`affinity: skipping notes (${err.message})`);
    }
  }
  return docsFromAffinity({ persons, organizations, notes });
}
