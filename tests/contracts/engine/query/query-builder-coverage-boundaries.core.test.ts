import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  buildAggregateColumn,
  buildCountAggregate,
} from "@query-engine/builders/aggregate-utils";
import {
  buildDistanceExpression,
  buildPointDistancePredicate,
} from "@query-engine/builders/distance-builder";
import { requireGeoPointSql } from "@query-engine/builders/geo-point-builder";
import {
  buildJunctionDeleteCondition,
  buildJunctionInsertMany,
  buildJunctionInsertWhenTargetExists,
  buildJunctionMembership,
  buildJunctionReferencedValuesSetMatch,
  buildJunctionTargetSubqueriesMatch,
  buildJunctionTargetValuesMatch,
} from "@query-engine/builders/many-to-many-utils";
import { buildOrderByParts } from "@query-engine/builders/orderby-builder";
import { buildPolymorphicCollectionCount } from "@query-engine/builders/polymorphic-collection-filter-builder";
import {
  bindMemberJunction,
  bindRelation,
  buildConnectSubqueryForField,
  buildPolymorphicMembership,
  getRequiredPrimaryKeyFields,
  type JunctionBoundRelation,
  membershipReferencedFields,
  polymorphicMemberMembership,
} from "@query-engine/builders/relation-data-builder";
import { buildParsedRelationPrograms } from "@query-engine/builders/relation-mutation-parser";
import {
  buildInclude,
  buildSelect,
  buildSelectWithAliases,
} from "@query-engine/builders/select-builder";
import { buildSet } from "@query-engine/builders/set-builder";
import { buildSingleOrder } from "@query-engine/builders/sort-order-builder";
import {
  buildValueGroupsWithRowStorage,
  buildValues,
  decimalListMember,
  scalarValueLiteral,
} from "@query-engine/builders/values-builder";
import { buildWhere } from "@query-engine/builders/where-builder";
import {
  buildWhereUnique,
  partitionWhereUnique,
} from "@query-engine/builders/where-unique-builder";
import {
  lookupRelation,
  memberRef,
  variantCarrier,
} from "@query-engine/context";
import { isVariantRowCarrier, type QueryScope } from "@query-engine/types";
import { s } from "@schema";
import { createModelFieldRefs } from "@schema/field-ref";
import { sql } from "@sql";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const POINT_SQL_PATTERN = /ST_|point/i;
const VECTOR_REFUSAL_PATTERN =
  /requires an object|finite numbers|metric|dimension mismatch/;
const POLYMORPHIC_FILTER_REFUSAL_PATTERN =
  /must be an object|requires one of|requires an object|Unknown polymorphic target/;

const record = s
  .model({
    id: s.string().id(),
    tenant: s.string(),
    slug: s.string(),
    title: s.string(),
    rank: s.int().nullable(),
    amount: s.decimal({ precision: 12, scale: 2 }),
    amounts: s.decimal({ precision: 12, scale: 2 }).array(),
    labels: s.string().array(),
    payload: s.json().nullable(),
    location: s.point(),
    embedding: s.vector().dimension(3),
    secondaryEmbedding: s.vector().dimension(3),
  })
  .unique(["tenant", "slug"], { name: "tenantSlug" })
  .map("builder_records");

const keyless = s.model({ label: s.string() }).map("builder_keyless");

const relationSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map("builder_users");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("builder_posts");
  return { user, post };
})();

const junctionSchema = (() => {
  const owner = s
    .model({
      tenant: s.string(),
      code: s.string(),
      targets: s
        .toMany(() => target)
        .through("builder_compound_membership")
        .source("owner")
        .target("target"),
    })
    .id(["tenant", "code"]);
  const target = s
    .model({
      region: s.string(),
      serial: s.int(),
      owners: s.toMany(() => owner),
    })
    .id(["region", "serial"]);
  return { owner, target };
})();

const polymorphicSchema = (() => {
  const article = s.model({ id: s.string().id(), title: s.string() });
  const clip = s.model({ id: s.string().id(), duration: s.int() });
  const reaction = s.model({
    id: s.string().id(),
    subject: s.toOne({ article: () => article, clip: () => clip }).optional(),
  });
  const gallery = s.model({
    id: s.string().id(),
    items: s.toMany({ article: () => article, clip: () => clip }),
  });
  return { article, clip, reaction, gallery };
})();

const distanceConflict = s.model({
  id: s.string().id(),
  _distance: s.number(),
  location: s.point(),
});

prepareSchema({ record, keyless });
prepareSchema(relationSchema);
prepareSchema(junctionSchema);
prepareSchema(polymorphicSchema);
prepareSchema({ distanceConflict });

function requiredRelation(ctx: QueryScope, field: string) {
  const relation = lookupRelation(ctx, field);
  if (!relation) throw new Error(`Expected relation '${field}'.`);
  return relation;
}

function requiredJunction(): {
  scope: QueryScope;
  relation: JunctionBoundRelation;
} {
  const scope = scopeFor(new PostgresAdapter(), junctionSchema.owner);
  const bound = bindRelation(scope, requiredRelation(scope, "targets"));
  if (bound.position !== "junction") {
    throw new Error("Expected a junction relation.");
  }
  return { scope, relation: bound };
}

function vectorCapableAdapter(): PostgresAdapter {
  const adapter = new PostgresAdapter("public", true);
  adapter.capabilities.supportsVector = true;
  adapter.vector = {
    literal: () => sql.raw`VECTOR_LITERAL`,
    l2: () => sql.raw`L2_DISTANCE`,
    cosine: () => sql.raw`COSINE_DISTANCE`,
  };
  return adapter;
}

describe("aggregate, unique-selector, and value builder contracts", () => {
  test("keeps count routing distinct from non-count aggregate configuration", () => {
    const scope = scopeFor(new PostgresAdapter(), record);

    expect(
      buildAggregateColumn(scope, true, scope.rootAlias, "count")?.toStatement(
        "$n"
      )
    ).toContain("COUNT(*)");
    expect(
      buildAggregateColumn(scope, true, scope.rootAlias, "sum")
    ).toBeUndefined();
    expect(
      buildCountAggregate(scope, { id: false }, scope.rootAlias)
    ).toBeUndefined();
    expect(
      buildCountAggregate(scope, { _all: true, id: true }, scope.rootAlias)
        ?.values
    ).toEqual(["_all", "id"]);
  });

  test("partitions a compound discriminator from extended filters", () => {
    const scope = scopeFor(new PostgresAdapter(), record);
    const where = {
      tenantSlug: { tenant: "tenant-1", slug: "entry-1" },
      title: { contains: "needle" },
      ignored: undefined,
    };
    const partition = partitionWhereUnique(scope, where);

    expect(partition.entries).toEqual([
      { fieldName: "tenant", value: "tenant-1" },
      { fieldName: "slug", value: "entry-1" },
    ]);
    expect(partition.discriminator).toEqual({
      tenantSlug: where.tenantSlug,
    });
    expect(partition.filters).toEqual({ title: where.title });
    const built = buildWhereUnique(scope, where, scope.rootAlias);
    expect(built.values).toEqual(["tenant-1", "entry-1", "needle"]);
  });

  test("keeps empty inserts empty and groups rows by contiguous physical shape", () => {
    const scope = scopeFor(new PostgresAdapter(), record);

    expect(buildValues(scope, [])).toEqual({ columns: [], values: [] });
    expect(
      buildValueGroupsWithRowStorage(
        scope,
        [
          { id: "a", tenant: "t", slug: "a", title: "A" },
          { id: "b", tenant: "t", slug: "b", title: "B" },
          { id: "c", tenant: "t", slug: "c", title: "C", rank: 3 },
        ],
        [[], [], []]
      ).map(({ columns, inputIndexes }) => ({ columns, inputIndexes }))
    ).toEqual([
      {
        columns: ["id", "tenant", "slug", "title"],
        inputIndexes: [0, 1],
      },
      {
        columns: ["id", "tenant", "slug", "title", "rank"],
        inputIndexes: [2],
      },
    ]);
  });

  test("uses the native decimal-list member vocabulary on PostgreSQL", () => {
    const adapter = new PostgresAdapter();
    const scope = scopeFor(adapter, record);
    const descriptor = { precision: 12, scale: 2 };

    expect(
      decimalListMember(adapter, "amounts", "1.20", descriptor).values
    ).toEqual(["1.2"]);
    expect(scalarValueLiteral(scope, "amounts", "1.20").values).toEqual([
      "1.2",
    ]);
  });
});

describe("where, order, and selection builder contracts", () => {
  test("compiles the remaining portable scalar, list, JSON, and point predicates", () => {
    const scope = scopeFor(new PostgresAdapter("public", true), record);
    expect(
      buildWhere(scope, { title: undefined }, scope.rootAlias)
    ).toBeUndefined();

    const insensitiveMembership = buildWhere(
      scope,
      {
        title: { in: ["Alpha", "Beta"], mode: "insensitive" },
        labels: { isEmpty: false },
        payload: { not: null },
        rank: { equals: null },
      },
      scope.rootAlias
    );
    expect(insensitiveMembership?.toStatement("$n")).toContain("IS NOT NULL");
    expect(insensitiveMembership?.values).toEqual(["Alpha", "Beta"]);

    const insensitiveExclusion = buildWhere(
      scope,
      { title: { notIn: ["Alpha", "Beta"], mode: "insensitive" } },
      scope.rootAlias
    );
    expect(insensitiveExclusion?.values).toEqual(["Alpha", "Beta"]);

    expect(
      buildWhere(scope, { labels: { has: null } }, scope.rootAlias)?.values
    ).toEqual([]);

    const distance = buildWhere(
      scope,
      {
        location: {
          distance: {
            to: { longitude: 2.35, latitude: 48.86 },
            lt: 100,
            lte: 50,
            gt: 1,
            gte: 2,
          },
        },
      },
      scope.rootAlias
    );
    expect(distance?.values).toContain(50);

    const polygon = buildWhere(
      scope,
      {
        location: {
          within: {
            polygon: {
              outer: [
                { longitude: 0, latitude: 0 },
                { longitude: 1, latitude: 0 },
                { longitude: 1, latitude: 1 },
                { longitude: 0, latitude: 0 },
              ],
            },
          },
        },
      },
      scope.rootAlias
    );
    expect(polygon?.toStatement("$n")).toMatch(POINT_SQL_PATTERN);
  });

  test("keeps JSON comparison classes, nested mode, and list emptiness explicit", () => {
    const scope = scopeFor(new PostgresAdapter("public", true), record);
    const condition = buildWhere(
      scope,
      {
        payload: {
          path: ["profile", "name"],
          not: "blocked",
          string_starts_with: "A",
        },
        labels: { isEmpty: true },
      },
      scope.rootAlias
    );
    const nestedMode = buildWhere(
      scope,
      {
        payload: {
          mode: "insensitive",
          not: { string_contains: "private" },
        },
      },
      scope.rootAlias
    );
    const numeric = buildWhere(
      scope,
      { payload: { path: ["score"], gte: 10 } },
      scope.rootAlias
    );
    const document = buildWhere(
      scope,
      { payload: { equals: { stable: true } } },
      scope.rootAlias
    );
    const governedMode = buildWhere(
      scope,
      { payload: { mode: "insensitive", string_contains: "needle" } },
      scope.rootAlias
    );

    expect(condition?.values).toContain("A");
    expect(condition?.toStatement("$n")).toContain("<>");
    expect(nestedMode?.values).toContain("private");
    expect(numeric?.values).toContain(10);
    expect(document?.values[0]).toMatchObject({ json: '{"stable":true}' });
    expect(document?.toStatement("$n")).toContain('"payload" = $1');
    expect(governedMode?.values).toContain("needle");
  });

  test("preserves scalar operand identity across logical and insensitive filters", () => {
    const scope = scopeFor(new PostgresAdapter("public", true), record);
    const fields = createModelFieldRefs("record", record);
    const condition = buildWhere(
      scope,
      {
        AND: { title: { contains: "visible" } },
        title: {
          mode: "insensitive",
          equals: fields.title,
          not: sql`${"archived"}`,
        },
      },
      scope.rootAlias
    );
    const nested = buildWhere(
      scope,
      {
        title: {
          not: { mode: "insensitive", contains: "private" },
        },
      },
      scope.rootAlias
    );

    expect(condition?.toStatement("$n")).toContain("TRANSLATE");
    expect(condition?.values).toEqual(
      expect.arrayContaining(["visible", "archived"])
    );
    expect(nested?.values).toContain("private");
  });

  test("spells scalar and distance ordering through their declared domains", () => {
    const scope = scopeFor(new PostgresAdapter("public", true), record);
    const rank = scope.adapter.identifiers.column(scope.rootAlias, "rank");
    const location = scope.adapter.identifiers.column(
      scope.rootAlias,
      "location"
    );
    const pointField = {
      name: "location",
      scalarState: { type: "point" },
    };

    expect(
      buildSingleOrder(scope, rank, { sort: "asc", nulls: "last" }).toStatement(
        "$n"
      )
    ).toContain("NULLS LAST");
    expect(
      buildSingleOrder(scope, rank, { sort: "desc" }).toStatement("$n")
    ).toContain("DESC");
    expect(
      buildSingleOrder(scope, rank, { sort: "asc" }).toStatement("$n")
    ).toContain("ASC");
    expect(
      buildSingleOrder(
        scope,
        location,
        { _distance: { to: { longitude: 2.35, latitude: 48.86 } } },
        pointField
      ).toStatement("$n")
    ).toContain("NULLS LAST");
    expect(
      buildSingleOrder(
        scope,
        location,
        {
          _distance: {
            to: { longitude: 2.35, latitude: 48.86 },
            sort: "desc",
          },
        },
        pointField
      ).toStatement("$n")
    ).toContain("DESC");

    const onlyLt = buildPointDistancePredicate(
      scope,
      location,
      { to: { longitude: 2.35, latitude: 48.86 }, lt: 100 },
      pointField,
      true
    );
    const onlyLte = buildPointDistancePredicate(
      scope,
      location,
      { to: { longitude: 2.35, latitude: 48.86 }, lte: 200 },
      pointField,
      true
    );
    expect(onlyLt.values).toContain(100);
    expect(onlyLte.values).toContain(200);
  });

  test("lowers every remaining update assignment without losing its column domain", () => {
    const scope = scopeFor(new PostgresAdapter(), record);
    const assignments = buildSet(
      scope,
      {
        title: { set: "next" },
        rank: { increment: 1 },
        amount: { divide: "2.00" },
        labels: { push: "one" },
      },
      "updated"
    );
    const prepend = buildSet(scope, {
      labels: { unshift: ["first", "second"] },
    });

    expect(assignments.toStatement("$n")).toContain('"updated"."title"');
    expect(assignments.values).toEqual(
      expect.arrayContaining(["next", 1, "2", ["one"]])
    );
    expect(prepend.values).toEqual([["first", "second"]]);
  });

  test("opens relation projections from a rebased parent alias", () => {
    const scope = scopeFor(new PostgresAdapter(), relationSchema.user);
    const posts = requiredRelation(scope, "posts");
    const include = buildInclude(scope, posts, {}, "parent_alias", {
      strategy: "subquery",
    });
    const counts = buildSelect(
      scope,
      { _count: { select: { posts: true } } },
      { _count: { select: { posts: true } } },
      scope.rootAlias
    );
    const skippedInclude = buildSelect(
      scope,
      undefined,
      { posts: false, missing: undefined },
      scope.rootAlias
    );

    expect(include.column.toStatement("$n")).toContain("parent_alias");
    expect(counts.toStatement("$n")).toContain("COUNT");
    expect(skippedInclude.toStatement("$n")).not.toContain("builder_posts");
  });

  test("reuses one relation traversal join across repeated order clauses", () => {
    const scope = scopeFor(new PostgresAdapter(), relationSchema.post);
    const parts = buildOrderByParts(
      scope,
      [{ author: { name: "asc" } }, { author: { id: "desc" } }],
      scope.rootAlias
    );

    expect(parts.joins).toHaveLength(1);
    expect(parts.orderBy?.toStatement("$n")).toContain("DESC");
    expect(
      buildOrderByParts(scope, { title: undefined }, scope.rootAlias)
    ).toEqual({ orderBy: undefined, joins: [] });
  });

  test("refuses ambiguous distance output names and duplicate distance projections", () => {
    const pointScope = scopeFor(
      new PostgresAdapter("public", true),
      distanceConflict
    );
    expect(() =>
      buildSelect(
        pointScope,
        {
          _distance: true,
          location: {
            _distance: { to: { longitude: 2.35, latitude: 48.86 } },
          },
        },
        undefined,
        pointScope.rootAlias
      )
    ).toThrow(
      "cannot be selected together with a model field named '_distance'"
    );

    const vectorScope = scopeFor(vectorCapableAdapter(), record);
    expect(() =>
      buildSelectWithAliases(
        vectorScope,
        {
          embedding: { _distance: { to: [1, 2, 3], metric: "l2" } },
          secondaryEmbedding: {
            _distance: { to: [3, 2, 1], metric: "cosine" },
          },
        },
        undefined,
        vectorScope.rootAlias
      )
    ).toThrow("Distance select supports only one _distance field per select");
  });
});

describe("relation topology and junction builder contracts", () => {
  test("requires a complete model identity for junction participation", () => {
    expect(() => getRequiredPrimaryKeyFields(keyless)).toThrow(
      "Many-to-many relations require a complete primary key"
    );
    expect(getRequiredPrimaryKeyFields(junctionSchema.owner)).toEqual([
      "tenant",
      "code",
    ]);
  });

  test("orients polymorphic member junctions from either traversal end", () => {
    const scope = scopeFor(new PostgresAdapter(), polymorphicSchema.gallery);
    const carrier = variantCarrier(scope, "items");
    if (!carrier || isVariantRowCarrier(carrier)) {
      throw new Error("Expected a polymorphic collection carrier.");
    }
    const member = carrier.edge.members[0];
    if (!member) throw new Error("Expected one collection member.");

    const owner = polymorphicMemberMembership(member.topology, "owner");
    const variant = polymorphicMemberMembership(member.topology, "variant");
    expect(owner.source).toEqual(variant.target);
    expect(owner.target).toEqual(variant.source);
    expect(
      bindMemberJunction(scope, memberRef(carrier, member), member, "owner")
        .membership
    ).toEqual(owner);
  });

  test("builds row-carrier membership from resolved storage facts", () => {
    const scope = scopeFor(new PostgresAdapter(), polymorphicSchema.reaction);
    const carrier = variantCarrier(scope, "subject");
    if (!(carrier && isVariantRowCarrier(carrier))) {
      throw new Error("Expected a polymorphic row carrier.");
    }
    const member = carrier.edge.members[0];
    if (!member) throw new Error("Expected one row-carrier member.");
    const membership = buildPolymorphicMembership(
      carrier.edge.carrier.source,
      member.targetModel,
      carrier.edge,
      member
    );

    expect(membershipReferencedFields(membership)).toEqual([
      member.referencedField,
    ]);
    expect(membership.storedType).toBe(member.entry.storedValue);
  });

  test("hides a self-target lookup behind a derived table on MySQL", () => {
    const root = scopeFor(new MySQLAdapter(), relationSchema.post);
    const ctx: QueryScope = { ...root, mutationTable: "builder_users" };
    const relation = requiredRelation(ctx, "author");
    const lookup = buildConnectSubqueryForField(
      ctx,
      relation,
      { id: "u1" },
      "id"
    );

    expect(lookup.toStatement("$n")).toContain("SELECT * FROM");
    expect(lookup.values).toEqual(["u1"]);
  });

  test("builds exact-membership insertion and compound tuple predicates", () => {
    const { scope, relation } = requiredJunction();
    const parentValues = [sql`${"tenant-1"}`, sql`${"owner-1"}`];
    const firstTarget = [sql`${"eu"}`, sql`${1}`];
    const secondTarget = [sql`${"us"}`, sql`${2}`];

    const exact = buildJunctionInsertWhenTargetExists(
      scope,
      relation,
      parentValues,
      firstTarget,
      "exactMembershipNoop"
    );
    expect(exact.toStatement("$n")).toContain("LEFT JOIN");

    const targetSet = buildJunctionTargetValuesMatch(
      scope,
      relation,
      [firstTarget, secondTarget],
      "membership"
    );
    expect(targetSet.toStatement("$n")).toContain(" OR ");

    const referencedSet = buildJunctionReferencedValuesSetMatch(
      scope,
      relation.membership.target,
      [firstTarget, secondTarget],
      "target"
    );
    expect(referencedSet.toStatement("$n")).toContain(" OR ");

    expect(
      buildJunctionTargetSubqueriesMatch(
        scope,
        relation,
        firstTarget
      ).toStatement("$n")
    ).toContain(" AND ");
    expect(
      buildJunctionMembership(
        scope,
        relation,
        parentValues,
        "target"
      ).toStatement("$n")
    ).toContain("EXISTS");
    expect(
      buildJunctionDeleteCondition(scope, relation, [firstTarget]).values
    ).toEqual(["eu", 1]);
  });

  test("clears both orientations of a self-referential junction", () => {
    const { scope, relation } = requiredJunction();
    const selfRelation: JunctionBoundRelation = {
      ...relation,
      sourceModel: scope.model,
      membership: {
        ...relation.membership,
        source: { ...relation.membership.source, model: scope.model },
        target: { ...relation.membership.target, model: scope.model },
      },
    };
    const target = [sql`${"eu"}`, sql`${1}`];

    expect(
      buildJunctionDeleteCondition(scope, selfRelation, [target]).values
    ).toEqual(["eu", 1, "eu", 1]);
  });
});

describe("polymorphic builder contracts", () => {
  test("lowers every direct row-carrier mutation family with source payloads", () => {
    const scope = scopeFor(new PostgresAdapter(), polymorphicSchema.reaction);
    const cases = [
      {
        parsed: { connect: { type: "article", where: { id: "a1" } } },
        source: { connect: { type: "article", where: { id: "source-a1" } } },
        kind: "connect",
      },
      {
        parsed: {
          connectOrCreate: {
            type: "article",
            where: { id: "a1" },
            create: { id: "a1", title: "parsed" },
          },
        },
        source: {
          connectOrCreate: {
            type: "article",
            where: { id: "a1" },
            create: { id: "a1", title: "source" },
          },
        },
        kind: "connectOrCreate",
      },
      {
        parsed: {
          update: {
            type: "article",
            where: { id: "a1" },
            data: { title: { set: "parsed" } },
          },
        },
        source: {
          update: {
            type: "article",
            where: { id: "a1" },
            data: { title: "source" },
          },
        },
        kind: "update",
      },
      {
        parsed: {
          upsert: {
            type: "article",
            create: { id: "a1", title: "parsed create" },
            update: { title: { set: "parsed update" } },
          },
        },
        source: {
          upsert: {
            type: "article",
            create: { id: "a1", title: "source create" },
            update: { title: "source update" },
          },
        },
        kind: "upsert",
      },
      {
        parsed: { delete: { type: "article" } },
        source: { delete: { type: "article" } },
        kind: "delete",
      },
    ];

    for (const entry of cases) {
      const parsed = buildParsedRelationPrograms(
        scope,
        { subject: entry.parsed },
        { subject: entry.source }
      );
      const mutation = parsed.relations[0];
      expect(mutation?.kind).toBe("polymorphicTarget");
      expect(
        mutation?.kind === "polymorphicTarget"
          ? mutation.program.entries[0]?.kind
          : undefined
      ).toBe(entry.kind);
    }
  });

  test("wraps a polymorphic collection filter that reads the active mutation target", () => {
    const root = scopeFor(new MySQLAdapter(), polymorphicSchema.gallery);
    const carrier = variantCarrier(root, "items");
    if (!carrier || isVariantRowCarrier(carrier)) {
      throw new Error("Expected a polymorphic collection carrier.");
    }
    const member = carrier.edge.members[0];
    if (!member) throw new Error("Expected one collection member.");
    const ctx: QueryScope = {
      ...root,
      mutationTable: member.topology.table,
    };

    const condition = buildWhere(
      ctx,
      {
        items: {
          some: {
            type: member.variant,
            is: { title: { equals: "x" } },
          },
        },
      },
      ctx.rootAlias
    );
    expect(condition?.toStatement("$n")).toContain("SELECT * FROM");
  });
});

describe("coverage low value", () => {
  test("rejects malformed post-validation unique and scalar builder state", () => {
    const scope = scopeFor(new PostgresAdapter(), record);

    expect(() =>
      partitionWhereUnique(scope, { tenantSlug: "not-an-object" })
    ).toThrow("must be an object");
    expect(() =>
      partitionWhereUnique(scope, {
        tenantSlug: { tenant: "t", slug: "s", extra: true },
      })
    ).toThrow("Unknown field 'extra'");
    expect(() =>
      partitionWhereUnique(scope, { tenantSlug: { tenant: "t" } })
    ).toThrow("requires 'slug'");
    expect(() => partitionWhereUnique(scope, { title: "not unique" })).toThrow(
      "requires at least one unique discriminator"
    );

    expect(() =>
      buildWhere(scope, { title: "not-normalized" }, scope.rootAlias)
    ).toThrow("must be a filter object");
    expect(() => buildWhere(scope, { title: {} }, scope.rootAlias)).toThrow(
      "must contain at least one operation"
    );
    for (const [operator, value] of [
      ["in", "not-an-array"],
      ["notIn", "not-an-array"],
      ["hasEvery", "not-an-array"],
      ["hasSome", "not-an-array"],
    ]) {
      expect(() =>
        buildWhere(
          scope,
          {
            [operator === "hasEvery" || operator === "hasSome"
              ? "labels"
              : "title"]: { [operator]: value },
          },
          scope.rootAlias
        )
      ).toThrow("requires an array value");
    }
  });

  test("rejects malformed post-validation distance state", () => {
    const postgres = scopeFor(vectorCapableAdapter(), record);
    const column = postgres.adapter.identifiers.column(
      postgres.rootAlias,
      "location"
    );

    expect(() =>
      buildDistanceExpression(
        postgres,
        column,
        {},
        { name: "title", scalarState: { type: "string" } },
        "select"
      )
    ).toThrow("requires a vector or GeoPoint scalar field");
    expect(() =>
      buildPointDistancePredicate(
        postgres,
        column,
        42,
        { name: "location", scalarState: { type: "point" } },
        true
      )
    ).toThrow("requires an object");
    expect(() =>
      buildPointDistancePredicate(
        postgres,
        column,
        { to: { longitude: 0, latitude: 0 } },
        { name: "location", scalarState: { type: "point" } },
        true
      )
    ).toThrow("requires a comparison");
    expect(() =>
      buildDistanceExpression(
        scopeFor(new SQLiteAdapter(), record),
        column,
        { to: [1, 2, 3], metric: "l2" },
        {
          name: "embedding",
          scalarState: { type: "vector", dimension: 3 },
        },
        "orderBy"
      )
    ).toThrow("vector ordering requires");
    for (const value of [
      42,
      { to: [1, Number.NaN, 3], metric: "l2" },
      { to: [1, 2, 3], metric: "taxicab" },
      { to: [1, 2], metric: "l2" },
    ]) {
      expect(() =>
        buildDistanceExpression(
          postgres,
          column,
          value,
          {
            name: "embedding",
            scalarState: { type: "vector", dimension: 3 },
          },
          "select"
        )
      ).toThrow(VECTOR_REFUSAL_PATTERN);
    }

    expect(() =>
      buildDistanceExpression(
        postgres,
        column,
        42,
        { name: "location", scalarState: { type: "point" } },
        "orderBy"
      )
    ).toThrow("GeoPoint distance orderBy requires an object");

    const noPointAdapter = new Proxy(new PostgresAdapter(), {
      get(target, property, receiver) {
        return property === "geoPoint"
          ? undefined
          : Reflect.get(target, property, receiver);
      },
    });
    expect(() => requireGeoPointSql(noPointAdapter, "equals")).toThrow(
      "GeoPoint requires a provider"
    );
  });

  test("rejects malformed relation order, count, and junction state", () => {
    const relationScope = scopeFor(new PostgresAdapter(), relationSchema.post);
    expect(() =>
      buildOrderByParts(
        relationScope,
        { author: { name: undefined } },
        relationScope.rootAlias
      )
    ).toThrow("requires at least one scalar field");

    const collectionScope = scopeFor(
      new PostgresAdapter(),
      polymorphicSchema.gallery
    );
    for (const value of [42, {}, { some: 42 }, { some: { type: "missing" } }]) {
      expect(() =>
        buildWhere(collectionScope, { items: value }, collectionScope.rootAlias)
      ).toThrow(POLYMORPHIC_FILTER_REFUSAL_PATTERN);
    }
    const carrier = variantCarrier(collectionScope, "items");
    if (!carrier || isVariantRowCarrier(carrier)) {
      throw new Error("Expected a polymorphic collection carrier.");
    }
    expect(() =>
      buildPolymorphicCollectionCount(
        (ctx, where) => buildWhere(ctx, where, ctx.rootAlias),
        collectionScope,
        carrier,
        { where: { type: "missing" } },
        collectionScope.rootAlias
      )
    ).toThrow("Unknown polymorphic target");

    const { scope, relation } = requiredJunction();
    const emptySource: JunctionBoundRelation = {
      ...relation,
      membership: {
        ...relation.membership,
        source: { ...relation.membership.source, members: [] },
      },
    };
    expect(() =>
      buildJunctionInsertMany(
        scope,
        emptySource,
        [],
        [[sql`${"eu"}`, sql`${1}`]]
      )
    ).toThrow("Junction source has no stored-reference member");
  });
});
