import { execFileSync } from "node:child_process";
import { env } from "../brand.js";
import { parseAddressList } from "./mbox.js";

/**
 * gog adapter — pulls live Google data through the gog CLI
 * (https://github.com/steipete/gogcli), reusing its already-consented OAuth
 * instead of asking you to set up a Google Cloud project.
 *
 * Runs `gog` locally, or on a remote host over SSH when FEIN_GOG_SSH (legacy FUNDGRAPH_GOG_SSH) is
 * set (e.g. "root@my-server" that has an authenticated gog). Only metadata is
 * fetched — message bodies are never requested.
 */

const SSH_HOST = () => env("GOG_SSH") ?? null;

function shq(arg) {
  return `'${String(arg).replaceAll("'", `'\\''`)}'`;
}

function runRemote(script) {
  return execFileSync(
    "ssh",
    [SSH_HOST(), `export GOG_KEYRING_PASSWORD=$(cat ~/.gog_keyring 2>/dev/null); ${script}`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
}

function gogJson(args) {
  const out = SSH_HOST()
    ? runRemote(`gog ${args.map(shq).join(" ")}`)
    : execFileSync("gog", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

/** One round-trip per batch: emits one metadata JSON object per line. */
function gmailMetadataBatch(ids) {
  if (SSH_HOST()) {
    const script =
      `for id in ${ids.map(shq).join(" ")}; do ` +
      `gog gmail get "$id" --format metadata --json | tr -d '\\n'; echo; done`;
    return runRemote(script)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  return ids.map((id) =>
    JSON.parse(execFileSync("gog", ["gmail", "get", id, "--format", "metadata", "--json"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }))
  );
}

export function fetchGogGmail({ query = "in:anywhere", max = 200 } = {}) {
  const ids = [];
  let page = null;
  while (ids.length < max) {
    const args = ["gmail", "messages", "list", query,
      "--max", String(Math.min(100, max - ids.length)), "--json"];
    if (page) args.push("--page", page);
    const res = gogJson(args);
    for (const m of res.messages ?? []) ids.push(m.id);
    page = res.nextPageToken;
    if (!page || !(res.messages ?? []).length) break;
  }

  const docs = [];
  for (let i = 0; i < ids.length; i += 25) {
    for (const meta of gmailMetadataBatch(ids.slice(i, i + 25))) {
      const h = meta.headers ?? {};
      const people = [
        ...parseAddressList(h.from).map((p) => ({ ...p, role: "from" })),
        ...parseAddressList(h.to).map((p) => ({ ...p, role: "to" })),
        ...parseAddressList(h.cc).map((p) => ({ ...p, role: "cc" })),
      ];
      if (!people.length) continue;
      const date = h.date ? new Date(h.date) : null;
      docs.push({
        source: "gmail",
        kind: "email",
        external_id: (h.message_id ?? meta.message?.id ?? "").replace(/[<>]/g, "") || null,
        title: h.subject || "(no subject)",
        occurred_at: date && !isNaN(date) ? date.toISOString() : null,
        people,
      });
    }
  }
  return docs;
}

export function fetchGogCalendar({ max = 500 } = {}) {
  const res = gogJson(["calendar", "events", "list", "--max", String(max), "--json"]);
  const events = res.events ?? res.items ?? (Array.isArray(res) ? res : []);
  const docs = [];
  for (const ev of events) {
    const people = [];
    for (const a of [...(ev.attendees ?? []), ev.organizer].filter(Boolean)) {
      if (a.email) people.push({ name: a.displayName ?? null, email: a.email, role: "attendee" });
    }
    if (!people.length) continue;
    docs.push({
      source: "calendar",
      kind: "event",
      external_id: ev.id ?? null,
      title: ev.summary ?? "(untitled event)",
      occurred_at: ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00Z` : null),
      people,
    });
  }
  return docs;
}

export function fetchGogDrive({ max = 500 } = {}) {
  const res = gogJson(["drive", "ls", "--max", String(max), "--json"]);
  const files = res.files ?? res.items ?? (Array.isArray(res) ? res : []);
  const docs = [];
  for (const f of files) {
    const people = [];
    for (const o of f.owners ?? []) {
      if (o.emailAddress || o.displayName) {
        people.push({ name: o.displayName ?? null, email: o.emailAddress ?? null, role: "author" });
      }
    }
    const lm = f.lastModifyingUser;
    if (lm && (lm.emailAddress || lm.displayName)) {
      people.push({ name: lm.displayName ?? null, email: lm.emailAddress ?? null, role: "author" });
    }
    for (const p of f.permissions ?? []) {
      if (p.emailAddress) people.push({ name: p.displayName ?? null, email: p.emailAddress, role: "mentioned" });
    }
    if (!people.length) continue;
    docs.push({
      source: "drive",
      kind: "doc",
      external_id: f.id ?? null,
      title: f.name ?? "(untitled file)",
      occurred_at: f.modifiedTime ?? f.createdTime ?? null,
      people,
    });
  }
  return docs;
}
