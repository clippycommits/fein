/**
 * Attio adapter — pulls people, companies, (optionally) notes, and event
 * lists from an Attio workspace via the REST API v2.
 *
 * Auth: create an access token in Attio → Workspace settings → Developers →
 * "Create integration"/API key, grant it read scopes for the objects you want
 * (record:read, object_configuration:read, and note:read for notes), then set
 * ATTIO_API_KEY.
 *
 * Attio's data model is a table of records with attribute arrays; only
 * identity attributes are read (names, email addresses, company links,
 * note participants) — never note bodies or deal content.
 */

import { eventsFromLists, docsFromEventEntries, parseEventDates, parseHosts } from "./attio-events.js";

const API = "https://api.attio.com/v2";
const PAGE = 500; // Attio's max page size for record queries
const ALL = Number.MAX_SAFE_INTEGER;

function apiKey(explicit) {
  const key = explicit ?? process.env.ATTIO_API_KEY;
  if (!key) {
    throw new Error(
      "no Attio API key — paste one in the dashboard's Data tab, or set " +
      "ATTIO_API_KEY. Create it in Attio under Workspace settings → " +
      "Developers, with read access to records (and notes, if you want them)"
    );
  }
  return key;
}

async function attio(path, { method = "POST", body, key } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${apiKey(key)}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Attio rejected the API key (${res.status}). Check the token and its scopes: ${text.slice(0, 200)}`);
    }
    if (res.status === 404) {
      throw new Error(`Attio object not found (${path}) — does this workspace use a custom object name? ${text.slice(0, 200)}`);
    }
    throw new Error(`Attio ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Cheap credential check: confirms the token is valid and reports what it can
 * see, without pulling the workspace. Returns { workspace, scopes }.
 */
export async function verifyAttioKey(key) {
  const res = await fetch(`${API}/self`, {
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("Attio rejected that API key — check it was copied whole and is still active");
  }
  if (res.ok) {
    const body = await res.json().catch(() => ({}));
    const d = body.data ?? body;
    return {
      workspace: d.workspace_name ?? d.workspace_id ?? null,
      scopes: Array.isArray(d.scopes) ? d.scopes : typeof d.scope === "string" ? d.scope.split(/[\s,]+/) : [],
    };
  }
  // Older tokens or a changed endpoint: fall back to a minimal record query.
  await attio(`/objects/people/records/query`, { body: { limit: 1 }, key });
  return { workspace: null, scopes: [] };
}

/** Page through an object's records. */
async function queryRecords(object, max, key) {
  const out = [];
  let offset = 0;
  while (out.length < max) {
    const res = await attio(`/objects/${object}/records/query`, {
      body: { limit: Math.min(PAGE, max - out.length), offset },
      key,
    });
    const batch = res.data ?? [];
    out.push(...batch);
    if (batch.length < PAGE) break;
    offset += batch.length;
  }
  return out;
}

/* ---------- attribute readers (Attio values are arrays of typed cells) ---------- */

const cells = (record, attr) => record?.values?.[attr] ?? [];

function personName(record) {
  for (const c of cells(record, "name")) {
    if (c.full_name) return c.full_name;
    const parts = [c.first_name, c.last_name].filter(Boolean);
    if (parts.length) return parts.join(" ");
  }
  return null;
}

function personEmails(record) {
  return cells(record, "email_addresses")
    .map((c) => c.email_address ?? c.value ?? c.original_email_address)
    .filter((e) => typeof e === "string" && e.includes("@"));
}

function companyName(record) {
  for (const c of cells(record, "name")) {
    const v = c.value ?? c.full_name;
    if (v) return v;
  }
  return null;
}

/** Person -> company link, so a contact carries its org for entity resolution. */
function linkedCompanyIds(record) {
  return cells(record, "company")
    .map((c) => c.target_record_id)
    .filter(Boolean);
}

function recordId(record) {
  return record?.id?.record_id ?? null;
}

function timestamp(record) {
  const t = record?.created_at ?? record?.values?.created_at?.[0]?.value;
  if (!t) return null;
  const d = new Date(t);
  return isNaN(d) ? null : d.toISOString();
}

/**
 * Fetch people + companies as documents. Each person becomes one CRM record
 * carrying every known address (so resolution links the addresses together)
 * and their linked company name as the org hint. Event lists (see
 * ./attio-events.js) follow, unless `includeEvents` is false.
 */
export async function fetchAttio({ maxPeople = ALL, maxCompanies = ALL, includeNotes = true, includeEvents = true, key, now = Date.now(), log = console.error } = {}) {
  const companies = await queryRecords("companies", maxCompanies, key);
  const people = await queryRecords("people", maxPeople, key);
  const { docs, peopleById, orgNames } = docsFromAttioRecords({ companies, people });

  if (includeNotes) {
    try {
      docs.push(...(await fetchAttioNotes(people, key)));
    } catch (err) {
      // Notes need a separate scope; missing it shouldn't fail the whole pull.
      log(`attio: skipping notes (${err.message})`);
    }
  }

  if (includeEvents) {
    try {
      const events = await fetchAttioEvents(peopleById, { key, now, log, orgNames });
      docs.push(...events.docs);
    } catch (err) {
      // Lists need `list_entry:read`; a token without it still yields the CRM.
      log(`attio: skipping event lists (${err.message})`);
    }
  }
  return docs;
}

/** Pure mapping of Attio people + companies to documents (network-free, for tests). */
export function docsFromAttioRecords({ companies = [], people = [] }) {
  const companyNameById = new Map();
  for (const c of companies) {
    const id = recordId(c);
    const name = companyName(c);
    if (id && name) companyNameById.set(id, name);
  }

  const docs = [];
  for (const c of companies) {
    const name = companyName(c);
    if (!name) continue;
    docs.push({
      source: "attio",
      kind: "record",
      external_id: `attio-company-${recordId(c)}`,
      title: `Company: ${name}`,
      occurred_at: timestamp(c),
      people: [],
      orgs: [name],
    });
  }

  const peopleById = new Map();
  for (const p of people) {
    const name = personName(p);
    const emails = personEmails(p);
    if (!name && !emails.length) continue;
    const org = linkedCompanyIds(p).map((id) => companyNameById.get(id)).find(Boolean) ?? null;
    peopleById.set(recordId(p), { name, emails, org });
    const mentions = emails.length
      ? emails.map((email) => ({ name, email, org, role: "mentioned" }))
      : [{ name, email: null, org, role: "mentioned" }];
    docs.push({
      source: "attio",
      kind: "record",
      external_id: `attio-person-${recordId(p)}`,
      title: `Contact: ${name ?? emails[0]}`,
      occurred_at: timestamp(p),
      people: mentions,
      orgs: org ? [org] : [],
    });
  }
  const orgNames = new Set([...companyNameById.values()].map((n) => n.toLowerCase()));
  return { docs, peopleById, orgNames };
}

/**
 * Event lists: every list whose name ends in a date (or is pinned in
 * ATTIO_EVENT_DATES) is pulled entry by entry and mapped to touch + cohort
 * documents. Configuration is read from the environment so the scheduled
 * sync and the CLI agree:
 *   ATTIO_EVENT_HOST       "Name <email>" — the firm-side person on every touch
 *   ATTIO_EVENT_HOST_MAP   {"joe": "Joe X <joe@…>"} — "added by" tokens → hosts
 *   ATTIO_EVENT_DATES      {"<list slug>": "YYYY-MM-DD"} — undated list names
 *   ATTIO_FIRM_PATTERN     regex for "added by" values that mean the firm itself
 */
export async function fetchAttioEvents(peopleById, { key, now = Date.now(), log = console.error, orgNames = new Set() } = {}) {
  const lists = (await attio("/lists", { method: "GET", key })).data ?? [];
  const dates = parseEventDates(process.env.ATTIO_EVENT_DATES);
  const hosts = parseHosts({ host: process.env.ATTIO_EVENT_HOST, hostMap: process.env.ATTIO_EVENT_HOST_MAP });
  const firmPattern = new RegExp(process.env.ATTIO_FIRM_PATTERN || "^(human|hv|the firm|us|team|internal)\\b", "i");
  const events = eventsFromLists(lists, { dates, now });
  const docs = [];
  const summary = [];
  for (const event of events) {
    const entries = await queryEntries(event.listId, key);
    const res = docsFromEventEntries(event, entries, peopleById, { hosts, firmPattern, orgNames });
    docs.push(...res.docs);
    summary.push({ event: event.slug, date: event.date, entries: entries.length, ...res.tallies, cohort: res.cohort });
  }
  log(`attio: ${events.length} event lists → ${docs.length} documents`);
  return { docs, events: summary };
}

/** Page through a list's entries (needs the `list_entry:read` scope). */
async function queryEntries(listId, key) {
  const out = [];
  let offset = 0;
  while (true) {
    const res = await attio(`/lists/${listId}/entries/query`, { body: { limit: PAGE, offset }, key });
    const batch = res.data ?? [];
    out.push(...batch);
    if (batch.length < PAGE) break;
    offset += batch.length;
  }
  return out;
}

/**
 * Notes are the relationship signal in a CRM: a note on a person's record is
 * evidence of contact. Titles and participants only — never note bodies.
 */
async function fetchAttioNotes(people, key) {
  const byId = new Map();
  for (const p of people) {
    const id = recordId(p);
    if (id) byId.set(id, { name: personName(p), email: personEmails(p)[0] ?? null });
  }

  const notes = [];
  let offset = 0;
  const NOTES_PAGE = 50; // Attio caps /notes at 50 per page (records allow 500)
  while (true) {
    const res = await attio(`/notes?limit=${NOTES_PAGE}&offset=${offset}`, { method: "GET", key });
    const batch = res.data ?? [];
    notes.push(...batch);
    if (batch.length < NOTES_PAGE) break;
    offset += batch.length;
  }

  const docs = [];
  for (const n of notes) {
    const target = n.parent_record_id ?? n.parent_object_id;
    const person = byId.get(target);
    if (!person || (!person.name && !person.email)) continue;
    docs.push({
      source: "attio",
      kind: "note",
      external_id: `attio-note-${n.id?.note_id ?? n.id}`,
      title: n.title || "(untitled note)",
      occurred_at: n.created_at ? new Date(n.created_at).toISOString() : null,
      people: [{ name: person.name, email: person.email, role: "mentioned" }],
    });
  }
  return docs;
}
