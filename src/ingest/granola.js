import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CACHE = join(
  homedir(), "Library", "Application Support", "Granola", "cache-v3.json"
);

/**
 * Granola adapter — reads the local cache Granola keeps on macOS. Only
 * meeting titles, times, and attendee identities are taken; transcripts and
 * note bodies are never read. The cache format is undocumented and drifts,
 * so everything here is defensive.
 */
export function loadGranola(path = DEFAULT_CACHE) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `no Granola cache at ${path} — is Granola installed and has it synced? ` +
      `(Pass an explicit path if yours lives elsewhere.)`
    );
  }
  let state;
  try {
    const outer = JSON.parse(raw);
    state = typeof outer.cache === "string" ? JSON.parse(outer.cache).state : outer.state ?? outer;
  } catch (err) {
    throw new Error(`could not parse Granola cache (format may have changed): ${err.message}`);
  }

  const documents = asArray(state?.documents);
  const docs = [];
  for (const d of documents) {
    if (!d || typeof d !== "object") continue;
    const people = extractPeople(d);
    if (!people.length) continue;
    docs.push({
      source: "granola",
      kind: "meeting",
      external_id: d.id ?? d.document_id ?? null,
      title: d.title ?? d.name ?? "(untitled meeting)",
      occurred_at: toIso(d.created_at ?? d.createdAt ?? d.start_timestamp),
      people,
    });
  }
  if (!docs.length) {
    throw new Error(
      "Granola cache parsed but no meetings with attendees were found — " +
      "the cache format may have changed; please open an issue with your Granola version."
    );
  }
  return docs;
}

function extractPeople(doc) {
  const found = new Map(); // email|name -> person
  const push = (name, email) => {
    // Empty strings must not become a shared dedupe key (or a mention identity).
    name = (typeof name === "string" && name.trim()) || null;
    email = (typeof email === "string" && email.trim()) || null;
    if (!name && !email) return;
    const key = (email ?? name).toLowerCase();
    if (!found.has(key)) found.set(key, { name, email, role: "attendee" });
  };

  const p = doc.people;
  if (Array.isArray(p)) {
    for (const person of p) pushPerson(push, person);
  } else if (p && typeof p === "object") {
    pushPerson(push, p.creator);
    for (const a of asArray(p.attendees)) pushPerson(push, a);
  }
  for (const a of asArray(doc.google_calendar_event?.attendees)) pushPerson(push, a);
  return [...found.values()];
}

function pushPerson(push, person) {
  if (!person || typeof person !== "object") return;
  push(person.name ?? person.displayName ?? person.display_name ?? null,
       person.email ?? null);
}

function asArray(x) {
  if (Array.isArray(x)) return x;
  if (x && typeof x === "object") return Object.values(x);
  return [];
}

function toIso(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d) ? null : d.toISOString();
}
