const HONORIFICS = new Set(["mr", "mrs", "ms", "dr", "prof", "sir"]);
const ORG_SUFFIXES = /\b(ltd|llc|llp|inc|plc|gmbh|sarl|limited|capital|partners|ventures|vc|fund|management)\b\.?/g;

export function normEmail(email) {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  if (!e.includes("@")) return null;
  const [local, domain] = e.split("@");
  // Strip plus-addressing; keep dots (dot-insensitivity is a Gmail-ism, not universal).
  return `${local.split("+")[0]}@${domain}`;
}

export function normPersonName(name) {
  if (!name) return null;
  const tokens = name
    .toLowerCase()
    .replace(/["'’]/g, "")
    .replace(/[^a-z\s.-]/g, " ")
    .split(/[\s.]+/)
    .filter(Boolean)
    .filter((t) => !HONORIFICS.has(t));
  return tokens.length ? tokens.join(" ") : null;
}

export function normOrgName(name) {
  if (!name) return null;
  const n = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(ORG_SUFFIXES, "").replace(/\s+/g, " ").trim();
  return n || null;
}

/** Blocking key: cheap partition so we never compare all pairs. */
export function blockKeys({ normName, normEmail: email, kind }) {
  const keys = [];
  if (email) {
    keys.push(`e:${email}`);
    keys.push(`d:${email.split("@")[1]}`);
  }
  if (normName) {
    const toks = normName.split(" ");
    const last = toks[toks.length - 1];
    keys.push(`n:${kind}:${toks[0][0]}${last}`); // first initial + last token
    if (toks.length === 1) keys.push(`n:${kind}:${toks[0]}`);
    // Reversed form so "Whitfield, Dana" blocks with "Dana Whitfield".
    if (toks.length > 1) keys.push(`n:${kind}:${last[0]}${toks[0]}`);
  }
  return keys;
}

/** Jaro-Winkler similarity, 0..1. */
export function jaroWinkler(s1, s2) {
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  const window = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const m1 = new Array(s1.length).fill(false);
  const m2 = new Array(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(s2.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (!m2[j] && s1[i] === s2[j]) {
        m1[i] = m2[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  t /= 2;
  const jaro = (matches / s1.length + matches / s2.length + (matches - t) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length) && s1[i] === s2[i]; i++) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Name similarity tolerant of "tom merrill" vs "t merrill" vs "merrill, tom". */
export function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = a.split(" "), tb = b.split(" ");
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  // Best alignment of each shorter-name token against longer-name tokens.
  let total = 0;
  for (const tok of shorter) {
    let best = 0;
    for (const cand of longer) {
      let s = jaroWinkler(tok, cand);
      if (tok.length === 1 && cand[0] === tok) s = Math.max(s, 0.85); // initial match
      best = Math.max(best, s);
    }
    total += best;
  }
  return total / shorter.length;
}
