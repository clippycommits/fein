import { readFileSync } from "node:fs";

/**
 * Gmail/Takeout mbox adapter — zero OAuth. Parses message headers only
 * (From/To/Cc/Subject/Date/Message-ID); bodies are never read or stored.
 */

// A real mbox postmark: "From <addr> <asctime>" — classic asctime, spool, and
// Gmail Takeout forms. Body lines starting "From " (unescaped in mboxcl and
// hand-rolled exports) don't match and must not fabricate phantom messages.
const POSTMARK = /^From \S+ +(?:\w{3} )?\w{3} [ \d]\d [\d:]{5,8}(?: [+-]\d{4})? \d{4}/;

export function loadMbox(path) {
  const raw = readFileSync(path, "utf8");
  const chunks = raw.split(/\r?\n(?=From )/).filter((c) => POSTMARK.test(c));
  const docs = [];
  for (const chunk of chunks) {
    const headerBlock = chunk.split(/\r?\n\r?\n/)[0];
    const headers = parseHeaders(headerBlock);
    const people = [
      ...parseAddressList(headers.from).map((p) => ({ ...p, role: "from" })),
      ...parseAddressList(headers.to).map((p) => ({ ...p, role: "to" })),
      ...parseAddressList(headers.cc).map((p) => ({ ...p, role: "cc" })),
    ];
    if (!people.length) continue;
    docs.push({
      source: "mbox",
      kind: "email",
      external_id: headers["message-id"]?.replace(/[<>]/g, "") ?? null,
      title: decodeRfc2047(headers.subject ?? "(no subject)"),
      occurred_at: parseDate(headers.date),
      people,
    });
  }
  return docs;
}

function parseHeaders(block) {
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  return headers;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d) ? null : d.toISOString();
}

/** "\"Chen, Maya\" <maya@x.com>, tom@y.com" -> [{name, email}, ...] */
export function parseAddressList(value) {
  if (!value) return [];
  const tokens = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inQuotes && ch === "\\" && i + 1 < value.length) {
      cur += ch + value[i + 1]; // RFC 5322 quoted-pair: consume both chars
      i++;
      continue;
    }
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === "," && !inQuotes) {
      tokens.push(cur);
      cur = "";
    } else cur += ch;
  }
  tokens.push(cur);

  const people = [];
  for (const token of tokens) {
    const t = token.trim();
    if (!t) continue;
    const angle = t.match(/<([^>]+)>/);
    if (angle) {
      let raw = t.slice(0, angle.index).trim();
      if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
        raw = raw.slice(1, -1).replace(/\\(.)/g, "$1"); // unquote + unescape quoted-pairs
      }
      const name = decodeRfc2047(raw.trim());
      people.push({ name: name || null, email: angle[1].trim() });
    } else if (t.includes("@")) {
      // Bare addr-spec, possibly with RFC 5322 comment or group syntax:
      // "maya@x.com (Maya Chen)" / "Investors: maya@x.com" / "tom@y.com;"
      const comment = t.match(/\(([^)]*)\)/);
      const addr = t
        .replace(/\([^)]*\)/g, "")
        .replace(/^[^:]+:\s*/, "")
        .replace(/\s*;$/, "")
        .trim()
        .replace(/^"|"$/g, "");
      if (/^\S+@\S+$/.test(addr)) {
        const name = comment ? decodeRfc2047(comment[1].trim()) : "";
        people.push({ name: name || null, email: addr });
      }
    }
  }
  return people;
}

/** Minimal RFC 2047 encoded-word decoding: =?utf-8?Q?...?= and ?B?. */
export function decodeRfc2047(value) {
  if (!value || !value.includes("=?")) return value;
  // RFC 2047 §6.2: whitespace between two adjacent encoded words is deleted.
  value = value.replace(
    /(=\?[^?]+\?[QqBb]\?[^?]*\?=)\s+(?==\?[^?]+\?[QqBb]\?[^?]*\?=)/g,
    "$1"
  );
  return value.replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      const buf = enc.toLowerCase() === "b"
        ? Buffer.from(text, "base64")
        : Buffer.from(
            text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
              String.fromCharCode(parseInt(h, 16))
            ),
            "latin1"
          );
      return buf.toString(/utf-?8/i.test(charset) ? "utf8" : "latin1");
    } catch {
      return text;
    }
  }).replace(/\s+/g, " ").trim();
}
