import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createQueryScope } from "@query-engine";
import { separateData } from "@query-engine/builders/relation-data-builder";
import {
  analyzeOwnWriteTree,
  assertNoRelationsOwnWriteDependencies,
} from "@query-engine/OwnWriteAnalyzer";
import {
  getMembershipReadOrientation,
  getRelationMembershipEndpoints,
} from "@query-engine/OwnWriteLedger";
import { getRelationMembershipScope } from "@query-engine/RelationMembership";
import {
  planRelationMutationSteps,
  type RelationMutationStep,
} from "@query-engine/RelationMutationPlan";
import { selectorConstraint } from "@query-engine/TargetConstraint";
import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

const target = s
  .model({
    id: s.int().id(),
    code: s.string().unique(),
    enabled: s.boolean(),
  })
  .unique(["enabled"], { name: "enabled_key" });

const parent = s.model({
  id: s.int().id(),
  targets: s.manyToMany(() => target),
});

const generatedTarget = s.model({
  id: s.int().id().increment(),
  code: s
    .string()
    .default(() => "generated")
    .unique(),
});

const generatedParent = s.model({
  id: s.int().id(),
  targets: s.manyToMany(() => generatedTarget),
});

const selfNode = s.model({
  id: s.int().id(),
  parentId: s.int().nullable(),
  parent: s
    .manyToOne(() => selfNode)
    .fields("parentId")
    .references("id")
    .name("parent")
    .optional(),
  children: s.oneToMany(() => selfNode).name("parent"),
});

function relationMutation(
  schema: Record<string, ReturnType<typeof s.model>>,
  parentModel: ReturnType<typeof s.model>,
  input: Record<string, unknown>
) {
  hydrateSchemaNames(schema);
  const ctx = createQueryScope(new PostgresAdapter(), parentModel);
  const relations = separateData(ctx, { targets: input }).relations;
  if (!relations.targets) throw new Error("Expected targets relation mutation");
  return { ctx, relations };
}

const schema = { parent, target };
const generatedSchema = { parent: generatedParent, target: generatedTarget };

function selfRelationMutation(input: Record<string, unknown>) {
  const selfSchema = { node: selfNode };
  hydrateSchemaNames(selfSchema);
  const ctx = createQueryScope(new PostgresAdapter(), selfNode);
  return { ctx, ...separateData(ctx, input) };
}

function summarizeSelfChildrenStep(
  input: Record<string, unknown>,
  kind: "connect" | "createMany"
) {
  const plan = selfRelationMutation({ children: input });
  const relation = plan.relations.children;
  if (!relation) throw new Error("Expected children relation mutation");
  const step = planRelationMutationSteps("children", relation, "after").find(
    (
      candidate
    ): candidate is Extract<RelationMutationStep, { kind: typeof kind }> =>
      candidate.kind === kind
  );
  if (!step) throw new Error(`Expected ${kind} step`);

  const ledger = analyzeOwnWriteTree(plan.ctx, plan.relations, {
    kind: "update",
    scalarData: {},
    selector: { id: 1 },
  });
  const currentConstraint = selectorConstraint(selfNode, { id: 1 });
  const targetConstraint = selectorConstraint(selfNode, { id: 2 });
  const membershipScope = getRelationMembershipScope(
    plan.ctx,
    relation.relationInfo
  );
  return {
    ledger,
    membershipScope,
    membershipOrientation: getMembershipReadOrientation(
      plan.ctx,
      relation.relationInfo
    ),
    endpoints: getRelationMembershipEndpoints(
      plan.ctx,
      relation.relationInfo,
      membershipScope,
      currentConstraint,
      targetConstraint
    ),
  };
}

describe("connectOrCreate own-write dependency", () => {
  test("rejects create followed by connectOrCreate for the same key", () => {
    const plan = relationMutation(schema, parent, {
      create: { id: 1, code: "first", enabled: false },
      connectOrCreate: {
        where: { id: 1 },
        create: { id: 1, code: "second", enabled: false },
      },
    });

    expect(() =>
      assertNoRelationsOwnWriteDependencies(plan.ctx, plan.relations, {
        kind: "update",
        scalarData: {},
        selector: undefined,
      })
    ).toThrow(
      "Nested operation 'connectOrCreate' on relation 'targets' depends on an earlier 'create' target write"
    );
  });

  test("rejects alternate unique aliases across connectOrCreate items", () => {
    const plan = relationMutation(schema, parent, {
      connectOrCreate: [
        {
          where: { id: 1 },
          create: { id: 1, code: "alias", enabled: false },
        },
        {
          where: { code: "alias" },
          create: { id: 2, code: "alias", enabled: true },
        },
      ],
    });

    expect(() =>
      assertNoRelationsOwnWriteDependencies(plan.ctx, plan.relations, {
        kind: "update",
        scalarData: {},
        selector: undefined,
      })
    ).toThrow("depends on an earlier 'connectOrCreate' target write");
  });

  test("rejects missing generated/default identities as unknown", () => {
    const plan = relationMutation(generatedSchema, generatedParent, {
      create: { code: "generated" },
      connectOrCreate: {
        where: { id: 1 },
        create: { code: "generated" },
      },
    });

    expect(() =>
      assertNoRelationsOwnWriteDependencies(plan.ctx, plan.relations, {
        kind: "update",
        scalarData: {},
        selector: undefined,
      })
    ).toThrow("depends on an earlier 'create' target write");
  });

  test("allows provably disjoint integer and boolean identities", () => {
    const integerPlan = relationMutation(schema, parent, {
      createMany: {
        data: [{ id: 2, code: "two", enabled: false }],
      },
      connectOrCreate: {
        where: { id: 1 },
        create: { id: 1, code: "one", enabled: true },
      },
    });
    const booleanPlan = relationMutation(schema, parent, {
      create: { id: 2, code: "two", enabled: false },
      connectOrCreate: {
        where: { enabled_key: { enabled: true } },
        create: { id: 1, code: "one", enabled: true },
      },
    });

    expect(() =>
      assertNoRelationsOwnWriteDependencies(
        integerPlan.ctx,
        integerPlan.relations,
        { kind: "update", scalarData: {}, selector: undefined }
      )
    ).not.toThrow();
    expect(() =>
      assertNoRelationsOwnWriteDependencies(
        booleanPlan.ctx,
        booleanPlan.relations,
        { kind: "update", scalarData: {}, selector: undefined }
      )
    ).not.toThrow();
  });
});

describe("root membership overlay ordering", () => {
  test("reports an earlier physical write before the root inverse overlay", () => {
    const plan = selfRelationMutation({
      parentId: 2,
      parent: { connect: { id: 1 } },
      children: {
        upsert: {
          where: { id: 1 },
          create: { id: 1 },
          update: {},
        },
      },
    });

    expect(() =>
      assertNoRelationsOwnWriteDependencies(plan.ctx, plan.relations, {
        kind: "update",
        scalarData: plan.scalarData,
        selector: { id: 1 },
      })
    ).toThrow("depends on an earlier 'connect' membership write");
  });
});

describe("operation-visible membership summaries", () => {
  test.each([
    {
      kind: "createMany" as const,
      input: { createMany: { data: [{ id: 2 }] } },
    },
    { kind: "connect" as const, input: { connect: { id: 2 } } },
  ])("exports a nested $kind edge across scopes", ({ kind, input }) => {
    const summary = summarizeSelfChildrenStep(input, kind);

    expect(() =>
      summary.ledger.assertMembershipRead(
        "outer-children",
        "upsert",
        summary.endpoints,
        summary.membershipScope,
        summary.membershipOrientation
      )
    ).toThrow(`depends on an earlier '${kind}' membership write`);
  });
});
