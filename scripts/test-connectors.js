/**
 * Offline tests for the LinkedIn Connections.csv adapter and the Affinity
 * mapping layer — fixtures in, documents out, no network.
 */
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCsv } from "../src/ingest/csv.js";
import { docsFromAffinity } from "../src/ingest/affinity.js";

let failures = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? "ok " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

const dir = mkdtempSync(join(tmpdir(), "fein-connector-test-"));

console.log("LinkedIn Connections.csv:");
{
  // Real export shape: "Notes:" preamble, then the header.
  const fixture = [
    "Notes:",
    '"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed it."',
    "",
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
    'Priya,Nair,https://www.linkedin.com/in/priya-nair,priya@meridianwealth.example,Meridian Wealth,Partner,12 Mar 2021',
    'Tom,Merrill,https://www.linkedin.com/in/tommerrill,,Ridgeline Capital,GP,03 Jan 2024',
    ',,,,,,',
  ].join("\n");
  const path = join(dir, "Connections.csv");
  writeFileSync(path, fixture);
  const docs = loadCsv(path);

  ok(docs.length === 2, `parses 2 connections, skips blank row (got ${docs.length})`);
  const priya = docs[0];
  ok(priya.source === "linkedin" && priya.kind === "connection", "source/kind are linkedin/connection");
  ok(priya.external_id === "https://www.linkedin.com/in/priya-nair", "profile URL is the stable external id");
  ok(priya.occurred_at?.startsWith("2021-03-12"), `Connected On becomes occurred_at (got ${priya.occurred_at})`);
  ok(priya.people[0].name === "Priya Nair" && priya.people[0].email === "priya@meridianwealth.example",
    "name + email mapped");
  ok(priya.people[0].org === "Meridian Wealth" && priya.orgs[0] === "Meridian Wealth", "company becomes the org hint");
  ok(priya.title.includes("Partner"), "position lands in the title");
  const tom = docs[1];
  ok(tom.people[0].email === null, "missing email is null, not empty string");
  ok(tom.occurred_at?.startsWith("2024-01-03"), "second date parses");
}

console.log("Generic CSV still routes generically:");
{
  const path = join(dir, "contacts.csv");
  writeFileSync(path, "Name,Email,Company\nMaya Chen,maya@nightjar.example,Nightjar\n");
  const docs = loadCsv(path);
  ok(docs.length === 1 && docs[0].source === "crm", "a plain contacts CSV is untouched by the sniffer");
}

console.log("Affinity mapping:");
{
  const docs = docsFromAffinity({
    organizations: [
      { id: 1, name: "Nightjar", domain: "nightjar.example" },
      { id: 2, name: null },
    ],
    persons: [
      { id: 10, first_name: "Maya", last_name: "Chen", primary_email: "maya@nightjar.example",
        emails: ["maya@nightjar.example", "maya@gmail.example"], organization_ids: [1] },
      { id: 11, first_name: null, last_name: null, primary_email: null, emails: [] }, // unmappable
    ],
    notes: [
      { id: 100, person_ids: [10], created_at: "2026-05-01T10:00:00Z", content: "NEVER-READ" },
      { id: 101, person_ids: [11, 999], created_at: "2026-05-02T10:00:00Z" }, // no known participants
    ],
  });

  const org = docs.find((d) => d.external_id === "affinity-org-1");
  ok(org && org.orgs[0] === "Nightjar", "org record mapped");
  ok(!docs.some((d) => d.external_id === "affinity-org-2"), "nameless org skipped");

  const person = docs.find((d) => d.external_id === "affinity-person-10");
  ok(person?.people.length === 2, "each email address becomes a mention of the same person");
  ok(person?.people.every((p) => p.name === "Maya Chen" && p.org === "Nightjar"),
    "org link resolved through the id map");
  ok(!docs.some((d) => d.external_id === "affinity-person-11"), "person with no name and no email skipped");

  const note = docs.find((d) => d.external_id === "affinity-note-100");
  ok(note?.kind === "note" && note.people[0].email === "maya@nightjar.example", "note participants mapped");
  ok(note?.occurred_at === "2026-05-01T10:00:00.000Z", "note timestamp preserved");
  ok(!JSON.stringify(docs).includes("NEVER-READ"), "note content is never read into a document");
  ok(!docs.some((d) => d.external_id === "affinity-note-101"), "note with no known participants skipped");
}

rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} CONNECTOR TEST(S) FAILED`);
  process.exit(1);
}
console.log("\nCONNECTOR TESTS PASSED");
