/**
 * Independent review probes (round 3) — the native fixture's AUTHORITY.
 *
 * `note.md` §14.1 and §15.5: the fixture owns its raw seed SQL, so it spells a
 * datetime the way the adapter does. `toMySqlDateTime` is private, so the
 * fixture DUPLICATES it and a fifth cell pins the copy against
 * `adapter.literals.dateTime` for four instants. These probes ask whether four
 * instants are enough to hold a copy to its original, and whether the fixture's
 * expectations can be reached from either engine.
 *
 * Each cell states the invariant and FAILS when it does not hold.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { describe, it } from "vitest";
import { G4_NATIVE_PROVIDER_COUNTS } from "../../../../../scripts/raptor3-manifest.mjs";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const NATIVE_SUITE = "tests/raptor3/g4/native/read-envelope-native.test.ts";
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

/** The rule the fixture copies, re-derived here from the adapter alone. */
const adapterDateTime = (adapter: MySQLAdapter | PostgresAdapter, iso: string) =>
  adapter.literals.dateTime(iso).values[0];

describe("review probe (round 3): the native fixture's authority", () => {
  it("holds the duplicated MySQL rule over far more than the four pinned instants", () => {
    // The in-suite pin uses four instants, all between 1970 and 2030 and all
    // on whole seconds or .123/.500. If the adapter's rule ever became
    // instant-dependent — a timezone, a precision cut, a pre-epoch branch —
    // four samples could agree while the fixture seeded a literal the product
    // never sends. This sweeps the shape the fixture's copy assumes.
    const mysql = new MySQLAdapter();
    const postgres = new PostgresAdapter();
    const naive = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
    const instants: string[] = [];
    for (let index = 0; index < 400; index++)
      instants.push(
        new Date(Date.UTC(1970, 0, 1) + index * 86_399_137 * 3).toISOString()
      );
    instants.push(
      "1970-01-01T00:00:00.000Z",
      "1969-12-31T23:59:59.999Z",
      "1900-06-15T12:00:00.001Z",
      "2024-06-30T22:00:00.500Z",
      "2038-01-19T03:14:08.000Z",
      "9999-12-31T23:59:59.999Z"
    );
    for (const iso of instants) {
      const spelled = adapterDateTime(mysql, iso);
      assert.equal(
        typeof spelled === "string" && naive.test(spelled),
        true,
        `the MySQL adapter no longer spells ${iso} as naive UTC wall clock`
      );
      assert.equal(
        spelled,
        new Date(iso).toISOString().slice(0, 23).replace("T", " "),
        `the fixture's copy of the MySQL rule diverges at ${iso}`
      );
      assert.equal(
        adapterDateTime(postgres, iso),
        iso,
        `the PostgreSQL arm is no longer identity at ${iso}`
      );
    }
  });

  it("keeps the native expectations out of reach of either engine", () => {
    // "Keep expectations independent of both engines" is the brief's words.
    // The mechanical half of that: the suite may build the CANDIDATE, and may
    // not import the shipped engine, a legacy client or a parity helper whose
    // answer would become the expectation.
    const source = read(NATIVE_SUITE);
    for (const forbidden of [
      "@query-engine/engine",
      "createLegacy",
      "legacy-world",
      "bothOutcomes",
      "shippedEngine",
      "shipped-parity",
    ])
      assert.equal(
        source.includes(forbidden),
        false,
        `${NATIVE_SUITE} reaches for ${forbidden}, so an expectation could come from an engine`
      );
  });

  it("registers exactly the cells the native file declares, for both providers", () => {
    const source = read(NATIVE_SUITE);
    const declared = source.match(/^\s*it\(/gm)?.length ?? 0;
    const registered = (
      Object.values(G4_NATIVE_PROVIDER_COUNTS) as number[]
    ).reduce((total, count) => total + count, 0);
    assert.equal(
      registered,
      declared,
      `the native mode pins ${registered} cells and the file declares ${declared}`
    );
  });

  it("does not let the provider decide which expectation is checked", () => {
    // Physical TYPES may branch on the provider — a shared fixture has no
    // other choice. An ASSERTION that branches on it would be two contracts
    // wearing one cell name, which is what the coverage claim rests on.
    const source = read(NATIVE_SUITE);
    const assertions = source
      .split("\n")
      .filter((line) => /assert\.[a-z]/i.test(line) && line.includes("liveProvider"));
    assert.deepEqual(
      assertions,
      [],
      "a native assertion branches on the provider"
    );
  });
});
