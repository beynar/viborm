import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createQueryScope } from "@query-engine/context/query-scope";
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
  // RETARGETED by N6-U3 (own-write linearization, ATOM §4.1). The derivation now walks
  // the ONE order the parts are emitted in, and `connectOrCreate` — a named reader,
  // because it must read to choose its arm — is ordered BEFORE `create`, a pure adder
  // that reads nothing. So there is no dependency here to find: the adopt's probe reads
  // committed state, decides, and the duplicate insert is then refused by the unique
  // constraint (the N2-U1 disposition — one guard per invariant, and the database owns
  // uniqueness). The second half of this test is what keeps it from passing against a
  // ledger that has simply gone blind.
  test("orders a same-key connectOrCreate ahead of the create, and still sees the reverse", () => {
    const adoptThenCreate = relationMutation(schema, parent, {
      create: { id: 1, code: "first", enabled: false },
      connectOrCreate: {
        where: { id: 1 },
        create: { id: 1, code: "second", enabled: false },
      },
    });

    expect(() =>
      assertNoRelationsOwnWriteDependencies(
        adoptThenCreate.ctx,
        adoptThenCreate.relations,
        { kind: "update", scalarData: {}, selector: undefined }
      )
    ).not.toThrow();

    // Same key, but now the READ is genuinely behind the WRITE in the linearization:
    // `set` (stage 2) must read whether the row it lists exists, and the sibling adopt
    // (stage 1) writes that existence. No ordering dissolves this one, and it is the
    // class the amendment keeps rejecting.
    const adoptThenSet = relationMutation(schema, parent, {
      connectOrCreate: {
        where: { id: 1 },
        create: { id: 1, code: "second", enabled: false },
      },
      set: [{ id: 1 }],
    });

    expect(() =>
      assertNoRelationsOwnWriteDependencies(
        adoptThenSet.ctx,
        adoptThenSet.relations,
        { kind: "update", scalarData: {}, selector: undefined }
      )
    ).toThrow(
      "Nested operation 'set' on relation 'targets' depends on an earlier 'connectOrCreate' target write"
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

  // RETARGETED by N6-U3, and the CLAIM is preserved rather than dropped: a write whose
  // identity the payload does not spell must classify as `unknown`, never as disjoint,
  // so a later read fails closed. Only the pair carrying it had to move. The old pair
  // (`create` then `connectOrCreate`) no longer has a read behind a write at all under
  // the linearization; this one does — `set` reads existence in stage 2, behind the
  // stage-1 adopt whose create arm omits the generated primary key.
  test("treats a missing generated/default identity as unknown, not disjoint", () => {
    const plan = relationMutation(generatedSchema, generatedParent, {
      connectOrCreate: {
        where: { id: 1 },
        create: { code: "generated" },
      },
      set: [{ id: 2 }],
    });

    expect(() =>
      assertNoRelationsOwnWriteDependencies(plan.ctx, plan.relations, {
        kind: "update",
        scalarData: {},
        selector: undefined,
      })
    ).toThrow("depends on an earlier 'connectOrCreate' target write");
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
