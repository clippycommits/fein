import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Gmail/Takeout mbox adapter — zero OAuth. Parses headers
 * (From/To/Cc/Subject/Date/Message-ID) and captures a size-capped plain-text
 * body per message so the extraction pipeline can mine it for mentions.
 * Set FUNDGRAPH_NO_BODIES=1 (or pass {bodies: false}) for the old
 * headers-only behavior.
 *
 * Streamed line by line: a Takeout export of a long-lived account is commonly
 * many gigabytes, far past Node's ~512MB max string length, so the file is
 * never held in memory whole. Bodies are capped at BODY_CAP chars per message
 * — enough for extraction, bounded for memory.
 */

// A real mbox postmark: "From <addr> <asctime>" — classic asctime, spool, and
// Gmail Takeout forms. Body lines starting "From " (unescaped in mboxcl and
// hand-rolled exports) don't match and must not fabricate phantom messages.
const POSTMARK = /^From \S+ +(?:\w{3} )?\w{3} [ \d]\d [\d:]{5,8}(?: [+-]\d{4})? \d{4}/;

const BODY_CAP = 131_072; // raw chars gathered per message before decoding

/** Yields parsed messages one at a time; nothing accumulates past one message. */
export async function* streamMbox(path, { bodies = process.env.FUNDGRAPH_NO_BODIES !== "1" } = {}) {
  let headerLines = null; // non-null from a postmark until the message is emitted
  let inHeaders = false;
  let bodyLines = null;   // collected between the header block and the next postmark
  let bodyChars = 0;
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  const emit = (headers, body) =>
    messageFromHeaders(headers, bodies && body ? body.join("\n") : null);

  for await (const line of rl) {
    if (POSTMARK.test(line)) {
      if (headerLines) {
        const doc = emit(headerLines, bodyLines);
        if (doc) yield doc;
      }
      headerLines = [];
      bodyLines = null;
      bodyChars = 0;
      inHeaders = true;
      continue;
    }
    if (inHeaders && line === "") { // blank line ends the header block, body follows
      inHeaders = false;
      bodyLines = [];
      continue;
    }
    if (inHeaders) {
      headerLines?.push(line);
    } else if (bodies && bodyLines && bodyChars < BODY_CAP) {
      bodyLines.push(line);
      bodyChars += line.length + 1;
    }
  }
  if (headerLines) {
    const doc = emit(headerLines, bodyLines);
    if (doc) yield doc;
  }
}

/**
 * Whole-file parse. Fine for exports up to a few hundred thousand messages;
 * for a multi-gigabyte archive prefer `streamMbox` (the CLI uses it via
 * `ingestStream`) so documents never accumulate in memory.
 */
export async function loadMbox(path, opts) {
  const docs = [];
  for await (const doc of streamMbox(path, opts)) docs.push(doc);
  return docs;
}

const FINAL_BODY_CAP = 65_536;

function messageFromHeaders(lines, bodyRaw) {
  const headers = parseHeaders(lines);
  const people = [
    ...parseAddressList(headers.from).map((p) => ({ ...p, role: "from" })),
    ...parseAddressList(headers.to).map((p) => ({ ...p, role: "to" })),
    ...parseAddressList(headers.cc).map((p) => ({ ...p, role: "cc" })),
  ];
  if (!people.length) return null;
  const body = bodyRaw
    ? extractTextBody(headers["content-type"], headers["content-transfer-encoding"], bodyRaw)
    : null;
  return {
    source: "mbox",
    kind: "email",
    external_id: headers["message-id"]?.replace(/[<>]/g, "") ?? null,
    title: decodeRfc2047(headers.subject ?? "(no subject)"),
    occurred_at: parseDate(headers.date),
    people,
    ...(body ? { body: body.slice(0, FINAL_BODY_CAP) } : {}),
  };
}

/**
 * Minimal MIME: enough to surface the text/plain content of real-world mail.
 * multipart/* → recurse into the first text/plain (or nested multipart) part;
 * quoted-printable and base64 transfer encodings are decoded; HTML-only mail
 * falls back to tag-stripped text/html rather than dropping the message.
 */
function extractTextBody(contentType, transferEncoding, raw, depth = 0) {
  const ct = (contentType ?? "").toLowerCase();
  const boundary = contentType?.match(/boundary\s*=\s*(?:"([^"]+)"|([^\s;]+))/i);
  if (ct.startsWith("multipart/") && boundary && depth < 3) {
    const parts = splitMimeParts(raw, boundary[1] ?? boundary[2]);
    let htmlFallback = null;
    for (const part of parts) {
      const pct = (part.headers["content-type"] ?? "text/plain").toLowerCase();
      if (pct.startsWith("multipart/")) {
        const nested = extractTextBody(part.headers["content-type"], part.headers["content-transfer-encoding"], part.content, depth + 1);
        if (nested) return nested;
      } else if (pct.startsWith("text/plain")) {
        return decodeTransfer(part.content, part.headers["content-transfer-encoding"], pct);
      } else if (pct.startsWith("text/html") && !htmlFallback) {
        htmlFallback = stripHtml(decodeTransfer(part.content, part.headers["content-transfer-encoding"], pct));
      }
    }
    return htmlFallback;
  }
  if (ct.startsWith("text/html")) return stripHtml(decodeTransfer(raw, transferEncoding, ct));
  if (!ct || ct.startsWith("text/")) {
    const text = decodeTransfer(raw, transferEncoding, ct);
    return text?.trim() ? text : null;
  }
  return null; // binary or unknown single-part: nothing extractable
}

function splitMimeParts(raw, boundary) {
  const marker = "--" + boundary;
  const parts = [];
  for (const segment of raw.split(marker).slice(1)) {
    if (segment.startsWith("--")) break; // closing delimiter
    const text = segment.replace(/^\r?\n/, "");
    const sep = text.search(/\r?\n\r?\n/);
    const headerBlock = sep === -1 ? text : text.slice(0, sep);
    const content = sep === -1 ? "" : text.slice(sep).replace(/^\r?\n\r?\n/, "");
    parts.push({ headers: parseHeaders(headerBlock.split(/\r?\n/)), content });
  }
  return parts;
}

function decodeTransfer(text, encoding, contentType) {
  const enc = (encoding ?? "").trim().toLowerCase();
  const isUtf8 = !contentType || /charset\s*=\s*"?utf-?8/i.test(contentType) || !/charset/i.test(contentType);
  try {
    if (enc === "base64") {
      return Buffer.from(text.replace(/\s+/g, ""), "base64").toString(isUtf8 ? "utf8" : "latin1");
    }
    if (enc === "quoted-printable") {
      const joined = text.replace(/=\r?\n/g, "");
      const bytes = [];
      for (let i = 0; i < joined.length; i++) {
        if (joined[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
          bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(joined.charCodeAt(i) & 0xff);
      }
      return Buffer.from(bytes).toString(isUtf8 ? "utf8" : "latin1");
    }
  } catch {
    return text;
  }
  return text;
}

function stripHtml(html) {
  if (!html) return null;
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

function parseHeaders(lines) {
  const headers = {};
  let current = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) {
      headers[current] += " " + line.trim(); // folded continuation
      continue;
    }
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) {
      current = m[1].toLowerCase();
      headers[current] = m[2];
    } else {
      current = null;
    }
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
