import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  type BuildNestedSelection,
  buildLateralInclude,
  buildSubqueryInclude,
} from "@query-engine/builders/include-builder";
import {
  buildJunctionDeleteCondition,
  buildJunctionInsertWhenTargetExists,
  buildJunctionReferencedValuesMatch,
  buildJunctionReferencedValuesSetMatch,
  buildJunctionSourceMatch,
  buildJunctionTargetSubqueriesMatch,
  buildJunctionTargetValuesMatch,
} from "@query-engine/builders/many-to-many-utils";
import {
  buildPolymorphicCollectionCount,
  buildPolymorphicCollectionFilterSql,
} from "@query-engine/builders/polymorphic-collection-filter-builder";
import { buildPolymorphicCollectionRead } from "@query-engine/builders/polymorphic-collection-read-builder";
import { buildPolymorphicMemberOrphanProbe } from "@query-engine/builders/polymorphic-member-join-parts";
import {
  type PolymorphicStorageValue,
  polymorphicStorageMembers,
} from "@query-engine/builders/polymorphic-mutation";
import {
  buildPolymorphicFilterSql,
  buildPolymorphicRead,
} from "@query-engine/builders/polymorphic-read-builder";
import { buildRelationCount } from "@query-engine/builders/relation-count-builder";
import {
  type BoundJunctionMembership,
  bindRelation,
  getRequiredPrimaryKeyFields,
  type JunctionBoundRelation,
  polymorphicMemberMembership,
} from "@query-engine/builders/relation-data-builder";
import {
  buildParsedRelationPrograms,
  buildPolymorphicMutationProgram,
  buildRelationMutationProgram,
  polymorphicCollectionArms,
  type RelationMutationEntry,
} from "@query-engine/builders/relation-mutation-parser";
import { buildPolymorphicRelationOrders } from "@query-engine/builders/relation-orderby-builder";
import {
  classifyToOneComposition,
  requireToOneConnectTarget,
} from "@query-engine/builders/to-one-composition";
import { lookupRelation, variantCarrier } from "@query-engine/context";
import {
  isVariantRowCarrier,
  type QueryScope,
  type VariantJunctionCarrierSlot,
} from "@query-engine/types";
import { s } from "@schema";
import { type Sql, sql } from "@sql";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const ordinarySchema = (() => {
  const user = s.model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string().nullable(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  });
  return { user, post };
})();

const junctionSchema = (() => {
  const owner = s.model({
    id: s.string().id(),
    tags: s
      .toMany(() => tag)
      .through("query_relation_coverage_tags")
      .source("owner")
      .target("tag"),
  });
  const tag = s.model({
    id: s.string().id(),
    owners: s.toMany(() => owner),
  });
  return { owner, tag };
})();

const polymorphicSchema = (() => {
  const article = s.model({ id: s.string().id(), title: s.string() });
  const clip = s.model({ id: s.string().id(), duration: s.int() });
  const reaction = s.model({
    id: s.string().id(),
    subject: s
      .toOne(
        { article: () => article, clip: () => clip },
        {
          values: {
            article: "coverage.article",
            clip: "coverage.clip",
          },
        }
      )
      .optional(),
  });
  const gallery = s.model({
    id: s.string().id(),
    items: s.toMany(
      { article: () => article, clip: () => clip },
      {
        values: {
          article: "coverage.collection.article",
          clip: "coverage.collection.clip",
        },
      }
    ),
  });
  return { article, clip, reaction, gallery };
})();

prepareSchema(ordinarySchema);
prepareSchema(junctionSchema);
prepareSchema(polymorphicSchema);

function requiredRelation(ctx: QueryScope, field: string) {
  const relation = lookupRelation(ctx, field);
  if (!relation) throw new Error(`Expected relation '${field}'.`);
  return relation;
}

function requiredJunction(): {
  readonly scope: QueryScope;
  readonly relation: JunctionBoundRelation;
} {
  const scope = scopeFor(new PostgresAdapter(), junctionSchema.owner);
  const relation = bindRelation(scope, requiredRelation(scope, "tags"));
  if (relation.position !== "junction") {
    throw new Error("Expected a junction relation.");
  }
  return { scope, relation };
}

function collectionCarrier(): {
  readonly scope: QueryScope;
  readonly carrier: VariantJunctionCarrierSlot;
} {
  const scope = scopeFor(new PostgresAdapter(), polymorphicSchema.gallery);
  const carrier = variantCarrier(scope, "items");
  if (!carrier || isVariantRowCarrier(carrier)) {
    throw new Error("Expected a polymorphic collection carrier.");
  }
  return { scope, carrier };
}

function rowCarrier() {
  const scope = scopeFor(new PostgresAdapter(), polymorphicSchema.reaction);
  const carrier = variantCarrier(scope, "subject");
  if (!(carrier && isVariantRowCarrier(carrier))) {
    throw new Error("Expected a row-held polymorphic carrier.");
  }
  return { scope, carrier };
}

const nestedSelection: BuildNestedSelection = () => ({
  sql: sql`${"nested"}`,
  lateralJoins: [],
});

describe("relation read boundaries", () => {
  test("keeps filtered to-one predicates in both include strategies", () => {
    const subqueryScope = scopeFor(new PostgresAdapter(), ordinarySchema.post);
    const subqueryRelation = requiredRelation(subqueryScope, "author");
    const subquery = buildSubqueryInclude(
      nestedSelection,
      subqueryScope,
      subqueryRelation,
      { where: { name: { equals: "Ada" } } }
    );

    const lateralScope = scopeFor(new PostgresAdapter(), ordinarySchema.post);
    const lateralRelation = requiredRelation(lateralScope, "author");
    const lateral = buildLateralInclude(
      nestedSelection,
      lateralScope,
      lateralRelation,
      { where: { name: { equals: "Grace" } } }
    );

    expect(subquery.column.values).toContain("Ada");
    expect(lateral.lateralJoin?.values).toContain("Grace");
  });

  test("keeps direct polymorphic type, isNot, and empty nested predicates distinct", () => {
    const { scope, carrier } = rowCarrier();
    const typeOnly = buildPolymorphicFilterSql(
      () => undefined,
      scope,
      carrier,
      { type: "article" },
      scope.rootAlias
    );
    const isNot = buildPolymorphicFilterSql(
      (childScope) => childScope.adapter.operators.eq(sql`1`, sql`1`),
      scope,
      carrier,
      { type: "article", isNot: { title: "draft" } },
      scope.rootAlias
    );
    const emptyNested = buildPolymorphicFilterSql(
      () => undefined,
      scope,
      carrier,
      { type: "clip", is: { duration: undefined } },
      scope.rootAlias
    );

    expect(typeOnly.values).toContain("coverage.article");
    expect(isNot.toStatement("$n")).toContain("NOT EXISTS");
    expect(emptyNested.toStatement("$n")).toContain("EXISTS");
  });

  test("passes member select and include objects to direct polymorphic projections", () => {
    const { scope, carrier } = rowCarrier();
    const calls: Array<{
      readonly select: Record<string, unknown> | undefined;
      readonly include: Record<string, unknown> | undefined;
    }> = [];

    buildPolymorphicRead(
      (_childScope, select, include) => {
        calls.push({ select, include });
        return nestedSelection(_childScope, select, include);
      },
      scope,
      carrier,
      {
        article: {
          select: { title: true },
          include: { comments: true },
        },
      },
      scope.rootAlias
    );

    expect(calls).toEqual([
      {
        select: { title: true },
        include: { comments: true },
      },
      { select: undefined, include: undefined },
    ]);
  });

  test("preserves collection arm include options and predicate-free nested filters", () => {
    const { scope, carrier } = collectionCarrier();
    const calls: Array<{
      readonly select: Record<string, unknown> | undefined;
      readonly include: Record<string, unknown> | undefined;
    }> = [];
    const projection = buildPolymorphicCollectionRead(
      (_childScope, select, include) => {
        calls.push({ select, include });
        return nestedSelection(_childScope, select, include);
      },
      scope,
      carrier,
      {
        only: ["article"],
        variants: { article: { include: { comments: true } } },
      },
      scope.rootAlias
    );
    const filter = buildPolymorphicCollectionFilterSql(
      () => undefined,
      scope,
      carrier,
      { some: { type: "article", is: { title: undefined } } },
      scope.rootAlias
    );

    expect(calls).toEqual([{ select: undefined, include: { comments: true } }]);
    expect(projection.toStatement("$n")).toContain("SELECT");
    expect(filter.toStatement("$n")).toContain("EXISTS");
  });
});

describe("relation mutation boundaries", () => {
  test("keeps repeated row-carrier storage assignments in declaration order", () => {
    const { scope, carrier } = rowCarrier();
    const member = carrier.edge.members[0];
    if (!member) throw new Error("Expected one row-carrier member.");
    const first: PolymorphicStorageValue<string> = {
      kind: "linked",
      carrier: carrier.slot,
      storage: carrier.edge.storage,
      storedType: member.entry.storedValue,
      referencedField: member.referencedField,
      id: "article-1",
    };
    const second: PolymorphicStorageValue<string> = {
      ...first,
      id: "article-2",
    };

    expect(
      polymorphicStorageMembers(scope, [first, second]).map(
        ({ column, value }) => [column.name, value]
      )
    ).toEqual([
      [carrier.edge.storage.typeColumn.name, member.entry.storedValue],
      [carrier.edge.storage.idColumn.name, "article-1"],
      [carrier.edge.storage.typeColumn.name, member.entry.storedValue],
      [carrier.edge.storage.idColumn.name, "article-2"],
    ]);
  });

  test("lowers collection updateMany without inventing an omitted where clause", () => {
    const { scope, carrier } = collectionCarrier();
    const arm = buildPolymorphicMutationProgram(scope, carrier, {
      updateMany: {
        type: "article",
        data: { title: { set: "published" } },
      },
    });

    expect(arm.kind).toBe("polymorphicCollection");
    if (arm.kind !== "polymorphicCollection") return;
    expect(arm.entries[0]?.program.entries[0]).toMatchObject({
      kind: "updateMany",
      items: [{ data: { parsed: { title: { set: "published" } } } }],
    });
  });

  test("keeps the collection arm visible to its dedicated relation walk", () => {
    const { scope } = collectionCarrier();
    const parsed = buildParsedRelationPrograms(scope, {
      items: {
        connect: { type: "article", where: { id: "article-1" } },
      },
    });

    expect(polymorphicCollectionArms(parsed.relations)).toHaveLength(1);
  });

  test("declines a to-one composition that has no supplier", () => {
    const disconnect: RelationMutationEntry = {
      kind: "disconnect",
      target: { kind: "current" },
    };
    const update: RelationMutationEntry = {
      kind: "update",
      items: [],
    };

    expect(
      classifyToOneComposition("author", [disconnect, update])
    ).toBeUndefined();
  });
});

describe("junction scalar boundaries", () => {
  test("uses the scalar junction fast path in both endpoint orientations", () => {
    const { scope, relation } = requiredJunction();
    const target = [sql`${"tag-1"}`];
    const selfOriented: JunctionBoundRelation = {
      ...relation,
      membership: {
        ...relation.membership,
        target: { ...relation.membership.target, model: scope.model },
      },
    };

    expect(
      buildJunctionTargetValuesMatch(scope, relation, [target]).toStatement(
        "$n"
      )
    ).toContain(" IN ");
    expect(
      buildJunctionDeleteCondition(scope, selfOriented, [target]).values
    ).toEqual(["tag-1", "tag-1"]);
  });
});

describe("coverage low value", () => {
  test("refuses malformed post-validation relation count and collection order state", () => {
    const ordinaryScope = scopeFor(new PostgresAdapter(), ordinarySchema.user);
    const posts = requiredRelation(ordinaryScope, "posts");
    expect(() =>
      buildRelationCount(
        ordinaryScope,
        posts,
        { where: 42 },
        ordinaryScope.rootAlias
      )
    ).toThrow("Relation count where clause must be an object");

    const { scope, carrier } = collectionCarrier();
    for (const [value, message] of [
      [42, "must be an object"],
      [{}, "requires _count"],
      [{ title: "asc" }, "is not supported"],
      [{ _count: "sideways" }, "must be 'asc' or 'desc'"],
    ] as const) {
      expect(() =>
        buildPolymorphicRelationOrders(scope, carrier, value, scope.rootAlias)
      ).toThrow(message);
    }
  });

  test("refuses corrupted junction tuple and arity state", () => {
    const { scope, relation } = requiredJunction();
    const missing = [undefined] as unknown as readonly Sql[];
    const target = [sql`${"tag-1"}`];
    const emptySource: JunctionBoundRelation = {
      ...relation,
      membership: {
        ...relation.membership,
        source: { ...relation.membership.source, members: [] },
      },
    };

    expect(() =>
      buildJunctionInsertWhenTargetExists(scope, emptySource, [], target)
    ).toThrow("Junction source has no stored-reference member");
    expect(() =>
      buildJunctionInsertWhenTargetExists(scope, relation, [], target)
    ).toThrow("value count does not match");
    expect(() =>
      buildJunctionTargetValuesMatch(scope, relation, [missing])
    ).toThrow("Junction target has no scalar value");
    expect(() =>
      buildJunctionTargetSubqueriesMatch(scope, relation, missing)
    ).toThrow("Junction target has no scalar subquery");
    expect(() =>
      buildJunctionReferencedValuesMatch(
        scope,
        relation.membership.target,
        missing,
        "target"
      )
    ).toThrow("incomplete value tuple");
    expect(() =>
      buildJunctionReferencedValuesSetMatch(
        scope,
        relation.membership.target,
        [missing],
        "target"
      )
    ).toThrow("Junction target has no scalar value");
    expect(() => buildJunctionSourceMatch(scope, relation, missing)).toThrow(
      "incomplete value tuple"
    );
  });

  test("refuses empty polymorphic carrier topology", () => {
    const { scope, carrier } = collectionCarrier();
    const emptyCarrier: VariantJunctionCarrierSlot = {
      ...carrier,
      edge: {
        ...carrier.edge,
        // Deliberately below the floor the TYPE states: L5 resolves a variant
        // junction edge as a NON-EMPTY tuple
        // (`ResolvedRelationEdge`, src/schema/validation/relation-resolution.ts),
        // so this topology is unconstructible through the schema. The engine
        // still refuses it rather than seeding a fold from nothing, and this
        // is the only way to reach that refusal.
        // @ts-expect-error - an empty member tuple is what is under test
        members: [],
      },
    };
    expect(() =>
      buildPolymorphicCollectionCount(
        () => undefined,
        scope,
        emptyCarrier,
        true,
        scope.rootAlias
      )
    ).toThrow("has no configured variants to count");

    const member = carrier.edge.members[0];
    if (!member) throw new Error("Expected one collection member.");
    const membership = polymorphicMemberMembership(member.topology, "owner");
    const emptyTarget: BoundJunctionMembership = {
      ...membership,
      target: { ...membership.target, members: [] },
    };
    expect(() =>
      buildPolymorphicMemberOrphanProbe(scope, emptyTarget, "target")
    ).toThrow("has no stored target reference");
  });

  test("refuses lost source provenance and to-many-only verbs on a to-one relation", () => {
    const userScope = scopeFor(new PostgresAdapter(), ordinarySchema.user);
    const posts = requiredRelation(userScope, "posts");
    expect(() =>
      buildRelationMutationProgram(
        posts,
        {
          update: [
            { where: { id: "post-1" }, data: { title: { set: "one" } } },
            { where: { id: "post-2" }, data: { title: { set: "two" } } },
          ],
        },
        {
          update: [
            {
              where: { id: "post-1" },
              data: { title: { set: "source" } },
            },
          ],
        }
      )
    ).toThrow("lost source item 1");

    const postScope = scopeFor(new PostgresAdapter(), ordinarySchema.post);
    const author = requiredRelation(postScope, "author");
    expect(() =>
      buildRelationMutationProgram(author, {
        updateMany: { data: { name: { set: "Ada" } } },
      })
    ).toThrow("is not supported for to-one relation 'author'");
    expect(buildRelationMutationProgram(posts, 42)).toBeUndefined();
  });

  test("drops unavailable source envelopes after polymorphic payload validation", () => {
    const { scope, carrier } = rowCarrier();
    for (const source of [undefined, { create: 42 }]) {
      const arm = buildPolymorphicMutationProgram(
        scope,
        carrier,
        {
          create: {
            type: "article",
            data: { id: "article-1", title: "Published" },
          },
        },
        source
      );
      if (arm.kind !== "polymorphicTarget") {
        throw new Error("Expected a targeted polymorphic mutation.");
      }
      expect(arm.program.entries[0]).toMatchObject({
        kind: "create",
        items: [{ source: undefined }],
      });
    }
  });

  test("refuses an empty to-one connect target and ignores missing carrier registries", () => {
    const emptyConnect: Extract<RelationMutationEntry, { kind: "connect" }> = {
      kind: "connect",
      targets: [],
    };
    expect(() => requireToOneConnectTarget(emptyConnect, "author")).toThrow(
      "has no target"
    );

    const { scope, carrier } = rowCarrier();
    const member = carrier.edge.members[0];
    if (!member) throw new Error("Expected one row-carrier member.");
    const linked: PolymorphicStorageValue<string> = {
      kind: "linked",
      carrier: carrier.slot,
      storage: carrier.edge.storage,
      storedType: member.entry.storedValue,
      referencedField: member.referencedField,
      id: "article-1",
    };
    const missingRegistry: QueryScope = { ...scope, relations: new Map() };
    expect(polymorphicStorageMembers(missingRegistry, [linked])).toEqual([]);
  });

  test("uses mapped and anonymous model names in keyless junction diagnostics", () => {
    const mapped = s.model({ value: s.string() }).map("coverage_keyless");
    const anonymous = s.model({ value: s.string() });

    expect(() => getRequiredPrimaryKeyFields(mapped)).toThrow(
      'Model "coverage_keyless" has no primary key'
    );
    expect(() => getRequiredPrimaryKeyFields(anonymous)).toThrow(
      'Model "unknown" has no primary key'
    );
  });
});
