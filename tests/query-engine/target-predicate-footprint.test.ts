import {
  buildScalarUpdatePredicateFootprints,
  classifyTargetConstraintOverlap,
  getFilterPredicateFields,
  getFilterTargetConstraint,
  normalizeWhereUniqueTargetConstraint,
  predicateFieldSetsIntersect,
} from "@query-engine/TargetConstraint";
import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

const node = s.model({
  id: s.int().id(),
  alternateId: s.int().unique(),
  title: s.string(),
  peers: s
    .manyToMany(() => node)
    .A("sourceId")
    .B("targetId"),
  peeredBy: s.manyToMany(() => node),
});

hydrateSchemaNames({ node });

describe("scalar update target-predicate footprints", () => {
  test("tracks literal and set identity transitions as before/after candidates", () => {
    const literal = buildScalarUpdatePredicateFootprints(
      node,
      { id: 2 },
      { id: 1 }
    );
    const set = buildScalarUpdatePredicateFootprints(
      node,
      { id: { set: 2 } },
      { id: 1 }
    );
    const oldTarget = normalizeWhereUniqueTargetConstraint(node, { id: 1 });
    const newTarget = normalizeWhereUniqueTargetConstraint(node, { id: 2 });
    const disjointTarget = normalizeWhereUniqueTargetConstraint(node, {
      id: 3,
    });

    for (const footprints of [literal, set]) {
      expect(footprints).toHaveLength(2);
      expect(
        footprints.some(
          (footprint) =>
            classifyTargetConstraintOverlap(footprint.constraint, oldTarget) ===
            "equal"
        )
      ).toBe(true);
      expect(
        footprints.some(
          (footprint) =>
            classifyTargetConstraintOverlap(footprint.constraint, newTarget) ===
            "equal"
        )
      ).toBe(true);
      expect(
        footprints.every(
          (footprint) =>
            classifyTargetConstraintOverlap(
              footprint.constraint,
              disjointTarget
            ) === "disjoint"
        )
      ).toBe(true);
    }
  });

  test("keeps a computed identity transition unknown", () => {
    const footprints = buildScalarUpdatePredicateFootprints(
      node,
      { id: { increment: 1 } },
      { id: 1 }
    );
    const otherTarget = normalizeWhereUniqueTargetConstraint(node, { id: 3 });

    expect(footprints).toHaveLength(2);
    expect(
      classifyTargetConstraintOverlap(footprints[1]!.constraint, otherTarget)
    ).toBe("unknown");
  });

  test("does not turn a payload-only update into an identity transition", () => {
    const footprints = buildScalarUpdatePredicateFootprints(
      node,
      { title: "after" },
      { id: 1 }
    );

    expect(footprints).toHaveLength(1);
    expect([...footprints[0]!.changedFields]).toEqual(["title"]);
    expect(
      predicateFieldSetsIntersect(footprints[0]!.changedFields, new Set(["id"]))
    ).toBe(false);
    expect(
      predicateFieldSetsIntersect(
        footprints[0]!.changedFields,
        new Set(["title"])
      )
    ).toBe(true);
  });

  test("extracts recursive scalar filter fields and marks relation filters unknown", () => {
    const scalarFields = getFilterPredicateFields(node, {
      AND: [
        { title: { contains: "after" } },
        { OR: [{ id: 1 }, { NOT: { alternateId: 2 } }] },
      ],
    });
    const relationFields = getFilterPredicateFields(node, {
      peers: { some: { id: 1 } },
    });

    expect(
      scalarFields === "unknown" ? scalarFields : [...scalarFields].sort()
    ).toEqual(["alternateId", "id", "title"]);
    expect(relationFields).toBe("unknown");
  });

  test("extracts exact identity candidates from safe filter equality", () => {
    const direct = getFilterTargetConstraint(node, {
      id: 100,
      title: "after",
    });
    const equals = getFilterTargetConstraint(node, {
      id: { equals: 100 },
    });
    const range = getFilterTargetConstraint(node, { id: { gt: 100 } });
    const target100 = normalizeWhereUniqueTargetConstraint(node, { id: 100 });
    const target101 = normalizeWhereUniqueTargetConstraint(node, { id: 101 });

    for (const constraint of [direct, equals]) {
      expect(classifyTargetConstraintOverlap(constraint, target100)).not.toBe(
        "disjoint"
      );
      expect(classifyTargetConstraintOverlap(constraint, target101)).toBe(
        "disjoint"
      );
    }
    expect(classifyTargetConstraintOverlap(range, target101)).toBe("unknown");
  });
});
