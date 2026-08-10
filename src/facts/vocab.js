/**
 * The closed predicate vocabulary.
 *
 * Contradiction only works if two facts about the same subject can be
 * recognised as competing. An open predicate space cannot do that —
 * "raising_round" and "is_raising" would never collide, and the graph would
 * accumulate parallel truths instead of retiring stale ones. So the predicate
 * is an enum at the extraction schema level (structured outputs enforce it at
 * the API, the same way deals.status is enforced) and its behaviour on
 * contradiction is declared here rather than inferred.
 *
 * Cardinality is the whole contract:
 *   one     — at most one live fact per subject. A new one closes the old.
 *   many    — several can be true at once; only a same-object restatement or
 *             an explicit displacement closes one (a person has one employer,
 *             but a company has many investors).
 *   append  — never contradicted. History, not state.
 */
export const PREDICATES = {
  raising:         { cardinality: "one",    label: "Raising",           subject: "org" },
  valuation:       { cardinality: "one",    label: "Valuation",         subject: "org" },
  arr:             { cardinality: "one",    label: "ARR",               subject: "org" },
  stage:           { cardinality: "one",    label: "Stage",             subject: "org" },
  headcount:       { cardinality: "one",    label: "Headcount",         subject: "org" },
  location:        { cardinality: "one",    label: "Location",          subject: "org" },
  design_partners: { cardinality: "one",    label: "Design partners",   subject: "org" },
  // Object-valued. A person displaces their own prior employer; a company does
  // not displace its other investors.
  employs:         { cardinality: "many",   label: "Employs",           subject: "org", displacesBy: "object" },
  investor:        { cardinality: "many",   label: "Investor",          subject: "org" },
  // Append-only, and load-bearing. "You passed in January 2025" must never be
  // retired by a later investment: both are true, at different times, and the
  // January reasoning surviving is the entire product promise.
  decision:        { cardinality: "append", label: "Decision",          subject: "org" },
};

export const PREDICATE_NAMES = Object.keys(PREDICATES);

export function cardinalityOf(predicate) {
  return PREDICATES[predicate]?.cardinality ?? null;
}

export function isPredicate(predicate) {
  return Object.hasOwn(PREDICATES, predicate);
}

/**
 * Comparable form of a fact's value. Restatement detection runs on this, so it
 * has to collapse the ways the same number is written across sources — "$2.4M
 * ARR", "2.4m", "$2,400,000" — without collapsing genuinely different values.
 * Anything non-numeric falls back to case/punctuation-folded text.
 */
export function normValue(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const money = raw
    .replace(/[,\s]/g, "")
    .match(/^[$£€]?(\d+(?:\.\d+)?)\s*([kmb])?$/i);
  if (money) {
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[(money[2] ?? "").toLowerCase()] ?? 1;
    const n = Number(money[1]) * mult;
    if (Number.isFinite(n)) return `n:${n}`;
  }

  // A bare integer inside prose ("six design partners live" → 6) is the same
  // value as "6"; spelled-out small numbers are common in investor updates.
  const words = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
                  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const w = raw.toLowerCase().match(/^([a-z]+)\b/);
  if (w && Object.hasOwn(words, w[1]) && /^[a-z]+$/.test(raw.toLowerCase().replace(/[^a-z]/g, "")))
    return `n:${words[w[1]]}`;

  return raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
