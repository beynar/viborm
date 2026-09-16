/**
 * One authority for what the G4 qualification keeps of each campaign family.
 *
 * Carried forward from the G3 sealed package and extended to the families G3
 * did not run (`g1-*`) and the four new G4 campaigns:
 *
 * - `all`     — every child receipt with its compressed corpus (G1/G2/G3/G4
 *               seeded campaigns). The parent receipt names the children.
 * - `compact` — one child's `verified.json`, `vitest.json` and
 *               `generated-campaign.json`, no corpus (G3P06: the parent
 *               manifest already binds first seed, seed count, profiles and
 *               replays for the whole run).
 * - `parent`  — no children at all; the parent receipt itself carries the
 *               extension campaign and its corpus (CS-03).
 *
 * The data module is imported, never executed, so a consumer can read the
 * table without running the packaging pass.
 */
export const CAMPAIGN_RETENTION = Object.freeze({
  "g4-seeds": "all",
  "g4-transport-seeds": "all",
  "g4-write-seeds": "all",
  "g4-write-transport-seeds": "all",
  "g3-seeds": "all",
  "g3-transport-seeds": "all",
  "g2-seeds": "all",
  "g2-transport-seeds": "all",
  "g1-seeds": "all",
  "g1-transport-seeds": "all",
  "g3p06-seeds": "compact",
  "g3p06-transport-seeds": "compact",
  "cs03-extension-a-seeds": "parent",
  "cs03-extension-b-seeds": "parent",
  "cs03-extension-composition-seeds": "parent",
});

/** The human sentence each family's `retentionBoundary` reports in the index. */
export const RETENTION_BOUNDARY = Object.freeze({
  all: "parent receipt plus durably retained compressed child receipts",
  compact:
    "parent attempt/verified receipt and log plus the required compact child verified/Vitest/generated-campaign receipt",
  parent: "single parent receipt retains the full extension campaign and corpus",
});

/** The two corpus spellings: the runner archives the first family, not the second. */
export const CORPUS_NAMES = Object.freeze([
  Object.freeze({ source: "generated-corpus.json", descriptor: "generated-corpus.archive.json" }),
  Object.freeze({ source: "corpus.json", descriptor: "corpus.archive.json" }),
]);

/** G3P06 keeps exactly these three files of its one child. */
export const COMPACT_FILES = Object.freeze([
  "verified.json",
  "vitest.json",
  "generated-campaign.json",
]);
