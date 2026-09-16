/**
 * Review probe (independent reviewer, follow-up round).
 *
 * Claim under attack, after the repair of must-fix 4: the native read-envelope
 * suite "could not have passed before" and now can — it seeds every NOT NULL
 * column with a real value, projects the codecs its header claims, and its
 * fourth cell is the real `Queries.recursive` fit.
 *
 * The file still cannot be imported (`tests/raptor3/transitions/live-world.ts`
 * asserts a live provider and port at module load) and no provider answers, so
 * this probe checks the part that is decidable offline: it derives the NOT NULL
 * column set from the fixture's OWN DDL builders and requires that no seeded row
 * supplies a NULL for one of them, and it pins the projected field set and the
 * private-fit entry point against the file's own text. It asserts nothing about
 * provider behaviour, which stays unverified.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

const SOURCE = "tests/raptor3/g4/native/read-envelope-native.test.ts";
const source = readFileSync(SOURCE, "utf8");

/** Column names the fixture's own DDL declares NOT NULL (primary keys aside). */
function notNullColumns(): string[] {
  const columns: string[] = [];
  const pattern = /names\.quote\("([a-z_]+)"\)\}[^`\n]*NOT NULL/g;
  for (const match of source.matchAll(pattern))
    if (match[1]) columns.push(match[1]);
  return columns;
}

describe("review probe: the repaired native fixture is satisfiable offline", () => {
  it("derives a non-trivial NOT NULL column set from the fixture's own DDL", () => {
    const columns = notNullColumns();
    for (const required of [
      "label_value",
      "big_value",
      "amount_value",
      "moment_value",
      "day_value",
      "clock_value",
      "status_value",
      "payload_value",
      "display_label",
      "node_amount",
      "node_moment",
    ])
      assert.ok(
        columns.includes(required),
        `${required} is no longer declared NOT NULL — the probe's premise moved`
      );
  });

  it("seeds no NULL into a NOT NULL column", () => {
    for (const column of notNullColumns())
      assert.equal(
        new RegExp(`(?<![a-z_])${column}:\\s*null`).test(source),
        false,
        `${column} is declared NOT NULL and seeded NULL: the suite would be rejected at seeding by PostgreSQL and by MySQL in strict mode`
      );
  });

  it("seeds real bytes and a real JSON document", () => {
    assert.match(source, /payload_value:\s*Buffer\.from\(/);
    assert.equal(
      (source.match(/payload_value:\s*Buffer\.from\(/g) ?? []).length,
      3,
      "not every seeded row carries real bytes"
    );
    assert.match(source, /document_value:\s*JSON\.stringify\(/);
  });

  it("projects every codec the header claims", () => {
    for (const projected of [
      "id: true",
      "big: true",
      "amount: true",
      "moment: true",
      "day: true",
      "clock: true",
      "status: true",
      "document: true",
      "payload: true",
    ])
      assert.ok(source.includes(projected), `${projected} is not projected`);
    // ...and the header no longer claims the spatial tiers, which need PostGIS
    // and pgvector and are absent from the file.
    assert.equal(
      source.includes("plus the spatial tiers (SC-13, SC-14, Q-O02)"),
      false,
      "the withdrawn spatial claim came back"
    );
    assert.equal(/s\.point\(\)|s\.vector\(\)/.test(source), false);
  });

  it("enters the recursive cell through the private fit and pins one statement", () => {
    assert.match(source, /context\.queries\.recursive\(nativeNode,/);
    assert.match(source, /new OperationContext\(/);
    assert.match(
      source,
      /world\.statements\.length,\s*\n?\s*1,/,
      "the one-statement claim of the native fit is gone"
    );
  });
});
