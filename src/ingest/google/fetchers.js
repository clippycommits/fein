import { authorize, apiGet } from "./client.js";
import { parseAddressList } from "../mbox.js";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CAL = "https://www.googleapis.com/calendar/v3";
const DRIVE = "https://www.googleapis.com/drive/v3";

export async function fetchGmail({ query = "", max = 300 } = {}) {
  const token = await authorize();
  const ids = [];
  let page = null;
  while (ids.length < max) {
    const params = new URLSearchParams({ maxResults: String(Math.min(100, max - ids.length)) });
    if (query) params.set("q", query);
    if (page) params.set("pageToken", page);
    const res = await apiGet(token, `${GMAIL}/messages?${params}`);
    for (const m of res.messages ?? []) ids.push(m.id);
    page = res.nextPageToken;
    if (!page || !(res.messages ?? []).length) break;
  }

  const docs = [];
  for (const id of ids) {
    const meta = await apiGet(
      token,
      `${GMAIL}/messages/${id}?format=metadata` +
        "&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc" +
        "&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID"
    );
    const h = Object.fromEntries(
      (meta.payload?.headers ?? []).map((x) => [x.name.toLowerCase(), x.value])
    );
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
      external_id: (h["message-id"] ?? id).replace(/[<>]/g, ""),
      title: h.subject || "(no subject)",
      occurred_at: date && !isNaN(date) ? date.toISOString() : null,
      people,
    });
  }
  return docs;
}

export async function fetchCalendar({ days = 365, max = 1000 } = {}) {
  const token = await authorize();
  const timeMin = new Date(Date.now() - days * 86400000).toISOString();
  const docs = [];
  let page = null;
  while (docs.length < max) {
    const params = new URLSearchParams({
      timeMin, singleEvents: "true", maxResults: "250", orderBy: "startTime",
    });
    if (page) params.set("pageToken", page);
    const res = await apiGet(token, `${CAL}/calendars/primary/events?${params}`);
    for (const ev of res.items ?? []) {
      const people = [];
      for (const a of [...(ev.attendees ?? []), ev.organizer].filter(Boolean)) {
        if (a.email) people.push({ name: a.displayName ?? null, email: a.email, role: "attendee" });
      }
      if (!people.length) continue;
      docs.push({
        source: "calendar",
        kind: "event",
        external_id: ev.id,
        title: ev.summary ?? "(untitled event)",
        occurred_at: ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00Z` : null),
        people,
      });
    }
    page = res.nextPageToken;
    if (!page) break;
  }
  return docs;
}

export async function fetchDrive({ max = 500 } = {}) {
  const token = await authorize();
  const docs = [];
  let page = null;
  while (docs.length < max) {
    const params = new URLSearchParams({
      pageSize: "100",
      q: "trashed=false",
      fields:
        "nextPageToken,files(id,name,createdTime,modifiedTime," +
        "owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress)," +
        "permissions(displayName,emailAddress))",
    });
    if (page) params.set("pageToken", page);
    const res = await apiGet(token, `${DRIVE}/files?${params}`);
    for (const f of res.files ?? []) {
      const people = [];
      for (const o of f.owners ?? []) {
        people.push({ name: o.displayName ?? null, email: o.emailAddress ?? null, role: "author" });
      }
      if (f.lastModifyingUser?.emailAddress) {
        people.push({
          name: f.lastModifyingUser.displayName ?? null,
          email: f.lastModifyingUser.emailAddress, role: "author",
        });
      }
      for (const p of f.permissions ?? []) {
        if (p.emailAddress) people.push({ name: p.displayName ?? null, email: p.emailAddress, role: "mentioned" });
      }
      if (!people.length) continue;
      docs.push({
        source: "drive",
        kind: "doc",
        external_id: f.id,
        title: f.name ?? "(untitled file)",
        occurred_at: f.modifiedTime ?? f.createdTime ?? null,
        people,
      });
    }
    page = res.nextPageToken;
    if (!page) break;
  }
  return docs;
}
