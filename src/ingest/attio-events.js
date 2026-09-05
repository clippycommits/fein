/**
 * Attio events — list entries as relationship evidence.
 *
 * A CRM that runs events keeps one Attio list per event (a dinner, a
 * cocktail party, a summit) and one entry per guest, with the guest's
 * journey recorded in list attributes: invited, RSVP'd, declined, attended.
 * Each of those is a dated touch between the firm and the guest, and the
 * room itself is evidence that the guests met. This module turns that into
 * documents the graph already understands; it holds no network code (the
 * Attio adapter fetches, this maps) so the rules are testable offline.
 *
 * The rules are deliberately generic: any list whose name ends in a date is
 * an event, any attribute that reads like an attendance/RSVP/invite field
 * decides the tier. Firms that name lists differently pin dates with
 * ATTIO_EVENT_DATES (`{"<list slug>": "YYYY-MM-DD"}`).
 *
 * Tiers, strongest first:
 *   attended  — kind `event`   (they were in the room)
 *   rsvp      — kind `rsvp`    (they said yes)
 *   declined  — kind `invite`  (they answered no — still a touch)
 *   invited   — kind `invite`  (the invitation went out)
 *   null      — on the list but never contacted; no document
 *
 * A past event's guest list is, by definition, a list of people who were
 * invited: membership alone counts as `invited` once the date has passed.
 * For a future event membership alone is a draft and produces nothing —
 * the next sync picks the guest up when the invitation actually goes out.
 */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** "Cannes Closing Set · Jun 25, 2026" -> "2026-06-25". Null when the name carries no date. */
export function parseEventDate(name) {
  const m = /(?:·|-|–|—)\s*([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\s*$/.exec(name ?? "");
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!month) return null;
  const day = Number(m[2]);
  if (day < 1 || day > 31) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * ATTIO_EVENT_DATES: `{"human_attention_summit_2026": "2026-04-07", ...}`.
 * Lists named here are events even when their names carry no date.
 */
export function parseEventDates(raw) {
  if (!raw) return {};
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("ATTIO_EVENT_DATES must be a JSON object of {\"<list slug>\": \"YYYY-MM-DD\"}");
  }
  const out = {};
  for (const [slug, date] of Object.entries(obj ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error(`ATTIO_EVENT_DATES: "${slug}" needs a YYYY-MM-DD date`);
    out[slug] = String(date);
  }
  return out;
}

/**
 * Who hosts. ATTIO_EVENT_HOST is the firm's events desk — the person every
 * event touch is attributed to when the entry says nothing more specific
 * ("Jess Webber <jess@example.com>"). ATTIO_EVENT_HOST_MAP maps a lowercase
 * token found in an "added by" / "invited by" value to a specific host
 * (`{"joe": "Joe Marchese <joe@example.com>"}`), so "Human - Joe" credits
 * Joe's relationship rather than the desk's. Without a host the touches
 * still land as guest-only documents: history and cohorts work, the
 * firm-side edge does not.
 */
export function parseHosts({ host, hostMap } = {}) {
  const parse = (s) => {
    const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(s ?? "");
    if (m) return { name: m[1] || null, email: m[2].trim().toLowerCase() };
    const t = String(s ?? "").trim();
    if (!t) return null;
    return t.includes("@") ? { name: null, email: t.toLowerCase() } : { name: t, email: null };
  };
  const out = { default: parse(host), byToken: {} };
  if (hostMap) {
    let obj;
    try {
      obj = JSON.parse(hostMap);
    } catch {
      throw new Error("ATTIO_EVENT_HOST_MAP must be a JSON object of {\"<token>\": \"Name <email>\"}");
    }
    for (const [token, who] of Object.entries(obj ?? {})) {
      const p = parse(who);
      if (p) out.byToken[token.toLowerCase()] = p;
    }
  }
  return out;
}

/* ---------- attribute readers: entry_values are arrays of typed cells ---------- */

function cellTitles(cells) {
  const out = [];
  for (const c of cells ?? []) {
    const t = c?.status?.title ?? c?.option?.title;
    if (typeof t === "string") out.push(t.trim());
  }
  return out;
}
function cellBool(cells) {
  return (cells ?? []).some((c) => c?.value === true);
}
function cellText(cells) {
  for (const c of cells ?? []) {
    const v = c?.value ?? c?.option?.title ?? c?.status?.title;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}
function cellPresent(cells) {
  return (cells ?? []).some((c) => c && (c.value !== undefined && c.value !== null && c.value !== false && c.value !== ""));
}

// Only attributes that read like a guest's journey may decide the tier.
// A "priority" flag or an "approved by" review column also says Yes/No,
// and must never count as a touch.
const TIER_KEY = /rsvp|attend|checked|stage|status|response|invit|gatsby|day_\d/i;
const NOT_TIER_KEY = /approved|research|priority|review|wave|tier|overlap|reminder|source/i;

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9+ ]/g, " ").replace(/\s+/g, " ").trim();
const ATTENDED = new Set(["attended", "checked in", "checkedin"]);
const RSVP_YES = new Set(["yes", "yes +1", "yes plus one", "accepted", "confirmed", "attending", "going",
  "friend", "cocktails only", "staff extra", "staff/extra", "yes per invite sheet"]);
const DECLINED = new Set(["no", "declined", "decline", "cancelled", "canceled", "email declined", "did not attend", "not attending"]);
const INVITED = new Set(["invited", "sent", "maybe", "waitlist", "tentative", "in progress tentative", "hold",
  "no response", "bounced", "bounced hard", "bounced temporary delay", "bounced need new email", "info needed",
  "requested info", "unknown", "fee requested", "need new email", "in progress"]);
// Explicitly not yet contacted — overrides the past-event membership rule.
const NOT_SENT = new Set(["not sent", "not yet sent", "not sent yet", "not invited", "not invited yet", "future wave", "for review", "n a", "na"]);

/**
 * Decide a guest's tier from an entry's values. `past` says whether the
 * event date has passed (membership on a past event's list = invited).
 * Returns { tier, evidence } — the evidence is the attribute and value that
 * decided it, kept on the document so every touch carries its receipt.
 */
export function classifyTier(values, { past } = {}) {
  let best = null;
  let evidence = null;
  let explicitlyNotSent = false;
  const consider = (tier, ev) => {
    const rank = { attended: 4, rsvp: 3, declined: 2, invited: 1 };
    if (!best || rank[tier] > rank[best]) { best = tier; evidence = ev; }
  };
  for (const [key, cells] of Object.entries(values ?? {})) {
    if (!TIER_KEY.test(key) || NOT_TIER_KEY.test(key)) continue;
    if (/^(entry_id|created_at|created_by)$/.test(key)) continue;
    const type = cells?.[0]?.attribute_type;
    if (type === "checkbox") {
      if (!cellBool(cells)) continue;
      if (/attend|checked|day_\d/i.test(key)) consider("attended", `${key}=true`);
      else if (/accepted|confirm/i.test(key)) consider("rsvp", `${key}=true`);
      else if (/invit|sent|gatsby/i.test(key)) consider("invited", `${key}=true`);
      continue;
    }
    if (type === "date" || type === "timestamp") {
      if (cellPresent(cells) && /invit|sent/i.test(key)) consider("invited", `${key}=${cellText(cells)}`);
      continue;
    }
    if (type === "select" || type === "status") {
      for (const title of cellTitles(cells)) {
        const t = norm(title);
        if (ATTENDED.has(t)) consider("attended", `${key}=${title}`);
        else if (RSVP_YES.has(t)) consider("rsvp", `${key}=${title}`);
        else if (DECLINED.has(t)) consider("declined", `${key}=${title}`);
        else if (INVITED.has(t)) consider("invited", `${key}=${title}`);
        else if (NOT_SENT.has(t)) explicitlyNotSent = true;
      }
      continue;
    }
    // Free-text RSVP columns ("Yes", "No") on older sheets.
    if (type === "text" && /^rsvp$/i.test(key)) {
      const t = norm(cellText(cells) ?? "");
      if (RSVP_YES.has(t)) consider("rsvp", `${key}=${cellText(cells)}`);
      else if (DECLINED.has(t)) consider("declined", `${key}=${cellText(cells)}`);
    }
  }
  if (!best && past && !explicitlyNotSent) return { tier: "invited", evidence: "on the guest list of a past event" };
  return { tier: best, evidence };
}

const KIND_OF = { attended: "event", rsvp: "rsvp", declined: "invite", invited: "invite" };
const LABEL_OF = { attended: "attended", rsvp: "RSVP'd yes", declined: "declined", invited: "invited" };

// Values in "added by" / "invited by" that mean the firm itself.
const isFirmToken = (v, firmPattern) => firmPattern.test(v);
// "Rich Greenfield", "Kathryn Minshew" — a person, not a partner org.
const ORG_WORDS = /\b(Team|Partners?|Ventures|List|Network|Inc|LLC|Media|Group|Discourse|Entertainment|Capital|Studios?|Labs?|Agency|Fund|Holdings|Company|Co|Corp|Digital|Global|Advisors|Collective|Club|Society|Foundation|Institute)\b/i;
const looksLikePerson = (v) => /^[A-Z][\w'’.-]+(?: [A-Z][\w'’.-]+){1,2}$/.test(v) && !ORG_WORDS.test(v);
// A spreadsheet tab, an invite wave, a "manual list": provenance, never a party.
const isProvenance = (v) => /\b(list|wave|manual|sheet|export|tab|wb)\b|\d{2,}/i.test(v);
// "Walt Piecyk (LightShed)", "Heather Hartnett | HH" → ["Walt Piecyk", "LightShed"].
function splitSuffix(v) {
  const m = /^(.*?)\s*(?:\(([^)]*)\)|\|\s*(.*))\s*$/.exec(v);
  if (!m) return [v.trim(), null];
  const suffix = (m[2] ?? m[3] ?? "").trim();
  return [m[1].trim(), suffix || null];
}
function orgLike(v, orgNames) {
  if (!v) return false;
  const lower = v.toLowerCase();
  if (orgNames.has(lower)) return true;
  const words = v.split(/\s+/).length;
  // Four or more capitalised words with no company word is two names run
  // together or a sentence, not an organization — leave it as provenance.
  if (words >= 4) return ORG_WORDS.test(v);
  if (words >= 2) return !looksLikePerson(v);
  return /[a-z][A-Z]/.test(v); // OpenAP, LightShed, iConnections — but not HOST or Ben
}

/**
 * Attribution for one entry: who brought the guest.
 *   host    — the firm-side person on the document (a mapped host, else the default)
 *   inviter — a named third party who invited them (person mention, role `from`)
 *   org     — a partner organization that supplied the guest (org mention)
 * `orgNames` (lowercased company names known to the workspace) lets a
 * one-word value like "Publicis" count as an org while "Ben" stays a note.
 */
export function attributeEntry(values, hosts, { firmPattern, orgNames = new Set() }) {
  const raw = [];
  for (const key of ["added_by", "invited_by", "invite_source", "source_list", "source_lists"]) {
    const v = cellText(values?.[key]);
    if (v) raw.push({ key, value: v });
  }
  let host = hosts.default;
  const inviters = [];
  const orgs = [];
  const addOrg = (o) => { if (o && !orgs.some((x) => x.toLowerCase() === o.toLowerCase())) orgs.push(o); };
  for (const { key, value } of raw) {
    if (key === "source_list" || key === "source_lists") continue; // a spreadsheet tab, not a person
    // "Rich Greenfield, David Birnbaum", "Rich Greenfield and CAA", "Jess / Joe": several parties.
    for (const part of value.split(/\s*(?:,|&|\/|;|\band\b|\bvia\b|\bthrough\b|\bw\/)\s*/i).map((p) => p.trim()).filter(Boolean)) {
      const lower = part.toLowerCase();
      // "Human - Joe", "Human Ventures - Jess", "Joe Marchese": a token maps to a specific host.
      const mapped = Object.entries(hosts.byToken).find(([token]) => new RegExp(`(^|[^a-z])${token}([^a-z]|$)`).test(lower));
      if (mapped) { host = mapped[1]; continue; }
      if (isFirmToken(part, firmPattern) || isProvenance(part)) continue;
      const [main, suffix] = splitSuffix(part);
      if (orgNames.has(main.toLowerCase())) { addOrg(main); continue; }
      if (looksLikePerson(main)) {
        if (!inviters.some((i) => i.name.toLowerCase() === main.toLowerCase())) inviters.push({ name: main, email: null });
        if (suffix && orgLike(suffix, orgNames)) addOrg(suffix);
        continue;
      }
      if (orgLike(main, orgNames)) addOrg(main);
    }
  }
  // `inviter` / `org` keep the first of each for callers that want one; the arrays carry all.
  return { host, inviter: inviters[0] ?? null, inviters, org: orgs[0] ?? null, orgs, raw };
}

/**
 * The events in a workspace: every list whose name ends in a date, plus the
 * ones pinned in ATTIO_EVENT_DATES. Non-event lists (prospect research, a
 * priority list, a founder directory) are left to the people/companies pull.
 */
export function eventsFromLists(lists, { dates = {}, now = Date.now() } = {}) {
  const out = [];
  for (const l of lists ?? []) {
    // Attio returns parent_object as a one-element array on /lists and a string on entries.
    const parent = Array.isArray(l.parent_object) ? l.parent_object[0] : l.parent_object;
    if (parent && parent !== "people") continue; // company lists are not guest lists
    const slug = l.api_slug;
    const date = dates[slug] ?? parseEventDate(l.name);
    if (!date) continue;
    out.push({
      listId: l.id?.list_id ?? l.id,
      slug,
      name: l.name,
      date,
      occurredAt: `${date}T12:00:00.000Z`,
      past: new Date(`${date}T23:59:59Z`).getTime() < now,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Documents for one event's entries. `peopleById` maps an Attio person
 * record id to { name, emails, org } (the same identity the people pull
 * emits, so both resolve to one entity). Emits one touch document per
 * contacted guest and one cohort document per event for the people who
 * were in the room (attended when the list tracks attendance, else the
 * RSVP'd-yes guests of a past event).
 */
export function docsFromEventEntries(event, entries, peopleById, { hosts, firmPattern, orgNames = new Set(), cohortMin = 2 } = {}) {
  const docs = [];
  const room = [];
  const tallies = { attended: 0, rsvp: 0, declined: 0, invited: 0, skipped: 0 };
  let attendanceTracked = false;
  const hostMention = (h, role) => (h ? { name: h.name, email: h.email, role } : null);

  for (const e of entries ?? []) {
    if (e.parent_object && e.parent_object !== "people") continue;
    const person = peopleById.get(e.parent_record_id);
    if (!person || (!person.name && !person.emails?.length)) { tallies.skipped++; continue; }
    const values = e.entry_values ?? {};
    if (Object.keys(values).some((k) => /attend|checked/i.test(k) && !NOT_TIER_KEY.test(k))) attendanceTracked = true;
    const { tier, evidence } = classifyTier(values, { past: event.past });
    if (!tier) { tallies.skipped++; continue; }
    tallies[tier]++;
    const { host, inviters, orgs: partnerOrgs, raw } = attributeEntry(values, hosts, { firmPattern, orgNames });
    const guestRole = tier === "attended" ? "attendee" : "to";
    const guest = { name: person.name, email: person.emails?.[0] ?? null, org: person.org ?? null, role: guestRole };
    const people = [guest];
    const h = hostMention(host, "author");
    if (h) people.push(h);
    for (const inviter of inviters) people.push({ ...inviter, role: "from" });
    const inviter = inviters[0] ?? null;
    const org = partnerOrgs[0] ?? null;
    const extras = {};
    for (const key of ["vip", "priority_get", "cannes_speaker", "marquee_250", "host_committee", "sports", "in_agenda", "role", "segment", "type", "category", "attendee_segment", "invite_tier", "invite_wave"]) {
      const v = values[key];
      if (!v?.length) continue;
      const val = v[0]?.attribute_type === "checkbox" ? cellBool(v) : cellText(v);
      if (val !== null && val !== false) extras[key] = val;
    }
    docs.push({
      source: "attio",
      kind: KIND_OF[tier],
      external_id: `attio-entry-${e.id?.entry_id ?? e.id}`,
      title: `${event.name} — ${LABEL_OF[tier]}`,
      occurred_at: event.occurredAt,
      people,
      orgs: partnerOrgs,
      raw: {
        event: event.slug,
        event_name: event.name,
        event_date: event.date,
        tier,
        evidence,
        guest: { name: person.name, email: guest.email },
        host: host ? { name: host.name, email: host.email } : null,
        ...(inviter ? { invited_by: inviters.map((i) => i.name).join(", ") } : {}),
        ...(org ? { via: partnerOrgs.join(", ") } : {}),
        ...(raw.length ? { attribution: raw } : {}),
        ...(Object.keys(extras).length ? { attributes: extras } : {}),
      },
    });
    if (tier === "attended") room.push({ person, basis: "attended" });
    else if (tier === "rsvp") room.push({ person, basis: "rsvp" });
  }

  // The room: attended guests when attendance is tracked; otherwise, for an
  // event that has happened, the yes-RSVPs are the best available record.
  const basis = attendanceTracked ? "attended" : event.past ? "rsvp" : null;
  const inRoom = basis ? room.filter((r) => r.basis === basis) : [];
  if (inRoom.length >= cohortMin) {
    docs.push({
      source: "attio",
      kind: "cohort",
      external_id: `attio-list-${event.listId}-cohort`,
      title: `${event.name} — in the room (${inRoom.length}, ${basis === "attended" ? "attended" : "RSVP'd yes"})`,
      occurred_at: event.occurredAt,
      people: inRoom.map(({ person }) => ({ name: person.name, email: person.emails?.[0] ?? null, org: person.org ?? null, role: "attendee" })),
      orgs: [],
      raw: { event: event.slug, event_name: event.name, event_date: event.date, cohort: true, basis, size: inRoom.length },
    });
  }
  return { docs, tallies, cohort: inRoom.length, basis };
}
