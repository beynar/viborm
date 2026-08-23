/**
 * A to-one slot's emptiness, as the reader receives it (plan §8.1, §8.4, §9.4;
 * ruling D17).
 *
 * BOTH PINS IN THIS FILE FLIPPED, deliberately, and they are the two §9.4 books
 * as changing. HEAD read `state.optional !== true` off the declaration and
 * called a null relation value malformed on that alone; the flag is gone for a
 * model target, and emptiness now follows the STORED TUPLE — `slotMayBeEmpty`
 * over the resolved edge. So a nullable foreign key accepts the null it can
 * really produce, and an all-required one rejects the null it cannot.
 *
 * The two shapes below are exactly the ones where HEAD's flag and the tuple
 * DISAGREED, which is why they are the only two whose runtime answer moves.
 *
 * `result-parser-contracts.core.test.ts` owns the AGREEING case — a required
 * tuple rejects null — so that shape is not repeated here.
 */

import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { parseResult } from "@query-engine/result/ResultParser";
import { s } from "@schema";
import { parserFor, prepareSchema } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const MALFORMED_RESULT_PATTERN = /result|payload|rows/i;

/** A nullable foreign key whose slot never called `.optional()`. */
const nullableTupleWithoutFlag = (() => {
  const user = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    authorId: s.string().nullable(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  });
  const schema = { user, post };
  prepareSchema(schema);
  return schema;
})();

/** An all-required foreign key: no member of the tuple accepts NULL. */
const requiredTupleWithFlag = (() => {
  const user = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  });
  const schema = { user, post };
  prepareSchema(schema);
  return schema;
})();

const INCLUDE_AUTHOR = { include: { author: true } };

describe("to-one emptiness when the flag and the tuple disagree", () => {
  // RE-PINNED (§9.4). HEAD called this malformed because the declaration
  // carried no `.optional()`; `authorId` accepts null, so the row is one the
  // database can really return and the reader now receives it.
  test("a nullable foreign key accepts the null it can produce", () => {
    expect(
      parseResult(
        parserFor(new PostgresAdapter(), nullableTupleWithoutFlag.post),
        "findMany",
        [{ id: "post-1", authorId: null, author: null }],
        INCLUDE_AUTHOR
      )
    ).toEqual([{ id: "post-1", authorId: null, author: null }]);
  });

  // RE-PINNED (§9.4), the mirror: `authorId` is NOT NULL, so a null membership
  // is unreachable. HEAD handed the caller `null` anyway because the declaration
  // spelled `.optional()` beside a non-nullable column — two facts that could
  // disagree. There is only one fact now, and it refuses.
  test("an all-required foreign key rejects the null it cannot produce", () => {
    expect(() =>
      parseResult(
        parserFor(new PostgresAdapter(), requiredTupleWithFlag.post),
        "findMany",
        [{ id: "post-1", authorId: "user-1", author: null }],
        INCLUDE_AUTHOR
      )
    ).toThrow(MALFORMED_RESULT_PATTERN);
  });
});
