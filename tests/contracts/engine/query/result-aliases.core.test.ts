import { COUNT_RESULT_KEY } from "@adapters/shared/result-parsing";
import {
  DISTANCE_RESULT_KEY,
  EMPTY_ROW_RESULT_KEY,
  getAggregateResultKey,
  getAggregateResultName,
  RELATION_COUNTS_RESULT_KEY,
} from "@query-engine/result-aliases";
import {
  isValidSchemaIdentifier,
  MAX_SCHEMA_IDENTIFIER_BYTES,
} from "@schema/identifier";
import { describe, expect, test } from "vitest";

const AGGREGATE_NAMES = ["_count", "_avg", "_sum", "_min", "_max"] as const;
const PRIVATE_RESULT_KEY_PATTERN = /^0viborm_/;
const PRIVATE_RESULT_KEYS = [
  COUNT_RESULT_KEY,
  DISTANCE_RESULT_KEY,
  RELATION_COUNTS_RESULT_KEY,
  EMPTY_ROW_RESULT_KEY,
  ...AGGREGATE_NAMES.map(getAggregateResultKey),
];

describe("private result aliases", () => {
  test.each(
    PRIVATE_RESULT_KEYS
  )("%s is collision-proof and portable across identifier limits", (resultKey) => {
    expect(resultKey).toMatch(PRIVATE_RESULT_KEY_PATTERN);
    expect(isValidSchemaIdentifier(resultKey)).toBe(false);
    expect(new TextEncoder().encode(resultKey).length).toBeLessThanOrEqual(
      MAX_SCHEMA_IDENTIFIER_BYTES
    );
  });

  test.each(AGGREGATE_NAMES)("round-trips aggregate carrier %s", (name) => {
    expect(getAggregateResultName(getAggregateResultKey(name))).toBe(name);
  });
});
