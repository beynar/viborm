import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { separateData } from "@query-engine/builders/relation-data-builder";
import { createQueryScope } from "@query-engine/context/query-scope";
import { planRelationMutationSteps } from "@query-engine/RelationMutationPlan";
import {
  classifyTargetConstraintOverlap,
  normalizeTargetConstraint,
  normalizeWhereUniqueTargetConstraint,
} from "@query-engine/TargetConstraint";
import { s } from "@schema";
import { sql } from "@sql";
import { describe, expect, test } from "vitest";

const target = s
  .model({
    id: s.int().id().map("target_id"),
    tenantId: s.int().map("tenant_id"),
    sequence: s.int().map("sequence_no"),
    externalId: s.bigInt().unique(),
    enabled: s.boolean(),
    code: s.string().unique(),
    occurredAt: s.dateTime().unique(),
    digest: s.blob(),
    amount: s.decimal().unique(),
    generated: s.int().increment().unique(),
    defaulted: s
      .string()
      .default(() => "generated")
      .unique(),
  })
  .unique(["tenantId", "sequence"], { name: "tenant_sequence" });

const owner = s.model({
  id: s.int().id(),
  targets: s.manyToMany(() => target),
});

const ownerCtx = createQueryScope(new PostgresAdapter(), owner);

function whereConstraint(where: Record<string, unknown>) {
  return normalizeWhereUniqueTargetConstraint(target, where);
}

function plannedConnectOrCreateInputs(
  inputs: Array<{
    where: Record<string, unknown>;
    create: Record<string, unknown>;
  }>
) {
  const mutation = separateData(ownerCtx, {
    targets: { connectOrCreate: inputs },
  }).relations.targets;
  if (!mutation) throw new Error("Expected targets relation mutation");

  const step = planRelationMutationSteps("targets", mutation).find(
    (candidate) => candidate.kind === "connectOrCreate"
  );
  if (!step || step.kind !== "connectOrCreate") {
    throw new Error("Expected connectOrCreate plan step");
  }
  return step.inputs;
}

describe("target constraint normalization", () => {
  test("normalizes scalar and compound selectors by model field name and sorted order", () => {
    const scalar = whereConstraint({ id: 7 });
    const compound = whereConstraint({
      tenant_sequence: { sequence: 2, tenantId: 1 },
    });

    expect([...scalar.fields.keys()]).toEqual(["id"]);
    expect([...compound.fields.keys()]).toEqual(["sequence", "tenantId"]);
    expect([...compound.fields.keys()]).not.toContain("sequence_no");
    expect(compound.certainty).toBe("exact");
  });

  test("proves equality only from exact type-tagged values", () => {
    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ tenant_sequence: { tenantId: 1, sequence: 2 } }),
        whereConstraint({
          tenant_sequence: { sequence: 2, tenantId: 1 },
        })
      )
    ).toBe("equal");
    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ externalId: 9n }),
        whereConstraint({ externalId: 9n })
      )
    ).toBe("equal");
    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ code: "same" }),
        whereConstraint({ code: "same" })
      )
    ).toBe("equal");
    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ amount: 1.25 }),
        whereConstraint({ amount: 1.25 })
      )
    ).toBe("equal");
    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ id: 1 }),
        whereConstraint({ externalId: 1n })
      )
    ).toBe("unknown");
  });

  test("proves disjointness only for unequal int, bigint, and boolean fields", () => {
    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ id: 1 }),
        whereConstraint({ id: 2 })
      )
    ).toBe("disjoint");
    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ externalId: 1n }),
        whereConstraint({ externalId: 2n })
      )
    ).toBe("disjoint");
    expect(
      classifyTargetConstraintOverlap(
        normalizeTargetConstraint(target, ["enabled"], { enabled: true }),
        normalizeTargetConstraint(target, ["enabled"], { enabled: false })
      )
    ).toBe("disjoint");
  });

  test("keeps collation and normalization-sensitive unequal values unknown", () => {
    const firstDate = normalizeTargetConstraint(target, ["occurredAt"], {
      occurredAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    const secondDate = normalizeTargetConstraint(target, ["occurredAt"], {
      occurredAt: new Date("2025-01-01T00:00:00.001Z"),
    });
    const firstBytes = normalizeTargetConstraint(target, ["digest"], {
      digest: new Uint8Array([1, 2]),
    });
    const secondBytes = normalizeTargetConstraint(target, ["digest"], {
      digest: new Uint8Array([1, 3]),
    });

    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ code: "Résumé" }),
        whereConstraint({ code: "resume" })
      )
    ).toBe("unknown");
    expect(classifyTargetConstraintOverlap(firstDate, secondDate)).toBe(
      "unknown"
    );
    expect(classifyTargetConstraintOverlap(firstBytes, secondBytes)).toBe(
      "unknown"
    );
    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ amount: 1.1 }),
        whereConstraint({ amount: 1.2 })
      )
    ).toBe("unknown");
  });

  test("recognizes identical date and byte values exactly", () => {
    const date = new Date("2025-01-01T00:00:00.000Z");
    const leftDate = normalizeTargetConstraint(target, ["occurredAt"], {
      occurredAt: date,
    });
    const rightDate = normalizeTargetConstraint(target, ["occurredAt"], {
      occurredAt: new Date(date),
    });
    const leftBytes = normalizeTargetConstraint(target, ["digest"], {
      digest: new Uint8Array([0, 128, 255]),
    });
    const rightBytes = normalizeTargetConstraint(target, ["digest"], {
      digest: new Uint8Array([0, 128, 255]),
    });

    expect(classifyTargetConstraintOverlap(leftDate, rightDate)).toBe("equal");
    expect(classifyTargetConstraintOverlap(leftBytes, rightBytes)).toBe(
      "equal"
    );
  });

  test("marks missing generated/default fields and non-literals unknown", () => {
    const generated = normalizeTargetConstraint(target, ["generated"], {});
    const defaulted = normalizeTargetConstraint(target, ["defaulted"], {});
    const envelope = normalizeTargetConstraint(target, ["id"], {
      id: { increment: 1 },
    });
    const fragment = normalizeTargetConstraint(target, ["id"], {
      id: sql`${1}`,
    });
    const filter = normalizeTargetConstraint(target, ["code"], {
      code: { equals: "x", mode: "insensitive" },
    });

    expect(generated.certainty).toBe("unknown");
    expect(defaulted.certainty).toBe("unknown");
    expect(envelope.certainty).toBe("unknown");
    expect(fragment.certainty).toBe("unknown");
    expect(filter.certainty).toBe("unknown");
  });
});

describe("connectOrCreate exact-target dedupe", () => {
  test("keeps first create for identical compound and bigint selectors", () => {
    const inputs = plannedConnectOrCreateInputs([
      {
        where: { tenant_sequence: { tenantId: 1, sequence: 2 } },
        create: { code: "first" },
      },
      {
        where: { tenant_sequence: { sequence: 2, tenantId: 1 } },
        create: { code: "second" },
      },
      { where: { externalId: 9n }, create: { code: "bigint-first" } },
      { where: { externalId: 9n }, create: { code: "bigint-second" } },
      { where: { code: "same" }, create: { code: "string-first" } },
      { where: { code: "same" }, create: { code: "string-second" } },
    ]);

    expect(inputs).toHaveLength(3);
    expect(inputs.map((input) => input.create.code)).toEqual([
      "first",
      "bigint-first",
      "string-first",
    ]);
  });

  test("does not dedupe alternate unique aliases or unequal strings", () => {
    const inputs = plannedConnectOrCreateInputs([
      { where: { id: 1 }, create: { code: "by-id" } },
      { where: { code: "1" }, create: { code: "by-code" } },
      { where: { code: "Résumé" }, create: { code: "accented" } },
      { where: { code: "resume" }, create: { code: "plain" } },
    ]);

    expect(inputs).toHaveLength(4);
  });
});
