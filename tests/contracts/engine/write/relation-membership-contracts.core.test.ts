import { QueryEngineError } from "@errors";
import type { PolymorphicStorageValue } from "@query-engine/builders/polymorphic-mutation";
import {
  bindRelation,
  hasPolymorphicMembership,
} from "@query-engine/builders/relation-data-builder";
import {
  createQueryScope,
  lookupRelation,
} from "@query-engine/context/query-scope";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { isSql, sql } from "@sql";
import { ref } from "@src/query-engine/write-engine/OperationFragment";
import { planningKey } from "@src/query-engine/write-engine/Part";
import {
  applyRootMembershipAssignment,
  bindCorrelatedRelationMembership,
  bindRelationMembership,
  finalMembershipCondition,
  finalMembershipWriteCondition,
  fkEquals,
  foreignKeyWriteValueWith,
  isPlanningFieldSource,
  linkedPolymorphicStorage,
  literalParentId,
  literalReferenceSource,
  literalReferenceValue,
  lowerEmptyMembership,
  lowerMembershipWrite,
  membershipProjection,
  type PlanningReferenceSource,
  pairCorrelatedForeignKeyMembers,
  pairForeignKeyMembers,
  plannedParentId,
  planningMembershipCondition,
  planningSourceFromFinal,
  type RootMembershipAssignment,
  recordHasMembership,
  resolveCorrelatedMembershipProgressivePremise,
  resolveFinalReferenceRowKey,
  resolveMembershipReadParentRowKey,
  resolveMembershipReferencedPremise,
  resolveMembershipWriteParentRowKey,
  selectedRowContinuity,
  transitionedParentId,
} from "@src/query-engine/write-engine/relation-membership";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { prepareSchema } from "@tests/fixtures/query-scope";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const schema = (() => {
  const account = s
    .model({
      tenantId: s.string(),
      id: s.string(),
      code: s.string().unique(),
      notes: s.toMany(() => note),
    })
    .id(["tenantId", "id"])
    .map("membership_accounts");
  const note = s
    .model({
      id: s.string().id(),
      accountCode: s.string().nullable(),
      account: s
        .toOne(() => account)
        .fields("accountCode")
        .references("code"),
    })
    .map("membership_notes");

  const article = s.model({
    id: s.int().id(),
    title: s.string(),
    cards: s.toMany(() => card).name("subject"),
  });
  const clip = s.model({ id: s.int().id(), title: s.string() });
  const card = s.model({
    id: s.string().id(),
    subject: s
      .toOne(
        { article: () => article, clip: () => clip },
        {
          values: {
            article: "membership.article.v1",
            clip: "membership.clip.v1",
          },
        }
      )
      .name("subject")
      .optional(),
  });
  return { account, note, article, clip, card };
})();

prepareSchema(schema);

function engine(): QueryEngine {
  const driver = new PlanningDriver("postgresql");
  return new QueryEngine(
    driver,
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
}

function ordinaryBinding(queryEngine: QueryEngine) {
  const accountScope = createQueryScope(queryEngine, schema.account);
  const relationRef = lookupRelation(accountScope, "notes");
  if (!relationRef) throw new Error("expected account.notes relation");
  const relation = bindRelation(accountScope, relationRef);
  if (
    relation.position !== "childHeld" ||
    relation.membership.kind !== "foreignKey"
  ) {
    throw new Error("expected an ordinary child-held relation");
  }
  return { accountScope, relation };
}

function polymorphicBinding(queryEngine: QueryEngine) {
  const articleScope = createQueryScope(queryEngine, schema.article);
  const relationRef = lookupRelation(articleScope, "cards");
  if (!relationRef) throw new Error("expected article.cards relation");
  const relation = bindRelation(articleScope, relationRef);
  // The membership axis is a NESTED discriminant: reading
  // `relation.membership.kind` narrows the membership reference, never the
  // relation holding it. `hasPolymorphicMembership` is production's narrowing
  // spelling of that exact test, and `PolymorphicChildHeldRelation` is the only
  // arm of `BoundRelation` carrying a polymorphic membership, so it proves
  // child-held placement too.
  if (!hasPolymorphicMembership(relation)) {
    throw new Error("expected a polymorphic child-held relation");
  }
  return { articleScope, relation };
}

describe("relation membership temporal sources", () => {
  test("keeps row identity and a non-primary reference on the same temporal side", () => {
    const queryEngine = engine();
    const { relation } = ordinaryBinding(queryEngine);
    const readSource = {
      kind: "planningField",
      step: "account.capture",
    } satisfies PlanningReferenceSource;
    const writeSource = transitionedParentId(
      "account.capture",
      (before, field) => (field === "code" ? "next-code" : before)
    );
    const binding = bindCorrelatedRelationMembership(
      relation,
      readSource,
      writeSource
    );
    const known = {
      [planningKey("account.capture", "rows")]: [
        { tenantId: "tenant-1", id: "account-1", code: "old-code" },
      ],
    };

    expect(resolveMembershipReadParentRowKey(binding, known, "update")).toEqual(
      { tenantId: "tenant-1", id: "account-1" }
    );
    expect(
      resolveMembershipWriteParentRowKey(binding, known, "update")
    ).toEqual({ tenantId: "tenant-1", id: "account-1" });
    expect(
      resolveCorrelatedMembershipProgressivePremise(
        binding,
        known,
        "update",
        "existingMembers"
      )
    ).toEqual({
      identity: { tenantId: "tenant-1", id: "account-1" },
      membership: { code: "old-code" },
    });
    expect(
      resolveCorrelatedMembershipProgressivePremise(
        binding,
        known,
        "update",
        "suppliedMember"
      )
    ).toEqual({
      identity: { tenantId: "tenant-1", id: "account-1" },
      membership: { code: "next-code" },
    });
  });

  test("uses exact field sources but refuses unrelated or opaque fallbacks", () => {
    const known = {
      [planningKey("account.capture", "rows")]: [
        { tenantId: "tenant-1", id: "account-1", code: "old-code" },
      ],
      [planningKey("other.capture", "rows")]: [
        { tenantId: "tenant-2", id: "account-2" },
      ],
    };
    expect(
      resolveFinalReferenceRowKey(
        schema.account,
        [
          { field: "tenantId", source: plannedParentId("account.capture") },
          { field: "id", source: plannedParentId("other.capture") },
        ],
        known,
        "notes",
        "update"
      )
    ).toEqual({ tenantId: "tenant-1", id: "account-2" });
    expect(
      resolveFinalReferenceRowKey(
        schema.account,
        [
          { field: "code", source: plannedParentId("account.capture") },
          { field: "code", source: plannedParentId("other.capture") },
        ],
        known,
        "notes",
        "update"
      )
    ).toBeUndefined();
    expect(
      resolveFinalReferenceRowKey(
        schema.account,
        [
          {
            field: "code",
            source: { kind: "lookup", statement: sql.raw("SELECT 1") },
          },
        ],
        known,
        "notes",
        "update"
      )
    ).toBeUndefined();
  });
});

describe("ordinary relation membership lowering", () => {
  test("uses the old value for reads and the transitioned value for writes", () => {
    const queryEngine = engine();
    const { relation } = ordinaryBinding(queryEngine);
    const noteScope = createQueryScope(queryEngine, schema.note);
    const binding = bindCorrelatedRelationMembership(
      relation,
      { kind: "planningField", step: "account.capture" },
      transitionedParentId("account.capture", () => "next-code")
    );
    const known = {
      [planningKey("account.capture", "rows")]: [
        { tenantId: "tenant-1", id: "account-1", code: "old-code" },
      ],
    };

    expect(
      planningMembershipCondition(queryEngine, noteScope, binding, "note")
    ).toEqual({
      filters: [
        {
          accountCode: {
            equals: ref("account.capture", "code"),
          },
        },
      ],
    });
    expect(
      finalMembershipCondition(
        queryEngine,
        noteScope,
        binding,
        "note",
        known,
        "update"
      )
    ).toEqual({ filters: [{ accountCode: { equals: "old-code" } }] });
    expect(
      finalMembershipWriteCondition(
        queryEngine,
        noteScope,
        binding,
        "note",
        known,
        "update"
      )
    ).toEqual({ filters: [{ accountCode: { equals: "next-code" } }] });
    expect(
      recordHasMembership(binding, { accountCode: "old-code" }, known, "update")
    ).toBe(true);
    expect(
      recordHasMembership(
        binding,
        { accountCode: "next-code" },
        known,
        "update"
      )
    ).toBe(false);
  });

  test("lowers linked, clear, projection, and non-row-key premise shapes", () => {
    const queryEngine = engine();
    const { relation } = ordinaryBinding(queryEngine);
    const noteScope = createQueryScope(queryEngine, schema.note);
    const binding = bindRelationMembership(
      relation,
      literalParentId("account-code")
    );
    const linked = lowerMembershipWrite(
      queryEngine,
      noteScope,
      binding,
      undefined,
      "create"
    );
    const accountCode = linked.data.accountCode;

    expect(isSql(accountCode)).toBe(true);
    if (!isSql(accountCode)) throw new Error("expected lowered SQL value");
    expect(accountCode.values).toEqual(["account-code"]);
    expect(linked.polymorphicStorage).toEqual([]);
    expect(lowerEmptyMembership(binding)).toEqual({
      data: { accountCode: { set: null } },
      polymorphicStorage: [],
    });
    expect(membershipProjection(noteScope, binding)).toEqual({
      fields: ["accountCode"],
      additionalColumns: [],
    });
    expect(resolveMembershipReferencedPremise(binding, {}, "create")).toEqual({
      code: "account-code",
    });
  });
});

describe("polymorphic relation membership lowering", () => {
  test("uses one exact type-and-id predicate across planning and final phases", () => {
    const queryEngine = engine();
    const { relation } = polymorphicBinding(queryEngine);
    const cardScope = createQueryScope(queryEngine, schema.card);
    const binding = bindCorrelatedRelationMembership(
      relation,
      { kind: "literal", value: 7 },
      literalParentId(7)
    );
    const planning = planningMembershipCondition(
      queryEngine,
      cardScope,
      binding,
      "card"
    );
    const final = finalMembershipCondition(
      queryEngine,
      cardScope,
      binding,
      "card",
      {},
      "update"
    );

    expect(planning.filters).toEqual([]);
    expect(planning.predicate?.values).toEqual(final.predicate?.values);
    expect(final.predicate?.values).toContain("membership.article.v1");
    expect(final.predicate?.values).toContain(7);
    const { typeColumn, idColumn } = relation.membership.storage;
    expect(
      recordHasMembership(
        binding,
        {
          [typeColumn.name]: relation.membership.storedType,
          [idColumn.name]: 7n,
        },
        {},
        "update"
      )
    ).toBe(true);
    expect(
      recordHasMembership(
        binding,
        { [typeColumn.name]: "another.variant", [idColumn.name]: 7 },
        {},
        "update"
      )
    ).toBe(false);
  });

  test("projects and lowers the private storage pair atomically", () => {
    const queryEngine = engine();
    const { relation } = polymorphicBinding(queryEngine);
    const cardScope = createQueryScope(queryEngine, schema.card);
    const binding = bindRelationMembership(relation, literalParentId(11));
    const projection = membershipProjection(cardScope, binding);
    const linked = lowerMembershipWrite(
      queryEngine,
      cardScope,
      binding,
      undefined,
      "create"
    );

    expect(projection.fields).toEqual([]);
    expect(projection.additionalColumns).toHaveLength(2);
    expect(linked.data).toEqual({});
    expect(linked.polymorphicStorage).toHaveLength(1);
    expect(linked.polymorphicStorage[0]?.kind).toBe("linked");
    expect(lowerEmptyMembership(binding).polymorphicStorage[0]?.kind).toBe(
      "empty"
    );

    const data: Record<string, unknown> = {};
    const storage: PolymorphicStorageValue<unknown>[] = [];
    const assignment = {
      kind: "polymorphic",
      storage: linkedPolymorphicStorage(
        relation.membership,
        literalParentId(12)
      ),
    } satisfies RootMembershipAssignment;
    applyRootMembershipAssignment(
      queryEngine,
      assignment,
      undefined,
      "create",
      data,
      storage
    );
    expect(data).toEqual({});
    expect(storage).toHaveLength(1);
  });
});

describe("coverage low value", () => {
  test("small source and pairing helpers preserve their discriminants", () => {
    const literal = literalParentId("value");
    const planned = plannedParentId("capture");
    const continuity = selectedRowContinuity("capture", (before) => before);
    expect(literalReferenceValue(literal)).toBe("value");
    expect(literalReferenceValue(planned)).toBeUndefined();
    expect(literalReferenceSource(literal)).toEqual({ value: "value" });
    expect(literalReferenceSource(planned)).toBeUndefined();
    expect(isPlanningFieldSource(planned)).toBe(true);
    expect(isPlanningFieldSource(literal)).toBe(false);
    expect(planningSourceFromFinal(literal, "notes", "update")).toBe(literal);
    expect(planningSourceFromFinal(planned, "notes", "update")).toEqual({
      kind: "planningField",
      step: "capture",
    });
    expect(planningSourceFromFinal(continuity, "notes", "update")).toEqual({
      kind: "planningField",
      step: "capture",
    });
    expect(() =>
      planningSourceFromFinal(
        { kind: "finalRef", ref: ref("write", "id") },
        "notes",
        "update"
      )
    ).toThrow(QueryEngineError);
  });

  test("pairing and final-reference lowering keep member order", () => {
    const pairs = [
      { foreignField: "tenantId", referencedField: "tenantId" },
      { foreignField: "accountId", referencedField: "id" },
    ];
    const write = [literalParentId("tenant-1"), literalParentId("account-1")];
    const read: PlanningReferenceSource[] = [
      { kind: "literal", value: "tenant-1" },
      { kind: "literal", value: "account-1" },
    ];
    expect(
      pairForeignKeyMembers(pairs, write).map((member) => member.foreignField)
    ).toEqual(["tenantId", "accountId"]);
    expect(
      pairCorrelatedForeignKeyMembers(pairs, read, write).map(
        (member) => member.readSource
      )
    ).toEqual(read);
    expect(
      foreignKeyWriteValueWith(
        {
          foreignField: "accountId",
          referencedField: "id",
          writeSource: { kind: "finalRef", ref: ref("write", "id") },
        },
        undefined,
        "notes",
        "create",
        (reference) => `${reference.step}.${reference.output}`
      )
    ).toBe("write.id");
  });

  test("foreign-key equality accepts provider integer width without coercing text", () => {
    expect(fkEquals(1, 1n)).toBe(true);
    expect(fkEquals(1, 2n)).toBe(false);
    expect(fkEquals("1", 1)).toBe(false);
    expect(fkEquals(undefined, undefined)).toBe(true);
  });

  test("a foreign root assignment writes only the record sink", () => {
    const data: Record<string, unknown> = {};
    const storage: PolymorphicStorageValue<unknown>[] = [];
    const assignment = {
      kind: "foreignKey",
      data: { accountCode: "account-code" },
    } satisfies RootMembershipAssignment;
    applyRootMembershipAssignment(
      engine(),
      assignment,
      undefined,
      "create",
      data,
      storage
    );
    expect(data).toEqual({ accountCode: "account-code" });
    expect(storage).toEqual([]);
  });
});
