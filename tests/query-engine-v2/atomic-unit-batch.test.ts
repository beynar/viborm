import type { BatchQuery } from "@drivers";
import { describe, expect, test } from "vitest";
import { batchIsAtomicUnit } from "../fixtures/atomic-unit-batch";

// ---------------------------------------------------------------------------
// The staleness-injection window, pinned directly. Ten test files drive a
// one-shot concurrent-writer hook through `batchIsAtomicUnit`; this file is the
// only place its three edges are stated, so a future edit that widens or
// narrows the window fails HERE rather than silently relocating a dozen race
// premises somewhere they no longer bite.
// ---------------------------------------------------------------------------

const q = (sql: string): BatchQuery => ({ sql, params: [] });

describe("the staleness-injection window", () => {
  test("a planning level is not the unit — even when its probe says FOR UPDATE", () => {
    // Transaction mode's locked probe carries the word UPDATE inside a SELECT.
    // A substring test would call this the write batch and inject one batch too
    // early, which is exactly the bug the anchored pattern exists to prevent.
    expect(
      batchIsAtomicUnit([
        q(
          'SELECT "t0"."id" FROM "users" AS "t0" WHERE "t0"."email" = $1 LIMIT 1'
        ),
        q(
          'SELECT "t0"."id" FROM "posts" AS "t0" WHERE "t0"."id" = $1 FOR UPDATE'
        ),
      ])
    ).toBe(false);
  });

  test("a batch carrying a write is the unit", () => {
    expect(
      batchIsAtomicUnit([
        q(
          'UPDATE "users" SET "count" = $1 WHERE "users"."id" = $2 RETURNING "id"'
        ),
      ])
    ).toBe(true);
    expect(batchIsAtomicUnit([q('DELETE FROM "users" WHERE "id" = $1')])).toBe(
      true
    );
    expect(
      batchIsAtomicUnit([q('INSERT INTO "users" ("email") VALUES ($1)')])
    ).toBe(true);
  });

  test("a WRITE-FREE unit is still the unit: the deliberate no-op arm", () => {
    // An upsert whose targetWhere/setWhere conditional does not match compiles
    // to `[notExists guard, terminal read]` and writes nothing — and the
    // skip-premise pin the upsert-family staleness tests attack lives in that
    // batch. Recognising the unit by its guard assertion, not only by a write,
    // is what keeps those three tests injecting into the window they name.
    expect(
      batchIsAtomicUnit([
        q(
          'SELECT 1 / CASE WHEN NOT EXISTS (SELECT "t0"."id" FROM "users" AS "t0" WHERE "t0"."score" = $1) THEN 1 ELSE 0 END AS "__viborm_assert__"'
        ),
        q('SELECT "t0"."email" FROM "users" AS "t0" WHERE "t0"."id" = $1'),
      ])
    ).toBe(true);
  });
});
