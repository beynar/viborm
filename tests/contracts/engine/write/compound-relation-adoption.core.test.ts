import {
  type CorrelatedForeignKeyMember,
  type ForeignKeyMember,
  literalParentId,
  pairForeignKeyMembers,
} from "@src/query-engine/write-engine/relation-membership";
import { describe, expect, test } from "vitest";

describe("E4-U2 membership source typing", () => {
  test("a write-only member cannot be used as a correlated member (type-level)", () => {
    const writeMembers: readonly ForeignKeyMember[] = pairForeignKeyMembers(
      [{ foreignField: "regionId", referencedField: "region" }],
      [literalParentId("eu")]
    );
    // @ts-expect-error a correlated member must name its independent planning source.
    const correlatedMembers: readonly CorrelatedForeignKeyMember[] =
      writeMembers;
    expect(writeMembers[0]?.referencedField).toBe("region");
    expect(correlatedMembers).toHaveLength(1);
  });
});
