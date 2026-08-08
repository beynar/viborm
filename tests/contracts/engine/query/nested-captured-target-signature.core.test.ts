import { describe, expect, test } from "vitest";

function uniqueRecords<T extends Record<string, unknown>>(
  values: readonly T[]
): T[] {
  const unique: T[] = [];
  for (const value of values) {
    if (!unique.some((candidate) => recordsEqual(candidate, value))) {
      unique.push(value);
    }
  }
  return unique;
}

function recordsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

describe("captured target primary-key signatures", () => {
  test("distinguishes and deduplicates boolean primary-key carriers", () => {
    expect(uniqueRecords([{ id: true }, { id: false }, { id: true }])).toEqual([
      { id: true },
      { id: false },
    ]);
  });
});
