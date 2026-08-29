/**
 * Write-side database-namespace qualification.
 *
 * Every INSERT/UPDATE/DELETE target, every junction write, and every statement
 * a nested write emits reaches its table through the one persistent-table
 * renderer. The mutation projection's CTE is the counter-case: it is a
 * statement-local name and its exact pre-feature spelling must survive, because
 * a qualified CTE would still parse on PostgreSQL and silently mean a table.
 *
 * Structural only: the mock driver opens no provider resource.
 */

import { getAdapterInternals } from "@adapters/adapter-internals";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { type AnyDriver, type Dialect, Driver } from "@drivers";
import { bindRelation } from "@query-engine/builders/relation-data-builder";
import { lookupRelation } from "@query-engine/context";
import {
  type JunctionOperation,
  JunctionStatements,
} from "@query-engine/JunctionStatements";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Operation } from "@query-engine/types";
import { hydrateSchemaNames } from "@schema";
import type { Model } from "@schema/model";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import {
  NAMESPACE_SCHEMA_TABLES,
  namespaceSchema,
} from "@tests/fixtures/namespace-schema";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

class MockDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;

  constructor(dialect: Dialect, adapter: DatabaseAdapter) {
    super(dialect, `namespace-write-mock-${dialect}`);
    this.adapter = adapter;
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // The SQL-only driver opens no provider resource.
  }

  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    execute: (transaction: null) => Promise<T>
  ): Promise<T> {
    return execute(null);
  }
}

hydrateSchemaNames(namespaceSchema);
prepareSchema(namespaceSchema);
const registry = createModelRegistry(
  namespaceSchema,
  createSchemaRegistry(namespaceSchema)
);
const { user, post } = namespaceSchema;

const engineFor = (adapter: DatabaseAdapter, dialect: Dialect): QueryEngine =>
  new QueryEngine(new MockDriver(dialect, adapter), registry);

const renderWith = (
  adapter: DatabaseAdapter,
  dialect: Dialect,
  placeholder: "$n" | "?"
) => {
  const engine = engineFor(adapter, dialect);
  return (
    model: Model<any>,
    operation: Operation,
    args: Record<string, unknown>
  ) => {
    const statement = engine.build(model, operation, args);
    return {
      text: statement.toStatement(placeholder),
      binds: statement.values.length,
    };
  };
};

const pg = renderWith(new PostgresAdapter("billing"), "postgresql", "$n");
const pgPublic = renderWith(new PostgresAdapter("public"), "postgresql", "$n");
const mysqlBound = renderWith(new MySQLAdapter("billing"), "mysql", "?");
const mysqlUnbound = renderWith(new MySQLAdapter(), "mysql", "?");
const sqlite = renderWith(new SQLiteAdapter(), "sqlite", "?");

const USE_STATEMENT = /\bUSE\b/;

const unqualifiedTables = (
  text: string,
  prefix: string,
  quote: '"' | "`"
): string[] => {
  const missed: string[] = [];
  for (const table of NAMESPACE_SCHEMA_TABLES) {
    const quoted = `${quote}${table}${quote}`;
    let index = text.indexOf(quoted);
    while (index !== -1) {
      const after = index + quoted.length;
      // `"ns_posts"."col"` is a column correlated by the target's implicit
      // correlation name, not a table position — see the premise test below.
      const isTablePosition = text[after] !== ".";
      if (isTablePosition && !text.startsWith(prefix, index - prefix.length)) {
        missed.push(table);
      }
      index = text.indexOf(quoted, after);
    }
  }
  return missed;
};

/** How many times a statement names a persistent table in table position. */
const tableMentions = (text: string, quote: '"' | "`"): number => {
  let total = 0;
  for (const table of NAMESPACE_SCHEMA_TABLES) {
    const quoted = `${quote}${table}${quote}`;
    let index = text.indexOf(quoted);
    while (index !== -1) {
      const after = index + quoted.length;
      if (text[after] !== ".") total++;
      index = text.indexOf(quoted, after);
    }
  }
  return total;
};

type WriteCase = readonly [
  string,
  Model<any>,
  Operation,
  Record<string, unknown>,
];

/** Writes that compile to ONE statement on a RETURNING dialect. */
const WRITES: readonly WriteCase[] = [
  [
    "create",
    post,
    "create",
    { data: { id: "p1", title: "t", authorId: "u1" } },
  ],
  [
    "createMany",
    post,
    "createMany",
    { data: [{ id: "p1", title: "t", authorId: "u1" }] },
  ],
  [
    "create returning a projection",
    post,
    "create",
    {
      data: { id: "p1", title: "t", authorId: "u1" },
      select: { id: true, title: true },
    },
  ],
  ["update", post, "update", { where: { id: "p1" }, data: { title: "n" } }],
  [
    "updateMany",
    post,
    "updateMany",
    { where: { views: { gte: 1 } }, data: { title: "n" } },
  ],
  ["delete", post, "delete", { where: { id: "p1" } }],
  ["deleteMany", post, "deleteMany", { where: { views: { gte: 1 } } }],
  [
    "upsert",
    post,
    "upsert",
    {
      where: { id: "p1" },
      create: { id: "p1", title: "t", authorId: "u1" },
      update: { title: "n" },
    },
  ],
];

/**
 * MySQL has no `RETURNING`, so the located-row families are several statements
 * there and reach this suite through the fragment matrix below instead.
 */
const MYSQL_WRITES: readonly WriteCase[] = WRITES.filter(([, , operation]) =>
  ["createMany", "updateMany", "deleteMany"].includes(operation)
);

describe("a bound PostgreSQL adapter qualifies every write target", () => {
  for (const [name, model, operation, args] of WRITES) {
    test(name, () => {
      const { text } = pg(model, operation, args);
      expect(tableMentions(text, '"')).toBeGreaterThan(0);
      expect(unqualifiedTables(text, '"billing".', '"')).toEqual([]);
      expect(text).not.toContain('"billing"."billing"');
    });
  }
});

describe("a bound MySQL adapter qualifies every write target", () => {
  for (const [name, model, operation, args] of MYSQL_WRITES) {
    test(name, () => {
      const { text } = mysqlBound(model, operation, args);
      expect(tableMentions(text, "`")).toBeGreaterThan(0);
      expect(unqualifiedTables(text, "`billing`.", "`")).toEqual([]);
      expect(text).not.toMatch(USE_STATEMENT);
    });
  }
});

describe("unbound dialects emit no prefix on writes", () => {
  for (const [name, model, operation, args] of MYSQL_WRITES) {
    test(`unbound MySQL: ${name}`, () => {
      const { text } = mysqlUnbound(model, operation, args);
      const mentions = tableMentions(text, "`");
      expect(mentions).toBeGreaterThan(0);
      expect(unqualifiedTables(text, "`billing`.", "`")).toHaveLength(mentions);
    });
  }

  for (const [name, model, operation, args] of WRITES) {
    test(`SQLite: ${name}`, () => {
      const { text } = sqlite(model, operation, args);
      const mentions = tableMentions(text, '"');
      expect(mentions).toBeGreaterThan(0);
      expect(unqualifiedTables(text, '"public".', '"')).toHaveLength(mentions);
    });
  }
});

describe("a qualified target keeps its bare correlation name", () => {
  // PostgreSQL and MySQL both name an unaliased `UPDATE "ns"."t"` target `t`,
  // so a predicate column correlated as `"t"."col"` resolves to that target.
  // This is what lets the write builders keep bare-name column qualification
  // beside a qualified target instead of forcing a new alias.
  test("an UPDATE predicate correlates on the object name alone", () => {
    const { text } = pg(post, "updateMany", {
      where: { views: { gte: 1 } },
      data: { title: "n" },
    });
    expect(text).toContain('UPDATE "billing"."ns_posts" SET');
    expect(text).toContain('"ns_posts"."views"');
    expect(text).not.toContain('"billing"."ns_posts"."views"');
  });
});

describe("the mutation projection CTE stays statement-local", () => {
  const foldArgs = {
    where: { id: "p1" },
    data: { title: "n" },
    include: { author: true },
  };

  test("the CTE keeps its exact unqualified spelling while the write target qualifies", () => {
    const { text } = pg(post, "update", foldArgs);
    expect(text).toContain(
      'WITH "__viborm_mutation" AS (UPDATE "billing"."ns_posts"'
    );
    expect(text).toContain('FROM "__viborm_mutation" AS "t0"');
    expect(text).not.toContain('"billing"."__viborm_mutation"');
  });

  test("only the persistent participants carry the namespace", () => {
    const { text } = pg(post, "update", foldArgs);
    for (const match of text.matchAll(/"billing"\."([^"]+)"/g)) {
      expect(NAMESPACE_SCHEMA_TABLES).toContain(match[1]);
    }
  });

  test("the fold is byte-identical to public apart from the prefix", () => {
    expect(pg(post, "update", foldArgs).text).toBe(
      pgPublic(post, "update", foldArgs).text.replaceAll(
        '"public".',
        '"billing".'
      )
    );
  });
});

describe("nested and junction writes qualify every participant", () => {
  const junctionUpdate = (
    adapter: DatabaseAdapter,
    dialect: Dialect,
    data: Record<string, unknown>
  ): string[] => {
    const engine = engineFor(adapter, dialect);
    const operation = new UpdateOperation(engine, user, {
      where: { id: "u1" },
      data,
      select: { id: true },
    });
    const planning = operation.planning();
    const known: Record<string, unknown> = {};
    for (const step of planning.steps) {
      known[`${step.id}.rows`] = [{ id: "u1", tag_ref: "g1", user_ref: "u1" }];
    }
    const statements = [
      ...planning.steps.map((step) => step.statement),
      ...operation
        .compile(known)
        .steps.flatMap((step) =>
          step.kind === "guard" || step.kind === "recordSeries"
            ? []
            : [step.statement]
        ),
    ];
    return statements.map((statement) => statement.toStatement("$n"));
  };

  const PAYLOADS: readonly [string, Record<string, unknown>][] = [
    ["junction connect", { tags: { connect: [{ id: "g1" }] } }],
    ["junction disconnect", { tags: { disconnect: [{ id: "g1" }] } }],
    ["junction set", { tags: { set: [{ id: "g1" }] } }],
    ["junction create", { tags: { create: [{ id: "g1", label: "L" }] } }],
    [
      "nested to-many create",
      { posts: { create: [{ id: "p1", title: "t" }] } },
    ],
    [
      "nested to-many update",
      {
        posts: {
          update: [{ where: { id: "p1" }, data: { title: "n" } }],
        },
      },
    ],
    ["nested to-many delete", { posts: { delete: [{ id: "p1" }] } }],
  ];

  for (const [name, data] of PAYLOADS) {
    test(`${name} qualifies every table it names`, () => {
      const statements = junctionUpdate(
        new PostgresAdapter("billing"),
        "postgresql",
        data
      );
      expect(statements.length).toBeGreaterThan(0);
      let mentions = 0;
      for (const text of statements) {
        mentions += tableMentions(text, '"');
        expect(unqualifiedTables(text, '"billing".', '"')).toEqual([]);
        expect(text).not.toContain('"billing"."billing"');
      }
      expect(mentions).toBeGreaterThan(0);
    });

    test(`${name} leaves an unbound MySQL statement unprefixed`, () => {
      for (const text of junctionUpdate(new MySQLAdapter(), "mysql", data)) {
        const mentions = tableMentions(text, "`");
        expect(unqualifiedTables(text, "`billing`.", "`")).toHaveLength(
          mentions
        );
      }
    });
  }
});

/**
 * THE CONNECT LOOKUP SUBQUERY.
 *
 * A to-one `connect` whose `where` carries a unique that is NOT the referenced
 * field cannot resolve the foreign key to a literal, so the FK value is a
 * correlated `(SELECT <referenced> FROM <target> <alias> WHERE …)` spliced into
 * the INSERT's `VALUES`. That subquery is the one persistent-table position the
 * engine renders beside a SITE-OWNED, unquoted alias, and it is reached by no
 * other read or write shape in this suite: if it lost its prefix, a bound client
 * would silently resolve the foreign key against whatever the session's
 * `search_path` (or default database) points at — a cross-namespace read inside
 * a write, which is exactly the leak the feature exists to prevent.
 */
describe("a to-one connect resolves its key through the qualified target", () => {
  const connectSql = (
    adapter: DatabaseAdapter,
    dialect: Dialect,
    data: Record<string, unknown>
  ) => {
    const engine = engineFor(adapter, dialect);
    const operation = new CreateOperation(engine, post, {
      data: { id: "p1", title: "t", ...data },
      select: { id: true },
    });
    const planning = operation.planning();
    const known: Record<string, unknown> = {};
    for (const step of planning.steps) {
      known[`${step.id}.rows`] = [{ id: "u1", email: "a@b.c" }];
    }
    return [
      ...planning.steps.map((step) => step.statement),
      ...operation
        .compile(known)
        .steps.flatMap((step) =>
          step.kind === "guard" || step.kind === "recordSeries"
            ? []
            : [step.statement]
        ),
    ];
  };

  const connectStatements = (
    adapter: DatabaseAdapter,
    dialect: Dialect,
    placeholder: "$n" | "?",
    data: Record<string, unknown>
  ): string[] =>
    connectSql(adapter, dialect, data).map((statement) =>
      statement.toStatement(placeholder)
    );

  const connectBinds = (
    adapter: DatabaseAdapter,
    dialect: Dialect,
    data: Record<string, unknown>
  ): number[] =>
    connectSql(adapter, dialect, data).map(
      (statement) => statement.values.length
    );

  const PAYLOADS: readonly [string, Record<string, unknown>][] = [
    ["connect", { author: { connect: { email: "a@b.c" } } }],
    [
      "connectOrCreate",
      {
        author: {
          connectOrCreate: {
            where: { email: "a@b.c" },
            create: { id: "u9", email: "a@b.c" },
          },
        },
      },
    ],
  ];

  for (const [name, data] of PAYLOADS) {
    test(`${name} splices a qualified lookup into the INSERT`, () => {
      const texts = connectStatements(
        new PostgresAdapter("billing"),
        "postgresql",
        "$n",
        data
      );
      expect(texts.join("\n")).toContain(
        'INSERT INTO "billing"."ns_posts" ("id", "title", "views", "authorId") ' +
          'VALUES ($1, $2, $3, CAST((SELECT "t1"."id" FROM "billing"."ns_users" t1 ' +
          'WHERE "t1"."email" = $4) AS TEXT))'
      );
      for (const text of texts) {
        expect(unqualifiedTables(text, '"billing".', '"')).toEqual([]);
        expect(text).not.toContain('"billing"."billing"');
      }
    });

    test(`${name} qualifies the lookup on bound MySQL`, () => {
      const texts = connectStatements(
        new MySQLAdapter("billing"),
        "mysql",
        "?",
        data
      );
      expect(texts.join("\n")).toContain(
        "FROM `billing`.`ns_users` t1 WHERE `t1`.`email` = ?"
      );
      for (const text of texts) {
        expect(unqualifiedTables(text, "`billing`.", "`")).toEqual([]);
        expect(text).not.toMatch(USE_STATEMENT);
      }
    });

    test(`${name} leaves the lookup unprefixed when the adapter is unbound`, () => {
      expect(
        connectStatements(new MySQLAdapter(), "mysql", "?", data).join("\n")
      ).toContain("FROM `ns_users` t1 WHERE `t1`.`email` = ?");
      expect(
        connectStatements(new SQLiteAdapter(), "sqlite", "?", data).join("\n")
      ).toContain('FROM "ns_users" t1 WHERE "t1"."email" = ?');
    });

    test(`${name} binds the same values bound and unqualified`, () => {
      const bound = new PostgresAdapter("billing");
      const unqualified = new PostgresAdapter("public");
      expect(connectBinds(bound, "postgresql", data)).toEqual(
        connectBinds(unqualified, "postgresql", data)
      );
      expect(connectStatements(bound, "postgresql", "$n", data)).toEqual(
        connectStatements(unqualified, "postgresql", "$n", data).map((text) =>
          text.replaceAll('"public".', '"billing".')
        )
      );
    });
  }
});

describe("every junction statement kind qualifies its tables", () => {
  const junctionOf = (adapter: DatabaseAdapter) => {
    const scope = scopeFor(adapter, user);
    const relationRef = lookupRelation(scope, "tags");
    if (!relationRef) throw new Error("expected the 'tags' junction relation");
    const relation = bindRelation(scope, relationRef);
    if (relation.position !== "junction") {
      throw new Error("expected 'tags' to bind a junction");
    }
    return { scope, relation };
  };

  const KINDS: readonly [string, JunctionOperation, Record<string, unknown>][] =
    [
      // INSERT … SELECT: reads the target table and writes the junction.
      [
        "junctionInsert joined on an existing target",
        "junctionInsert",
        { parentValue: "u1", targetValue: "g1", joinWhenTargetExists: true },
      ],
      // The exact-membership no-op policy is a DIFFERENT select builder: it
      // anti-joins the membership table against the target instead of reading
      // the target alone, so it names two tables the ordinary insert-select
      // never puts in the same statement.
      [
        "junctionInsert under the exact-membership no-op policy",
        "junctionInsert",
        {
          parentValue: "u1",
          targetValue: "g1",
          duplicatePolicy: "exactMembershipNoop",
        },
      ],
      [
        "junctionInsertMany",
        "junctionInsertMany",
        { parentValue: "u1", targetValues: ["g1", "g2"] },
      ],
      ["junctionDelete", "junctionDelete", { parentValue: "u1" }],
      [
        "junctionDelete narrowed by a target where",
        "junctionDelete",
        { parentValue: "u1", targetWhere: { id: "g1" } },
      ],
      [
        "junctionDeleteTargets",
        "junctionDeleteTargets",
        { parentValue: "u1", targetValues: ["g1"] },
      ],
      [
        "junctionDeleteExact",
        "junctionDeleteExact",
        { parentValue: "u1", targetValue: "g1" },
      ],
      ["membershipOwners", "membershipOwners", { targetValue: "g1" }],
      ["membershipRead", "membershipRead", { parentValue: "u1" }],
      [
        "membershipDifference",
        "membershipDifference",
        { parentValue: "u1", targetValues: ["g1"], difference: "added" },
      ],
      [
        "membershipUpdateMany",
        "membershipUpdateMany",
        { parentValue: "u1", data: { label: { set: "L" } } },
      ],
    ];

  for (const [name, operation, args] of KINDS) {
    test(`${name} names every table through the namespace`, () => {
      const bound = junctionOf(new PostgresAdapter("billing"));
      const text = new JunctionStatements(bound.scope, false)
        .materialize(bound.relation, operation, args)
        .toStatement("$n");

      expect(tableMentions(text, '"')).toBeGreaterThan(0);
      expect(unqualifiedTables(text, '"billing".', '"')).toEqual([]);
      expect(text).not.toContain('"billing"."billing"');
    });

    test(`${name} stays unprefixed on an unbound MySQL adapter`, () => {
      const unbound = junctionOf(new MySQLAdapter());
      const text = new JunctionStatements(unbound.scope, false)
        .materialize(unbound.relation, operation, args)
        .toStatement("?");

      const mentions = tableMentions(text, "`");
      expect(mentions).toBeGreaterThan(0);
      expect(unqualifiedTables(text, "`billing`.", "`")).toHaveLength(mentions);
    });
  }
});

describe("qualification binds nothing extra", () => {
  test("every write binds the same values bound and unqualified", () => {
    for (const [name, model, operation, args] of WRITES) {
      const bound = pg(model, operation, args);
      const unqualified = pgPublic(model, operation, args);
      expect(`${name}: ${bound.binds}`).toBe(`${name}: ${unqualified.binds}`);
      expect(bound.text).toBe(
        unqualified.text.replaceAll('"public".', '"billing".')
      );
    }
  });
});

// The batch reference table is connection-local, so it is never a namespace
// member — this reads the exact driver-facing group the executor uses.
describe("the batch reference temp table is never qualified", () => {
  test("setup, store, read and cleanup name it bare", () => {
    const adapter: AnyDriver["adapter"] = new PostgresAdapter("billing");
    const statements = [
      ...getAdapterInternals(adapter).batchRefs.setup("b1"),
      getAdapterInternals(adapter).batchRefs.store(
        "b1",
        "k",
        adapter.literals.value(1)
      ),
      getAdapterInternals(adapter).batchRefs.read("b1", "k"),
      getAdapterInternals(adapter).batchRefs.clear("b1"),
      getAdapterInternals(adapter).batchRefs.cleanup("b1"),
    ];
    for (const statement of statements) {
      expect(statement.toStatement("$n")).toContain('"__viborm_batch_refs"');
      expect(statement.toStatement("$n")).not.toContain('"billing"');
    }
  });
});
