import {
  selectorConstraint,
  updateResultConstraints,
} from "@query-engine/TargetConstraint";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

const target = s.model({
  id: s.int().id(),
  code: s.string().unique(),
  label: s.string(),
});

describe("own-write update target footprints", () => {
  test("keeps payload-only updates out of the operation target ledger", () => {
    const selector = selectorConstraint(target, { id: 1 });

    expect(
      updateResultConstraints(target, selector, { label: "after" }, { id: 1 })
    ).toEqual([]);
  });

  test("exports before and after constraints for any changed unique field", () => {
    const selector = selectorConstraint(target, { id: 1 });
    const constraints = updateResultConstraints(
      target,
      selector,
      { code: "after" },
      { id: 1 }
    );

    expect(constraints).toHaveLength(2);
    expect([...constraints[0]!.fields.keys()]).toEqual(["id"]);
    expect([...constraints[1]!.fields.keys()]).toEqual(["code", "id"]);
    expect(
      constraints.every((constraint) => constraint.certainty === "exact")
    ).toBe(true);
  });
});
