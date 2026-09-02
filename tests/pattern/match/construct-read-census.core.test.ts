/**
 * Census: read construction names no storage. The words below are the cell
 * map's vocabulary (cells.ts) and the old builders' — a construction that
 * reasons in them has re-derived a topology fact instead of reading a
 * reference. Whole-word, case-sensitive: reading a K2 member such as
 * `viaJunction` is consuming the cell map, not restating it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const STORAGE_WORDS = [
  "junction",
  "polymorphic",
  "parentHeld",
  "childHeld",
  "rowHeld",
  "foreignKey",
  "lateral",
  "subquery",
  "inverse",
  "manyToMany",
  "oneToMany",
  "manyToOne",
] as const;

describe("construct-read census", () => {
  test("names no storage word outside error messages", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../src/query-engine/pattern/construct-read.ts"),
      "utf8"
    );
    // Error text reproduces today's messages byte for byte; strip string
    // literals so a public message such as "Polymorphic collection filter"
    // does not count as engine vocabulary.
    const code = source
      .replace(/`(?:\\.|[^`\\])*`/g, "``")
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const hits = STORAGE_WORDS.filter((word) =>
      new RegExp(`\\b${word}\\b`).test(code)
    );
    expect(hits).toEqual([]);
  });
});
