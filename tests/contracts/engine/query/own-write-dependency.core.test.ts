import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { bindRelation } from "@query-engine/builders/relation-data-builder";
import { buildParsedRelationPrograms } from "@query-engine/builders/relation-mutation-parser";
import {
  analyzeOwnWriteTree,
  assertNoRelationsOwnWriteDependencies,
} from "@query-engine/OwnWriteAnalyzer";
import {
  getMembershipReadOrientation,
  getRelationMembershipEndpoints,
} from "@query-engine/OwnWriteLedger";
import {
  getRelationMembershipScope,
  type RelationMembershipScope,
  relationMembershipScopesEqual,
} from "@query-engine/RelationMembership";
import { selectorConstraint } from "@query-engine/TargetConstraint";
import { s } from "@schema";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const target = s
  .model({
    id: s.int().id(),
    code: s.string().unique(),
    enabled: s.boolean(),
    parentId: s.int().nullable(),
    parent: s
      .toOne(() => parent)
      .fields("parentId")
      .references("id"),
  })
  .unique(["enabled"], { name: "enabled_key" });

const parent = s.model({
  id: s.int().id(),
  targets: s.toMany(() => target),
});

const generatedTarget = s.model({
  id: s.int().id().increment(),
  code: s
    .string()
    .default(() => "generated")
    .unique(),
  parentId: s.int().nullable(),
  parent: s
    .toOne(() => generatedParent)
    .fields("parentId")
    .references("id"),
});

const generatedParent = s.model({
  id: s.int().id(),
  targets: s.toMany(() => generatedTarget),
});

const selfNode = s.model({
  id: s.int().id(),
  parentId: s.int().nullable(),
  parent: s
    .toOne(() => selfNode)
    .fields("parentId")
    .references("id")
    .name("parent"),
  children: s.toMany(() => selfNode).name("parent"),
});

function relationMutation(
  schema: Record<string, ReturnType<typeof s.model>>,
  parentModel: ReturnType<typeof s.model>,
  input: Record<string, unknown>
) {
  prepareSchema(schema);
  const ctx = scopeFor(new PostgresAdapter(), parentModel);
  const relations = buildParsedRelationPrograms(ctx, {
    targets: input,
  }).relations;
  if (!relations.some((entry) => entry.name === "targets")) {
    throw new Error("Expected targets relation mutation");
  }
  return { ctx, relations };
}

const schema = { parent, target };
const generatedSchema = { parent: generatedParent, target: generatedTarget };

function selfRelationMutation(input: Record<string, unknown>) {
  const selfSchema = { node: selfNode };
  prepareSchema(selfSchema);
  const ctx = scopeFor(new PostgresAdapter(), selfNode);
  return { ctx, ...buildParsedRelationPrograms(ctx, input) };
}

function summarizeSelfChildrenStep(
  input: Record<string, unknown>,
  kind: "connect" | "create" | "createMany" | "update" | "updateMany"
) {
  const plan = selfRelationMutation({ children: input });
  const parsed = plan.relations.find((entry) => entry.name === "children");
  if (parsed?.kind !== "ordinary") {
    throw new Error("Expected children relation mutation");
  }
  const relation = parsed.program;
  const step = relation.entries.find((candidate) => candidate.kind === kind);
  if (!step) throw new Error(`Expected ${kind} step`);

  const ledger = analyzeOwnWriteTree(plan.ctx, plan.relations, {
    kind: "update",
    scalarData: {},
    selector: { id: 1 },
  });
  const currentConstraint = selectorConstraint(selfNode, { id: 1 });
  const targetConstraint = selectorConstraint(selfNode, { id: 2 });
  const boundRelation = bindRelation(plan.ctx, relation.relationRef);
  const membershipScope = getRelationMembershipScope(boundRelation);
  return {
    ledger,
    membershipScope,
    membershipOrientation: getMembershipReadOrientation(boundRelation),
    endpoints: getRelationMembershipEndpoints(
      boundRelation,
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

  test("a repeated selector still sees an intervening alternate-selector write", () => {
    const plan = relationMutation(schema, parent, {
      connectOrCreate: [
        {
          where: { id: 1 },
          create: { id: 3, code: "first", enabled: false },
        },
        {
          where: { id: 2 },
          create: { id: 1, code: "intervening", enabled: true },
        },
        {
          where: { id: 1 },
          create: { id: 4, code: "third", enabled: false },
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
  test("a nested scalar-only create still publishes its insert membership", () => {
    const summary = summarizeSelfChildrenStep({ create: { id: 2 } }, "create");

    expect(() =>
      summary.ledger.assertMembershipRead(
        "outer-children",
        "upsert",
        summary.endpoints,
        summary.membershipScope,
        summary.membershipOrientation
      )
    ).toThrow("depends on an earlier 'create' membership write");
  });

  test("a nested scalar-only update still publishes its key transition", () => {
    const summary = summarizeSelfChildrenStep(
      { update: { where: { id: 2 }, data: { parentId: 3 } } },
      "update"
    );

    expect(() =>
      summary.ledger.assertMembershipRead(
        "outer-children",
        "upsert",
        summary.endpoints,
        summary.membershipScope,
        summary.membershipOrientation
      )
    ).toThrow("depends on an earlier 'update' membership write");
  });

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

  test("exports a relation-bearing createMany row as one complete create tree", () => {
    const summary = summarizeSelfChildrenStep(
      {
        createMany: {
          data: [{ id: 2, parent: { connect: { id: 3 } } }],
        },
      },
      "createMany"
    );

    expect(() =>
      summary.ledger.assertMembershipRead(
        "outer-children",
        "upsert",
        summary.endpoints,
        summary.membershipScope,
        summary.membershipOrientation
      )
    ).toThrow("depends on an earlier 'createMany' membership write");
  });

  test("publishes relation-bearing updateMany member effects after the series footprint", () => {
    const summary = summarizeSelfChildrenStep(
      {
        updateMany: {
          where: { id: 2 },
          data: { parent: { connect: { id: 3 } } },
        },
      },
      "updateMany"
    );

    expect(() =>
      summary.ledger.assertMembershipRead(
        "outer-children",
        "upsert",
        summary.endpoints,
        summary.membershipScope,
        summary.membershipOrientation
      )
    ).toThrow("depends on an earlier 'updateMany' membership write");
  });
});

describe("relation membership scope identity", () => {
  const polymorphicScope: RelationMembershipScope = {
    kind: "polymorphicForeignKey",
    holder: target,
    referenced: parent,
    typeField: "subjectType",
    storedType: "target.v1",
    identityField: "subjectId",
    referencedField: "id",
  };

  test("compares every fixed polymorphic membership component", () => {
    expect(
      relationMembershipScopesEqual(polymorphicScope, {
        ...polymorphicScope,
      })
    ).toBe(true);
    expect(
      relationMembershipScopesEqual(polymorphicScope, {
        ...polymorphicScope,
        referencedField: "code",
      })
    ).toBe(false);
  });

  test("never equates row-held membership protocols of different kinds", () => {
    expect(
      relationMembershipScopesEqual(polymorphicScope, {
        kind: "foreignKey",
        holder: target,
        referenced: parent,
        fields: [{ foreignKey: "subjectId", referencedKey: "id" }],
      })
    ).toBe(false);
  });
});

describe("self-relation to-one update footprint", () => {
  test("treats either side's key change as a write to the shared membership", () => {
    const plan = selfRelationMutation({
      parent: { update: { data: { parentId: 3 } } },
    });
    const parsed = plan.relations.find((entry) => entry.name === "parent");
    if (parsed?.kind !== "ordinary") {
      throw new Error("Expected parent relation mutation");
    }
    const boundRelation = bindRelation(plan.ctx, parsed.program.relationRef);
    const membershipScope = getRelationMembershipScope(boundRelation);
    const currentConstraint = selectorConstraint(selfNode, { id: 1 });
    const targetConstraint = selectorConstraint(selfNode, { id: 2 });
    const ledger = analyzeOwnWriteTree(plan.ctx, plan.relations, {
      kind: "update",
      scalarData: {},
      selector: { id: 1 },
    });

    expect(() =>
      ledger.assertMembershipRead(
        "parent",
        "upsert",
        getRelationMembershipEndpoints(
          boundRelation,
          membershipScope,
          currentConstraint,
          targetConstraint
        ),
        membershipScope,
        getMembershipReadOrientation(boundRelation)
      )
    ).toThrow("depends on an earlier 'update' membership write");
  });
});
