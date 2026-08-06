/**
 * Single source of truth for the product name. The engine was born
 * "fundgraph"; the product ships as Fein. Environment variables and
 * on-disk locations accept both spellings — FEIN_* wins, FUNDGRAPH_*
 * keeps working so existing installs and shells don't break.
 */
export const BRAND = "Fein";
export const SLUG = "fein";
export const LEGACY_SLUG = "fundgraph";

/** Read FEIN_<name>, falling back to FUNDGRAPH_<name>. */
export function env(name) {
  return process.env[`FEIN_${name}`] ?? process.env[`FUNDGRAPH_${name}`];
}
