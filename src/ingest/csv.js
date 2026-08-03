import { readFileSync } from "node:fs";

/**
 * CRM contacts CSV adapter — works with Attio, Affinity, HubSpot, or any
 * spreadsheet export. Auto-detects name/email/company columns from the header.
 */
export function loadCsv(path) {
  const rows = parseCsv(readFileSync(path, "utf8"));
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());

  const emailCol = header.findIndex((h) => h.includes("email"));
  const nameCol = header.findIndex((h) =>
    ["name", "full name", "contact", "contact name", "person"].includes(h)
  );
  const firstCol = header.findIndex((h) => h === "first name" || h === "firstname");
  const lastCol = header.findIndex((h) => h === "last name" || h === "lastname");
  const orgCol = header.findIndex((h) =>
    ["company", "company name", "organisation", "organization", "org", "employer", "account", "firm"].includes(h)
  );
  if (emailCol === -1 && nameCol === -1 && firstCol === -1) {
    throw new Error(`no name or email column found in header: ${header.join(", ")}`);
  }

  const docs = [];
  rows.slice(1).forEach((row, i) => {
    const email = emailCol >= 0 ? row[emailCol]?.trim() : null;
    let name = nameCol >= 0 ? row[nameCol]?.trim() : null;
    if (!name && firstCol >= 0) {
      name = [row[firstCol], lastCol >= 0 ? row[lastCol] : null].filter(Boolean).join(" ").trim();
    }
    if (!name && !email) return;
    const org = orgCol >= 0 ? row[orgCol]?.trim() : null;
    docs.push({
      source: "crm",
      kind: "record",
      external_id: email || `csv-row-${i + 2}`,
      title: `Contact: ${name ?? email}`,
      occurred_at: null,
      people: [{ name: name || null, email: email || null, org: org || null, role: "mentioned" }],
      orgs: org ? [org] : [],
    });
  });
  return docs;
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
