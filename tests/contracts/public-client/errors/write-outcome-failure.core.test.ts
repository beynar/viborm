import { retainWriteOutcomeFailure } from "@src/errors/query";
import { describe, expect, test } from "vitest";

describe("retainWriteOutcomeFailure", () => {
  test("keeps the primary first and as the cause, beside one outcome failure", () => {
    const primary = new Error("query");
    const outcome = new Error("listener");
    const failure = retainWriteOutcomeFailure(primary, outcome);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([primary, outcome]);
    expect(failure.cause).toBe(primary);
    expect(failure.message).toBe(
      "Query execution and write-outcome publication both failed."
    );
  });

  test("flattens an aggregate of listener failures and takes a caller message", () => {
    const primary = new Error("query");
    const first = new Error("first listener");
    const second = new Error("second listener");
    const failure = retainWriteOutcomeFailure(
      primary,
      new AggregateError([first, second], "listeners"),
      "both failed"
    );

    expect(failure.errors).toEqual([primary, first, second]);
    expect(failure.message).toBe("both failed");
  });
});
