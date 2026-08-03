import { readFileSync } from "node:fs";

/**
 * ICS calendar adapter — zero OAuth. Every calendar app exports .ics
 * (Google Calendar: Settings -> Import & export). Reads VEVENT attendees,
 * organizer, summary, and start time.
 */
export function loadIcs(path) {
  const raw = readFileSync(path, "utf8").replace(/\r?\n[ \t]/g, ""); // unfold
  const docs = [];
  let event = null;
  let depth = 0; // nesting inside VEVENT (VALARM etc.) — those properties are not the event's
  for (const line of raw.split(/\r?\n/)) {
    if (line === "BEGIN:VEVENT" && !event) {
      event = { people: [] };
      depth = 0;
      continue;
    }
    if (line === "END:VEVENT" && depth === 0) {
      if (event && event.people.length) {
        docs.push({
          source: "ics",
          kind: "event",
          external_id: event.uid ?? null,
          title: event.summary ?? "(untitled event)",
          occurred_at: event.start ?? null,
          people: event.people,
          ...(event.description ? { body: event.description } : {}),
        });
      }
      event = null;
      continue;
    }
    if (!event) continue;
    if (line.startsWith("BEGIN:")) { depth++; continue; }
    if (line.startsWith("END:")) { if (depth > 0) depth--; continue; }
    if (depth > 0) continue;

    const { name, params, value } = parseProp(line);
    if (!name) continue;
    if (name === "ATTENDEE" || name === "ORGANIZER") {
      const email = value.replace(/^mailto:/i, "").trim();
      if (email.includes("@")) {
        event.people.push({
          name: params.CN?.replace(/^"|"$/g, "") ?? null,
          email,
          role: "attendee",
        });
      }
    } else if (name === "SUMMARY") {
      event.summary = unescapeIcs(value);
    } else if (name === "DESCRIPTION") {
      // Agendas and dial-in notes routinely name people who aren't invitees —
      // captured as the body so extraction can mine them.
      event.description = unescapeIcsBody(value);
    } else if (name === "UID") {
      event.uid = value;
    } else if (name === "DTSTART") {
      event.start = parseIcsDate(value);
    }
  }
  return docs;
}

/** "ATTENDEE;CN=\"Chen, Maya\";RSVP=TRUE:mailto:x" -> {name, params, value} */
function parseProp(line) {
  let colon = -1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon === -1) return {};
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = splitOutsideQuotes(left, ";");
  const params = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return { name: name.toUpperCase(), params, value };
}

function splitOutsideQuotes(s, sep) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of s) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === sep && !inQuotes) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseIcsDate(value) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/);
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
  // Non-UTC local times are treated as UTC: hour-level offsets don't matter
  // for 180-day-half-life recency decay.
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

function unescapeIcs(s) {
  return s.replace(/\\n/g, " ").replace(/\\([,;\\])/g, "$1");
}

/** Like unescapeIcs, but \n stays a newline — descriptions are multi-line prose. */
function unescapeIcsBody(s) {
  return s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}
