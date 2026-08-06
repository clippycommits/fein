/**
 * LinkedIn Connections.csv adapter. The export (LinkedIn → Settings → Data
 * privacy → Get a copy of your data → Connections) is a CSV with a "Notes:"
 * preamble before the real header:
 *
 *   First Name,Last Name,URL,Email Address,Company,Position,Connected On
 *
 * loadCsv sniffs for that header and delegates here, so users just drag the
 * file in like any other CSV. "Connected On" becomes occurred_at — real
 * timing signal for edge strength and the relationship radar, which a
 * generic contacts CSV never carries.
 */

const norm = (h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
                 jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** "12 Mar 2021" -> "2021-03-12T00:00:00.000Z"; anything else -> null. */
function parseConnectedOn(s) {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})$/.exec(s ?? "");
  if (!m || !(m[2].toLowerCase() in MONTHS)) return null;
  const d = new Date(Date.UTC(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1])));
  return isNaN(d) ? null : d.toISOString();
}

/** Locate the LinkedIn header row (preamble rows precede it). -1 = not LinkedIn. */
export function linkedInHeaderRow(rows) {
  const limit = Math.min(rows.length, 10); // the preamble is a few lines at most
  for (let i = 0; i < limit; i++) {
    const h = rows[i].map(norm);
    if (h.includes("firstname") && h.includes("connectedon")) return i;
  }
  return -1;
}

/** Parsed CSV rows -> fein documents. Pure; unit-tested offline. */
export function docsFromLinkedIn(rows, headerRow) {
  const header = rows[headerRow].map(norm);
  const col = (name) => header.indexOf(name);
  const c = {
    first: col("firstname"),
    last: col("lastname"),
    url: col("url"),
    email: col("emailaddress"),
    company: col("company"),
    position: col("position"),
    connected: col("connectedon"),
  };
  const cell = (row, i) => (i >= 0 ? row[i]?.trim() || null : null);

  const docs = [];
  rows.slice(headerRow + 1).forEach((row, i) => {
    const name = [cell(row, c.first), cell(row, c.last)].filter(Boolean).join(" ") || null;
    const email = cell(row, c.email);
    if (!name && !email) return;
    const company = cell(row, c.company);
    const position = cell(row, c.position);
    // "12 Mar 2021" — a plain date, so parse it as UTC explicitly (new Date()
    // would shift it by the server's timezone). A failed parse degrades to
    // null rather than dropping the connection.
    const occurred = parseConnectedOn(cell(row, c.connected));

    docs.push({
      source: "linkedin",
      kind: "connection",
      external_id: cell(row, c.url) ?? email ?? `linkedin-row-${i + 1}`,
      title: `LinkedIn connection: ${name ?? email}${position ? ` (${position}${company ? `, ${company}` : ""})` : ""}`,
      occurred_at: occurred,
      people: [{ name, email, org: company, role: "mentioned" }],
      orgs: company ? [company] : [],
    });
  });
  return docs;
}
