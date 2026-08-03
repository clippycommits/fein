import { readFileSync } from "node:fs";

/**
 * Local JSONL adapter — the zero-OAuth path. One document per line:
 * {
 *   source: "granola" | "gmail" | "calendar" | "drive" | "crm" | "local",
 *   kind: "meeting" | "email" | "event" | "doc" | "record",
 *   external_id: "...", title: "...", occurred_at: "2026-07-01T10:00:00Z",
 *   people: [{ name, email, org, role }],
 *   orgs: ["Nordwind Ventures"]
 * }
 * Real source adapters (gmail, calendar, drive, granola) emit this same shape.
 */
export function loadJsonl(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`${path}:${i + 1}: invalid JSON (${err.message})`);
      }
    });
}
