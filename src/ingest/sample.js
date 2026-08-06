import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsonl } from "./local.js";
import { ingestDocs } from "./index.js";
import { resolveMentions } from "../resolve/pipeline.js";
import { rebuildEdges } from "../graph/edges.js";
import { listMembers, addMember } from "../members.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The bundled demo world, loaded in one shot: the shared fixtures, the team
 * running this instance (Tom + Seb Larkin), and Seb's private correspondence
 * with Priya Nair — so every part of the demo, including privacy layers,
 * exists right after "Load sample dataset".
 *
 * sample.mbox / sample.ics / contacts.csv are deliberately NOT loaded here:
 * they are the live-ingest demo files you drag in afterwards.
 *
 * Idempotent: documents upsert by external id, members are found by email
 * before being created — loading twice changes nothing.
 */
export async function loadSampleDataset(db) {
  const fixtureDir = join(ROOT, "sample/fixtures");
  let fixtures = [];
  try {
    fixtures = readdirSync(fixtureDir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => loadJsonl(join(fixtureDir, f)));
  } catch {} // fixtures are optional
  const shared = [...loadJsonl(join(ROOT, "sample/seed.jsonl")), ...fixtures];
  const ingested = await ingestDocs(db, shared);

  const tom = await ensureMember(db, { name: "Tom Merrill", email: "tom@ridgeline.vc" });
  const seb = await ensureMember(db, { name: "Seb Larkin", email: "seb@ridgeline.vc" });
  const priv = await ingestDocs(db, loadJsonl(join(ROOT, "sample/private-seb.jsonl")), { owner: seb.id });
  ingested.docCount += priv.docCount;
  ingested.mentionCount += priv.mentionCount;

  const resolved = await resolveMentions(db);
  const edges = await rebuildEdges(db);
  return { ingested, resolved, edges, members: [tom, seb] };
}

async function ensureMember(db, { name, email }) {
  const existing = (await listMembers(db)).find(
    (m) => m.email?.toLowerCase() === email.toLowerCase()
  );
  return existing ?? addMember(db, { name, email });
}
