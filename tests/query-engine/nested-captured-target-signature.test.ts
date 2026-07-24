import { uniqueRecords } from "@query-engine/RelationProgramValues";
import { describe, expect, test } from "vitest";

describe("captured target primary-key signatures", () => {
  test("distinguishes and deduplicates boolean primary-key carriers", () => {
    expect(uniqueRecords([{ id: true }, { id: false }, { id: true }])).toEqual([
      { id: true },
      { id: false },
    ]);
  });
});
