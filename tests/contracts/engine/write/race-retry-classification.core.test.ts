import {
  QueryEngineError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  VibORMErrorCode,
} from "@errors";
import type { TargetConstraintPin } from "@src/query-engine/write-engine/OperationFragment";
import {
  isRetryableRace,
  markRaceable,
  markRaceIfPinned,
  racePinMatches,
} from "@src/query-engine/write-engine/race-retry";
import { describe, expect, test } from "vitest";

const pin: TargetConstraintPin = {
  fields: ["tenantId", "slug"],
  table: "posts",
  columns: ["tenant_id", "slug"],
  constraints: ["posts_tenant_slug_key", "PRIMARY"],
};

describe("write-race attribution", () => {
  test("normalized table and unordered column attribution identifies the exact pin", () => {
    const error = new UniqueConstraintError("duplicate", {
      meta: {
        table: '"public"."POSTS"',
        columns: ["`slug`", "[TENANT_ID]"],
      },
    });
    expect(racePinMatches(error, pin)).toBe(true);
    markRaceIfPinned(error, pin);
    expect(isRetryableRace(error)).toBe(true);
  });

  test("a named constraint is sufficient when it belongs to the pin", () => {
    const error = new UniqueConstraintError("duplicate", {
      meta: { constraint: '"POSTS_TENANT_SLUG_KEY"' },
    });
    expect(racePinMatches(error, pin)).toBe(true);
  });

  test.each([
    ["wrong table", { table: "comments", columns: ["tenant_id", "slug"] }],
    ["missing attribution", {}],
    ["wrong column count", { columns: ["slug"] }],
    ["wrong column", { columns: ["tenant_id", "title"] }],
    ["wrong constraint", { constraint: "posts_slug_key" }],
  ] as const)("refuses %s", (_name, meta) => {
    const error = new UniqueConstraintError("duplicate", { meta });
    expect(racePinMatches(error, pin)).toBe(false);
    markRaceIfPinned(error, pin);
    expect(isRetryableRace(error)).toBe(false);
  });

  test.each([
    VibORMErrorCode.DEADLOCK,
    VibORMErrorCode.SERIALIZATION_FAILURE,
  ] as const)("marks an in-flight %s failure at a pinned write", (code) => {
    const error = new QueryError("retry the transaction", { code });
    markRaceIfPinned(error, pin);
    expect(isRetryableRace(error)).toBe(true);
  });

  test("does not mark an unrelated typed failure merely because the step had a pin", () => {
    const error = new QueryError("provider failed");
    markRaceIfPinned(error, pin);
    expect(isRetryableRace(error)).toBe(false);
  });
});

describe("explicit retry marks", () => {
  test("a declared expected race is retryable without an executor identity mark", () => {
    const error = new TransactionError("premise changed");
    error.meta.raceable = true;
    expect(isRetryableRace(error)).toBe(true);
  });

  test("engine defects never become retryable from public-looking metadata", () => {
    const error = new QueryEngineError("broken invariant", {
      meta: { raceable: true },
    });
    expect(isRetryableRace(error)).toBe(false);
  });

  test("the executor mark is identity-based and ignores primitive throwables", () => {
    const marked = {};
    markRaceable(marked);
    expect(isRetryableRace(marked)).toBe(true);

    markRaceable("not an error object");
    expect(isRetryableRace("not an error object")).toBe(false);
    expect(isRetryableRace(null)).toBe(false);
  });
});
