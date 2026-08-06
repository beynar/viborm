import type { AnyDriver, BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { CreateOperation } from "../../src/query-engine/write-engine/CreateOperation";
import {
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  type PlanningFragment,
  type StatementStep,
} from "../../src/query-engine/write-engine/OperationFragment";
import { UpdateOperation } from "../../src/query-engine/write-engine/UpdateOperation";
import { UpsertOperation } from "../../src/query-engine/write-engine/UpsertOperation";
import { createJunctionUpsertSchema } from "./create-junction-upsert-behavior";
import { producedIdentitySchema as junctionIdentitySchema } from "./e4-junction-produced-identity-behavior";
import { locatedParentRefSchema } from "./located-parent-ref-behavior";
import { postTransitionAdoptSchema } from "./post-transition-adopt-behavior";
import { producedIdentitySchema } from "./produced-identity-depth-behavior";
import {
  correlatedUpsertArgs,
  updateSliceSchema,
} from "./update-nested-upsert-behavior";

class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

function engineFor(
  driver: AnyDriver,
  schema: Record<string, Model<any>>
): QueryEngine {
  return new QueryEngine(
    driver,
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
}

function updateFor(
  driver: PGliteDriver,
  schema: Record<string, Model<any>>,
  model: Model<any>,
  args: Record<string, unknown>
): UpdateOperation {
  return new UpdateOperation(engineFor(driver, schema), model, args);
}

function normalized(value: unknown): unknown {
  if (isOperationValueReference(value)) {
    return { ref: `${value.step}.${value.output}` };
  }
  if (Array.isArray(value)) return value.map(normalized);
  if (!(value && typeof value === "object")) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, member]) => [key, normalized(member)])
  );
}

function reference(step: string, output: string): unknown {
  return { ref: `${step}.${output}` };
}

function ids(fragment: PlanningFragment | OperationFragment): string[] {
  return fragment.steps.map((step) => step.id);
}

function step(
  fragment: PlanningFragment | OperationFragment,
  id: string
): OperationStep {
  const found = fragment.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Expected fragment step '${id}'.`);
  return found;
}

function statementStep(
  fragment: PlanningFragment | OperationFragment,
  id: string
): StatementStep {
  const found = step(fragment, id);
  if (found.kind === "guard") throw new Error(`Expected statement '${id}'.`);
  return found;
}

function prepared(
  driver: PGliteDriver,
  current: StatementStep
): { readonly sql: string; readonly params: unknown } {
  const query = driver._prepare(current.statement);
  return { sql: query.sql, params: normalized(query.params) };
}

function effects(current: StatementStep): {
  readonly outputs: unknown;
  readonly expects: unknown;
  readonly racePin: unknown;
  readonly onUniqueConflict: unknown;
} {
  return {
    outputs: normalized(current.outputs),
    expects: current.expects ?? null,
    racePin: current.kind === "write" ? (current.racePin ?? null) : null,
    onUniqueConflict:
      current.kind === "write" ? (current.onUniqueConflict ?? null) : null,
  };
}

function guardContract(driver: PGliteDriver, current: OperationStep): unknown {
  if (current.kind !== "guard") throw new Error("Expected a guard step.");
  const query = driver._prepare(current.premise.statement);
  return {
    id: current.id,
    premise: {
      kind: current.premise.kind,
      sql: query.sql,
      params: normalized(query.params),
    },
    failure: current.failure,
  };
}

function fragmentContract(
  driver: PGliteDriver,
  fragment: PlanningFragment | OperationFragment
): unknown {
  return {
    steps: fragment.steps.map((current) =>
      current.kind === "guard"
        ? guardContract(driver, current)
        : {
            id: current.id,
            kind: current.kind,
            ...prepared(driver, current),
            ...effects(current),
          }
    ),
    outputs: normalized(fragment.outputs),
  };
}

function outputContract(
  fragment: PlanningFragment | OperationFragment
): unknown {
  return normalized(fragment.outputs);
}

const terminalExpectation = (operation: "create" | "update") => ({
  kind: "exactlyOneRow",
  failure: {
    kind: "query",
    message: `query-engine-v2 ${operation} terminal read expected exactly one row.`,
    raceable: false,
  },
});

describe("one fresh-record compiler parity", () => {
  test("literal and planned parent positions emit the same final fragment", () => {
    const driver = new PGliteDriver();
    const args = {
      data: { notes: { create: { id: 10, body: "fresh" } } },
      select: { id: true },
    };
    const literal = updateFor(
      driver,
      locatedParentRefSchema,
      locatedParentRefSchema.account,
      { where: { id: 2 }, ...args }
    );
    const planned = updateFor(
      driver,
      locatedParentRefSchema,
      locatedParentRefSchema.account,
      { where: { email: "target@x" }, ...args }
    );
    expect(ids(literal.planning())).toEqual(["account.locate"]);
    expect(ids(planned.planning())).toEqual(["account.locate"]);
    expect(
      prepared(driver, statementStep(literal.planning(), "account.locate"))
    ).toEqual({
      sql: 'SELECT "t0"."id" AS "id" FROM "n1_ref_accounts" AS "t0" WHERE "t0"."id" = $1 LIMIT 1 FOR UPDATE',
      params: [2],
    });
    expect(
      prepared(driver, statementStep(planned.planning(), "account.locate"))
    ).toEqual({
      sql: 'SELECT "t0"."id" AS "id" FROM "n1_ref_accounts" AS "t0" WHERE "t0"."email" = $1 LIMIT 1 FOR UPDATE',
      params: ["target@x"],
    });
    expect(
      effects(statementStep(planned.planning(), "account.locate"))
    ).toEqual(effects(statementStep(literal.planning(), "account.locate")));
    expect(outputContract(planned.planning())).toEqual({
      "account.locate.rows": reference("account.locate", "rows"),
      "account.locate.id": reference("account.locate", "id"),
    });

    const literalFinal = literal.compile({
      "account.locate.rows": [{ id: 2 }],
    });
    const plannedFinal = planned.compile({
      "account.locate.rows": [{ id: 2 }],
    });
    expect(fragmentContract(driver, plannedFinal)).toEqual(
      fragmentContract(driver, literalFinal)
    );
    expect(ids(literalFinal)).toEqual(["note.create", "account.select"]);
    expect(
      prepared(driver, statementStep(literalFinal, "note.create"))
    ).toEqual({
      sql: 'INSERT INTO "n1_ref_notes" ("id", "body", "accountId") VALUES ($1, $2, CAST($3 AS INTEGER))',
      params: [10, "fresh", 2],
    });
    expect(effects(statementStep(literalFinal, "note.create"))).toEqual({
      outputs: {},
      expects: null,
      racePin: null,
      onUniqueConflict: null,
    });
    expect(statementStep(literalFinal, "account.select").expects).toEqual(
      terminalExpectation("update")
    );
    expect(outputContract(literalFinal)).toEqual({
      result: reference("account.select", "result"),
    });
  });

  test("a transitioned position binds the new key after the root update", () => {
    const driver = new PGliteDriver();
    const operation = updateFor(
      driver,
      postTransitionAdoptSchema,
      postTransitionAdoptSchema.list,
      {
        where: { id: 1 },
        data: {
          id: 5,
          items: { create: { id: 20, label: "fresh" } },
        },
        select: { id: true },
      }
    );
    const planning = operation.planning();
    expect(ids(planning)).toEqual(["list.locate", "item.transition.find"]);
    expect(
      prepared(driver, statementStep(planning, "item.transition.find"))
    ).toEqual({
      sql: 'SELECT "t0"."id" AS "id" FROM "n5_pta_items" AS "t0" WHERE "t0"."listId" = $1 ORDER BY "t0"."id" ASC LIMIT $2 FOR UPDATE',
      params: [1, 1],
    });
    expect(outputContract(planning)).toEqual({
      "list.locate.rows": reference("list.locate", "rows"),
      "list.locate.id": reference("list.locate", "id"),
      "item.transition.find.rows": reference("item.transition.find", "rows"),
    });

    const final = operation.compile({ "list.locate.rows": [{ id: 1 }] });
    expect(ids(final)).toEqual(["list.update", "item.create", "list.select"]);
    expect(prepared(driver, statementStep(final, "list.update"))).toEqual({
      sql: 'UPDATE "n5_pta_lists" SET "id" = $1 WHERE "n5_pta_lists"."id" = $2 RETURNING "id" AS "id"',
      params: [5, 1],
    });
    expect(prepared(driver, statementStep(final, "item.create"))).toEqual({
      sql: 'INSERT INTO "n5_pta_items" ("id", "label", "listId") VALUES ($1, $2, CAST($3 AS INTEGER))',
      params: [20, "fresh", 5],
    });
    expect(statementStep(final, "list.update").expects).toMatchObject({
      kind: "affectedRows",
      expected: 1,
    });
    expect(statementStep(final, "list.select").expects).toEqual(
      terminalExpectation("update")
    );
    expect(outputContract(final)).toEqual({
      result: reference("list.select", "result"),
    });
    expect(() => operation.compile({})).toThrowError(
      "query-engine-v2 update planning did not expose the locate rows."
    );
  });

  test("scalar and relation-bearing upsert arms share the root record", () => {
    const driver = new PGliteDriver();
    const operation = (withTask: boolean) =>
      updateFor(driver, producedIdentitySchema, producedIdentitySchema.org, {
        where: { id: 2 },
        data: {
          teams: {
            upsert: {
              where: { code: "T-FRESH" },
              create: {
                id: 20,
                code: "T-FRESH",
                title: "fresh",
                ...(withTask
                  ? { tasks: { create: { id: 100, label: "deep" } } }
                  : {}),
              },
              update: { title: "adopted" },
            },
          },
        },
        select: { id: true },
      });
    const scalar = operation(false);
    const nested = operation(true);
    expect(fragmentContract(driver, nested.planning())).toEqual(
      fragmentContract(driver, scalar.planning())
    );
    expect(ids(scalar.planning())).toEqual(["org.locate", "team.find"]);
    const known = {
      "org.locate.rows": [{ id: 2 }],
      "team.find.rows": [],
    };
    const scalarFinal = scalar.compile(known);
    const nestedFinal = nested.compile(known);
    expect(ids(scalarFinal)).toEqual(["team.create", "org.select"]);
    expect(ids(nestedFinal)).toEqual([
      "team.create",
      "task.create",
      "org.select",
    ]);
    expect(
      fragmentContract(driver, {
        steps: [statementStep(nestedFinal, "team.create")],
        outputs: {},
      })
    ).toEqual(
      fragmentContract(driver, {
        steps: [statementStep(scalarFinal, "team.create")],
        outputs: {},
      })
    );
    expect(prepared(driver, statementStep(nestedFinal, "team.create"))).toEqual(
      {
        sql: 'INSERT INTO "n4pi_teams" ("id", "code", "title", "orgId", "leadId") VALUES ($1, $2, $3, CAST($4 AS INTEGER), NULL)',
        params: [20, "T-FRESH", "fresh", 2],
      }
    );
    expect(effects(statementStep(nestedFinal, "team.create"))).toEqual({
      outputs: {},
      expects: null,
      racePin: {
        fields: ["code"],
        table: "n4pi_teams",
        columns: ["code"],
        constraints: ["n4pi_teams_code_key"],
      },
      onUniqueConflict: null,
    });
    expect(prepared(driver, statementStep(nestedFinal, "task.create"))).toEqual(
      {
        sql: 'INSERT INTO "n4pi_tasks" ("id", "label", "teamId", "ownerId") VALUES ($1, $2, CAST($3 AS INTEGER), NULL)',
        params: [100, "deep", 20],
      }
    );
    expect(outputContract(nestedFinal)).toEqual({
      result: reference("org.select", "result"),
    });
  });

  test("junction create orders target, descendants, then attachment", () => {
    const driver = new PGliteDriver();
    const operation = new CreateOperation(
      engineFor(driver, junctionIdentitySchema),
      junctionIdentitySchema.post,
      {
        data: {
          id: "p1",
          title: "fresh",
          stamps: {
            create: {
              name: "stamp",
              notes: { create: { id: "n1", body: "deep" } },
            },
          },
        },
        select: { id: true },
      }
    );
    expect(fragmentContract(driver, operation.planning())).toEqual({
      steps: [],
      outputs: {},
    });
    const final = operation.compile({});
    expect(ids(final)).toEqual([
      "post.create",
      "stamp.create",
      "note.create",
      "stamp.junction.insert",
      "post.select",
    ]);
    expect(prepared(driver, statementStep(final, "stamp.create"))).toEqual({
      sql: 'INSERT INTO "e4u3_stamps" ("name") VALUES ($1) RETURNING "id" AS "id"',
      params: ["stamp"],
    });
    expect(effects(statementStep(final, "stamp.create"))).toEqual({
      outputs: { id: { kind: "firstRowField", field: "id" } },
      expects: null,
      racePin: null,
      onUniqueConflict: null,
    });
    expect(prepared(driver, statementStep(final, "note.create"))).toEqual({
      sql: 'INSERT INTO "e4u3_notes" ("id", "body", "stampId") VALUES ($1, $2, CAST($3 AS INTEGER))',
      params: ["n1", "deep", reference("stamp.create", "id")],
    });
    expect(
      prepared(driver, statementStep(final, "stamp.junction.insert"))
    ).toEqual({
      sql: 'INSERT  INTO "post_stamp" ("postId", "stampId") VALUES ($1, CAST($2 AS INTEGER)) ON CONFLICT DO NOTHING',
      params: ["p1", reference("stamp.create", "id")],
    });
    expect(statementStep(final, "post.select").expects).toEqual(
      terminalExpectation("create")
    );
    expect(outputContract(final)).toEqual({
      result: reference("post.select", "result"),
    });
  });

  test("connect-or-create duplicates reuse the first generated record", () => {
    const driver = new PGliteDriver();
    const operation = updateFor(
      driver,
      junctionIdentitySchema,
      junctionIdentitySchema.post,
      {
        where: { id: "p1" },
        data: {
          stamps: {
            connectOrCreate: [
              {
                where: { name: "dup" },
                create: {
                  name: "dup",
                  notes: { create: { id: "n-first", body: "first" } },
                },
              },
              {
                where: { name: "dup" },
                create: {
                  name: "dup",
                  notes: { create: { id: "n-second", body: "second" } },
                },
              },
            ],
          },
        },
        select: { id: true },
      }
    );
    expect(ids(operation.planning())).toEqual([
      "post.locate",
      "stamp.find",
      "stamp.find#1",
    ]);
    expect(outputContract(operation.planning())).toEqual({
      "post.locate.rows": reference("post.locate", "rows"),
      "post.locate.id": reference("post.locate", "id"),
      "stamp.find.rows": reference("stamp.find", "rows"),
      "stamp.find#1.rows": reference("stamp.find#1", "rows"),
    });
    const final = operation.compile({
      "post.locate.rows": [{ id: "p1" }],
      "stamp.find.rows": [],
      "stamp.find#1.rows": [],
    });
    expect(ids(final)).toEqual([
      "stamp.create",
      "note.create",
      "stamp.junction.insert",
      "stamp.junction.insert#1",
      "post.select",
    ]);
    expect(statementStep(final, "stamp.create")).toMatchObject({
      outputs: { id: { kind: "firstRowField", field: "id" } },
      racePin: { fields: ["name"], table: "e4u3_stamps" },
    });
    expect(prepared(driver, statementStep(final, "note.create"))).toEqual({
      sql: 'INSERT INTO "e4u3_notes" ("id", "body", "stampId") VALUES ($1, $2, CAST($3 AS INTEGER))',
      params: ["n-first", "first", reference("stamp.create", "id")],
    });
    const firstJoin = prepared(
      driver,
      statementStep(final, "stamp.junction.insert")
    );
    expect(
      prepared(driver, statementStep(final, "stamp.junction.insert#1"))
    ).toEqual(firstJoin);
    expect(firstJoin).toEqual({
      sql: 'INSERT  INTO "post_stamp" ("postId", "stampId") VALUES ($1, CAST($2 AS INTEGER)) ON CONFLICT DO NOTHING',
      params: ["p1", reference("stamp.create", "id")],
    });
    expect(JSON.stringify(fragmentContract(driver, final))).not.toContain(
      "n-second"
    );
    expect(outputContract(final)).toEqual({
      result: reference("post.select", "result"),
    });
  });

  test("junction upsert preserves both selected-arm orders", () => {
    const driver = new PGliteDriver();
    const operation = new CreateOperation(
      engineFor(driver, createJunctionUpsertSchema),
      createJunctionUpsertSchema.article,
      {
        data: {
          title: "fresh",
          topics: {
            upsert: {
              where: { name: "topic" },
              create: { name: "topic", weight: 1 },
              update: { weight: 2 },
            },
          },
        },
        select: { id: true },
      }
    );
    expect(ids(operation.planning())).toEqual(["topic.find"]);
    expect(
      prepared(driver, statementStep(operation.planning(), "topic.find"))
    ).toEqual({
      sql: 'SELECT "t0"."id" AS "id" FROM "e5u1_topics" AS "t0" WHERE "t0"."name" = $1 LIMIT 1 FOR UPDATE',
      params: ["topic"],
    });
    expect(outputContract(operation.planning())).toEqual({
      "topic.find.rows": reference("topic.find", "rows"),
      "topic.find.id": reference("topic.find", "id"),
    });

    const missing = operation.compile({ "topic.find.rows": [] });
    const found = operation.compile({ "topic.find.rows": [{ id: 11 }] });
    expect(ids(missing)).toEqual([
      "article.create",
      "topic.create",
      "topic.junction.insert",
      "article.select",
    ]);
    expect(ids(found)).toEqual([
      "article.create",
      "topic.update",
      "topic.junction.insert",
      "article.select",
    ]);
    expect(prepared(driver, statementStep(missing, "topic.create"))).toEqual({
      sql: 'INSERT INTO "e5u1_topics" ("name", "weight", "authorId") VALUES ($1, $2, NULL) RETURNING "id" AS "id"',
      params: ["topic", 1],
    });
    expect(statementStep(missing, "topic.create")).toMatchObject({
      outputs: { id: { kind: "firstRowField", field: "id" } },
      racePin: { fields: ["name"], table: "e5u1_topics" },
    });
    expect(
      prepared(driver, statementStep(missing, "topic.junction.insert"))
    ).toEqual({
      sql: 'INSERT  INTO "article_topic" ("articleId", "topicId") VALUES (CAST($1 AS INTEGER), CAST($2 AS INTEGER)) ON CONFLICT DO NOTHING',
      params: [
        reference("article.create", "id"),
        reference("topic.create", "id"),
      ],
    });
    expect(prepared(driver, statementStep(found, "topic.update"))).toEqual({
      sql: 'UPDATE "e5u1_topics" SET "weight" = $1 WHERE "e5u1_topics"."id" = $2 RETURNING "id" AS "id"',
      params: [2, 11],
    });
    expect(
      prepared(driver, statementStep(found, "topic.junction.insert"))
    ).toEqual({
      sql: 'INSERT  INTO "article_topic" ("articleId", "topicId") VALUES (CAST($1 AS INTEGER), $2) ON CONFLICT DO NOTHING',
      params: [reference("article.create", "id"), 11],
    });
    expect(outputContract(missing)).toEqual({
      result: reference("article.select", "result"),
    });
    expect(outputContract(found)).toEqual({
      result: reference("article.select", "result"),
    });
  });

  test("a root upsert create arm keeps generated identity and race provenance", () => {
    const driver = new PGliteDriver();
    const operation = new UpsertOperation(
      engineFor(driver, updateSliceSchema),
      updateSliceSchema.user,
      {
        where: { email: "new@x" },
        create: {
          email: "new@x",
          count: 0,
          posts: {
            create: { id: 7, title: "child", slug: "child" },
          },
        },
        update: { count: 1 },
        select: { id: true },
      }
    );
    expect(ids(operation.planning())).toEqual(["user.locate"]);
    expect(outputContract(operation.planning())).toEqual({
      "user.locate.rows": reference("user.locate", "rows"),
    });
    const final = operation.compile({ "user.locate.rows": [] });
    expect(ids(final)).toEqual([
      "user.create#1",
      "post.create",
      "user.select#1",
    ]);
    expect(prepared(driver, statementStep(final, "user.create#1"))).toEqual({
      sql: 'INSERT INTO "update_slice_users" ("email", "count") VALUES ($1, $2) RETURNING "id" AS "id"',
      params: ["new@x", 0],
    });
    expect(statementStep(final, "user.create#1")).toMatchObject({
      outputs: { id: { kind: "firstRowField", field: "id" } },
      racePin: { fields: ["email"], table: "update_slice_users" },
    });
    expect(prepared(driver, statementStep(final, "post.create"))).toEqual({
      sql: 'INSERT INTO "update_slice_posts" ("id", "title", "slug", "userId") VALUES ($1, $2, $3, CAST($4 AS INTEGER))',
      params: [7, "child", "child", reference("user.create#1", "id")],
    });
    expect(statementStep(final, "user.select#1").expects).toEqual(
      terminalExpectation("create")
    );
    expect(outputContract(final)).toEqual({
      result: reference("user.select#1", "result"),
    });
    expect(() => operation.compile({})).toThrowError(
      "query-engine-v2 upsert planning did not expose the locate rows."
    );
  });

  test("batch found arms retain their guards and executor effects", () => {
    const driver = new BatchOnlyPGliteDriver();
    const operation = updateFor(
      driver,
      updateSliceSchema,
      updateSliceSchema.user,
      {
        ...correlatedUpsertArgs({
          email: "z@x",
          childId: 5,
          title: "fresh",
          slug: "s5",
        }),
        select: { id: true },
      }
    );
    expect(ids(operation.planning())).toEqual(["user.locate", "post.find"]);
    const final = operation.compile({
      "user.locate.rows": [{ id: 42 }],
      "post.find.rows": [{ id: 5, userId: 42 }],
    });
    expect(ids(final)).toEqual([
      "user.guard.exists",
      "post.guard.exists",
      "user.update",
      "post.update",
      "user.select",
    ]);
    expect(guardContract(driver, step(final, "user.guard.exists"))).toEqual({
      id: "user.guard.exists",
      premise: {
        kind: "exists",
        sql: 'SELECT "t0"."id" AS "id" FROM "update_slice_users" AS "t0" WHERE ("t0"."email" = $1 AND "t0"."id" = $2) ORDER BY "t0"."id" ASC LIMIT $3',
        params: ["z@x", 42, 1],
      },
      failure: {
        kind: "notFound",
        message:
          "query-engine-v2 update located no 'user' row for its unique where.",
        raceable: false,
      },
    });
    expect(guardContract(driver, step(final, "post.guard.exists"))).toEqual({
      id: "post.guard.exists",
      premise: {
        kind: "exists",
        sql: 'SELECT "t0"."id" AS "id", "t0"."userId" AS "userId" FROM "update_slice_posts" AS "t0" WHERE ("t0"."id" = $1 AND "t0"."id" = $2 AND "t0"."userId" = $3) ORDER BY "t0"."id" ASC LIMIT $4',
        params: [5, 5, 42, 1],
      },
      failure: {
        kind: "nestedWrite",
        message: "Nested upsert premise changed for relation 'posts'.",
        relation: "posts",
        raceable: false,
      },
    });
    for (const id of ["user.update", "post.update"]) {
      expect(effects(statementStep(final, id))).toEqual({
        outputs: {},
        expects: null,
        racePin: null,
        onUniqueConflict: null,
      });
    }
    expect(effects(statementStep(final, "user.select"))).toEqual({
      outputs: { result: { kind: "rows" } },
      expects: null,
      racePin: null,
      onUniqueConflict: null,
    });
    expect(outputContract(final)).toEqual({
      result: reference("user.select", "result"),
    });
  });

  test("createMany remains the specialized bulk boundary", () => {
    const driver = new PGliteDriver();
    const operation = updateFor(
      driver,
      locatedParentRefSchema,
      locatedParentRefSchema.account,
      {
        where: { email: "target@x" },
        data: {
          notes: {
            createMany: {
              data: [
                { id: 10, body: "first" },
                { id: 11, body: "second" },
              ],
            },
          },
        },
        select: { id: true },
      }
    );
    const final = operation.compile({ "account.locate.rows": [{ id: 2 }] });
    expect(ids(final)).toEqual(["note.createMany", "account.select"]);
    expect(prepared(driver, statementStep(final, "note.createMany"))).toEqual({
      sql: 'INSERT INTO "n1_ref_notes" ("id", "body", "accountId") VALUES ($1, $2, CAST($3 AS INTEGER)), ($4, $5, CAST($6 AS INTEGER))',
      params: [10, "first", 2, 11, "second", 2],
    });
    expect(effects(statementStep(final, "note.createMany"))).toEqual({
      outputs: {},
      expects: null,
      racePin: null,
      onUniqueConflict: null,
    });
    expect(outputContract(final)).toEqual({
      result: reference("account.select", "result"),
    });
    expect(() =>
      updateFor(
        driver,
        locatedParentRefSchema,
        locatedParentRefSchema.account,
        {
          where: { id: 2 },
          data: {
            notes: {
              create: { id: 10, body: "invalid", accountId: 99 },
            },
          },
        }
      )
    ).toThrowError(
      "Validation failed for update: Value did not match any union member: Unknown key: accountId, Expected array"
    );
  });
});
