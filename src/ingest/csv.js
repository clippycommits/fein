import { readFileSync } from "node:fs";

/**
 * Contacts CSV adapter — works with Google Contacts / Workspace Takeout,
 * Attio, Affinity, HubSpot, or any spreadsheet export. Column names differ
 * wildly between tools ("Email", "E-mail 1 - Value", "Primary Email"), so
 * headers are normalized before matching.
 */
import { linkedInHeaderRow, docsFromLinkedIn } from "./linkedin.js";

const norm = (h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

export function loadCsv(path) {
  const rows = parseCsv(readFileSync(path, "utf8"));
  // A LinkedIn Connections.csv is a CSV too — the dedicated adapter keeps
  // its "Connected On" timing signal, which the generic mapping would drop.
  const liHeader = linkedInHeaderRow(rows);
  if (liHeader !== -1) return docsFromLinkedIn(rows, liHeader);
  if (rows.length < 2) return [];
  const header = rows[0].map(norm);

  // Google exports numbered, labelled columns ("E-mail 1 - Value"); take the
  // value columns in order, and never the "label"/"type" ones beside them.
  const emailCols = header
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h.includes("email") && !/(label|type)$/.test(h))
    .map(({ i }) => i);

  // Exact-only: a partial match on "name" would grab "First Name" and drop
  // the surname. Split first/last columns are handled below instead.
  const nameCol = findCol(header, ["fullname", "displayname", "contactname", "name", "contact", "person"],
    { exactOnly: true });
  const firstCol = findCol(header, ["firstname", "givenname"]);
  const middleCol = findCol(header, ["middlename"]);
  const lastCol = findCol(header, ["lastname", "familyname", "surname"]);
  const orgCol = findCol(header, [
    "company", "companyname", "organisation", "organization", "organizationname",
    "organisationname", "org", "employer", "account", "accountname", "firm",
  ]);
  // CRM notes fields are unstructured gold ("intro'd by X", "knows Y at Z") —
  // captured as the document body for the extraction pipeline.
  const notesCol = findCol(header, ["notes", "note", "description", "comments", "background"]);

  if (!emailCols.length && nameCol === -1 && firstCol === -1) {
    throw new Error(
      `no name or email column found. Header was: ${rows[0].join(", ")}`
    );
  }

  const docs = [];
  rows.slice(1).forEach((row, i) => {
    const emails = emailCols.map((c) => row[c]?.trim()).filter((e) => e && e.includes("@"));
    // Split columns win: they carry the full name, a lone "Name" column may not.
    let name = null;
    if (firstCol >= 0 || lastCol >= 0) {
      name = [firstCol >= 0 ? row[firstCol] : null,
              middleCol >= 0 ? row[middleCol] : null,
              lastCol >= 0 ? row[lastCol] : null]
        .map((p) => p?.trim())
        .filter(Boolean)
        .join(" ");
    }
    if (!name && nameCol >= 0) name = row[nameCol]?.trim();
    if (!name && !emails.length) return;
    const org = orgCol >= 0 ? row[orgCol]?.trim() : null;

    // A contact with several addresses becomes several mentions of one person,
    // so entity resolution links the addresses together rather than splitting.
    const people = emails.length
      ? emails.map((email) => ({ name: name || null, email, org: org || null, role: "mentioned" }))
      : [{ name, email: null, org: org || null, role: "mentioned" }];

    const notes = notesCol >= 0 ? row[notesCol]?.trim() : null;
    docs.push({
      source: "crm",
      kind: "record",
      external_id: emails[0] || `csv-row-${i + 2}`,
      title: `Contact: ${name || emails[0]}`,
      occurred_at: null,
      people,
      orgs: org ? [org] : [],
      ...(notes ? { body: notes } : {}),
    });
  });
  return docs;
}

function findCol(header, candidates, { exactOnly = false } = {}) {
  for (const c of candidates) {
    const exact = header.indexOf(c);
    if (exact !== -1) return exact;
  }
  if (exactOnly) return -1;
  // Fall back to a column that merely contains the term ("organizationname1").
  for (const c of candidates) {
    const partial = header.findIndex((h) => h.includes(c));
    if (partial !== -1) return partial;
  }
  return -1;
}

/** Minimal RFC 4180 parser: quoted fields, "" escapes, newlines in quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}
