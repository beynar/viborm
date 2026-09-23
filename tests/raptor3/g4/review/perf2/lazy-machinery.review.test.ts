/**
 * INDEPENDENT REVIEW — G4 performance pass 2, items 1 and 4.
 *
 * Item 1 turned eight per-operation fields of `OperationContext` and three
 * evidence collections of `TransportAttempt` into first-use accessors. The
 * failure mode is not slowness: it is a reader that can tell ABSENT from EMPTY.
 * The author proved the claim by breaking two readers; these probes assert the
 * positive side from outside — that the machinery really is absent on a pure
 * read, present the moment a writer needs it, and that every published fact an
 * operation carries (guards, correlation id, statement text, parameters) is
 * what it was.
 *
 * Item 4 stopped freezing each prepared operand. Freezing is not observable,
 * so the observable consequence is the only thing worth pinning: the same
 * admitted list lowers to the same statement and the same parameters however
 * many times it is lowered, in every mode that re-reads an operand.
 */

import assert from "node:assert/strict";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { OperationContext } from "@query-engine/raptor3/shared/operation-context";
import { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { afterEach, describe, it } from "vitest";
import { createWorld, worldSchema, type World } from "../../unit02/world";

/** The private field block, read by name — this is a white-box falsifier. */
type ContextInternals = {
  attemptStore?: unknown;
  committedMemberSet?: unknown;
  memberAttributionMap?: unknown;
  continuationList?: unknown;
  preparedGuardList?: unknown;
  answeredFailureSet?: unknown;
  correlationIdValue?: unknown;
};

const internals = (context: OperationContext): ContextInternals =>
  context as unknown as ContextInternals;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("review/perf2 — a pure read allocates no write machinery", () => {
  let world: World | undefined;

  afterEach(async () => {
    await world?.close();
    world = undefined;
  });

  it("materialises nothing for a findUnique that executes", async () => {
    const open = await createWorld();
    world = open;
    const schema = new EngineSchema(worldSchema);
    const context = new OperationContext(
      schema,
      open.driver,
      "author",
      "findUnique"
    );
    const args = schema.admit(worldSchema.author, "findUnique", {
      where: { id: 1 },
    });
    const value = await context.run(() =>
      context.publish(context.queries.read(worldSchema.author, "findUnique", args))
    );
    assert.deepEqual(value, {
      id: 1,
      name: "Ada",
      age: 36,
      avatar: null,
    });

    const field = internals(context);
    assert.equal(field.attemptStore, undefined, "a read built a TransportAttempt");
    assert.equal(field.committedMemberSet, undefined);
    assert.equal(field.memberAttributionMap, undefined);
    assert.equal(field.continuationList, undefined);
    assert.equal(field.preparedGuardList, undefined);
    assert.equal(field.answeredFailureSet, undefined);
    // A context nobody attributed mints ONE id, because the statement it
    // dispatches needs an execution context of its own — that is the program
    // specimen's shape, not the client route's.
    assert.match(field.correlationIdValue as string, UUID);
    // One statement, no transaction: the read's physical cost is unchanged.
    assert.equal(open.driver.statements.length, 1);
    assert.equal(open.driver.transactionCalls, 0);

    // The client route's shape: the caller's own trusted context is handed
    // down, so the read mints nothing at all. This is the path every measured
    // cell runs, and the one the pass's `crypto.randomUUID` claim rests on.
    const caller = {
      model: "author",
      operation: "findUnique",
      correlationId: "review-perf2",
    };
    const attributed = new OperationContext(
      schema,
      open.driver,
      "author",
      "findUnique",
      undefined,
      false,
      caller
    );
    await attributed.run(() =>
      attributed.publish(
        attributed.queries.read(worldSchema.author, "findUnique", args)
      )
    );
    const attributedFields = internals(attributed);
    assert.equal(attributedFields.attemptStore, undefined);
    assert.equal(
      attributedFields.correlationIdValue,
      undefined,
      "an attributed read minted a correlation id nothing reads"
    );
    assert.deepEqual(open.driver.statements.at(-1)!.context, caller);
  });

  it("mints one stable correlation id, and only on demand", async () => {
    const open = await createWorld();
    world = open;
    const schema = new EngineSchema(worldSchema);
    const context = new OperationContext(
      schema,
      open.driver,
      "author",
      "findUnique"
    );
    assert.equal(internals(context).correlationIdValue, undefined);
    const first = context.attribution.correlationId;
    const second = context.attribution.correlationId;
    assert.equal(typeof first, "string");
    assert.match(first as string, UUID);
    assert.equal(second, first, "the correlation id is not stable");

    const other = new OperationContext(
      schema,
      open.driver,
      "author",
      "findUnique"
    );
    assert.notEqual(
      other.attribution.correlationId,
      first,
      "two operations share one correlation id"
    );

    // A caller that hands its own trusted context down is still the authority.
    const caller = { model: "author", operation: "findUnique", correlationId: "given" };
    const passed = new OperationContext(
      schema,
      open.driver,
      "author",
      "findUnique",
      undefined,
      false,
      caller
    );
    assert.equal(passed.attribution, caller);
    assert.equal(
      internals(passed).correlationIdValue,
      undefined,
      "a caller-attributed operation minted a correlation id anyway"
    );
  });

  it("publishes guards for a packaged unique delete and none for a packaged read", async () => {
    const open = await createWorld();
    world = open;
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: open.driver,
    });

    const read = await engine.prepareBatch("author", "findUnique", {
      where: { id: 1 },
    });
    assert.ok(read, "the read did not package");
    assert.equal(
      Object.hasOwn(read, "guards"),
      false,
      "a packaged read published a guards key"
    );
    assert.equal(read.queries.length, 1);

    const removal = await engine.prepareBatch("author", "delete", {
      where: { id: 2 },
    });
    assert.ok(removal, "the delete did not package");
    assert.ok(removal.guards, "a packaged unique delete published no guard");
    assert.equal(removal.guards.length, 1);
    assert.equal(removal.guards[0]!.premise, "exists");
    assert.equal(removal.guards[0]!.queryIndex, 0);
  });
});

describe("review/perf2 — the shared projection publishes the same statement", () => {
  let world: World | undefined;

  afterEach(async () => {
    await world?.close();
    world = undefined;
  });

  it("repeats one default read byte for byte, and rebinds only its values", async () => {
    const open = await createWorld();
    world = open;
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: open.driver,
    });
    const publish = async (id: number) => {
      const prepared = await engine.prepareBatch("author", "findUnique", {
        where: { id },
      });
      assert.ok(prepared);
      return prepared.queries.map((query) => ({
        sql: query.sql,
        params: query.params,
      }));
    };

    const first = await publish(1);
    const second = await publish(1);
    assert.deepEqual(second, first, "two identical default reads drifted");
    assert.equal(first.length, 1);
    // The default projection names every scalar, under the statement's alias.
    assert.match(first[0]!.sql, /"q0"/);
    assert.match(first[0]!.sql, /"avatar"/);

    const third = await publish(2);
    assert.equal(
      third[0]!.sql,
      first[0]!.sql,
      "the same structure with a different value changed the statement"
    );
    assert.deepEqual(third[0]!.params, [2]);
    assert.deepEqual(first[0]!.params, [1]);
  });

  it("never serves the default projection to an omit, at the client seam", async () => {
    const open = await createWorld();
    world = open;
    // Warm the memo first: the interleaving is what a memo gets wrong.
    await open.client.author.findUnique({ where: { id: 1 } });
    const warm = open.driver.statements.at(-1)!.sql;
    assert.match(warm, /"age"/);

    const hidden = await open.client.author.findUnique({
      where: { id: 1 },
      omit: { age: true },
    });
    const omitted = open.driver.statements.at(-1)!.sql;
    assert.equal(
      /"age"/.test(omitted),
      false,
      "an omit received the shared default projection"
    );
    assert.equal(Object.hasOwn(hidden ?? {}, "age"), false);

    // …and the default is still the default afterwards.
    const again = await open.client.author.findUnique({ where: { id: 1 } });
    assert.match(open.driver.statements.at(-1)!.sql, /"age"/);
    assert.equal((again as { age?: number }).age, 36);
  });
});

describe("review/perf2 — an unfrozen operand still lowers once and the same", () => {
  it("lowers one admitted list identically in every re-reading mode", () => {
    const account = s
      .model({
        id: s.int().id(),
        label: s.string(),
      })
      .map("g4_review_perf2_operands");
    const schema = { account };
    const queries = new Queries(new EngineSchema(schema), new SQLiteAdapter());
    const labels = ["Ada", "Bo", "Cy"];

    const cases: Record<string, unknown> = {
      plain: { label: { in: labels } },
      negated: { label: { notIn: labels } },
      insensitive: { label: { in: labels, mode: "insensitive" } },
      equality: { label: { equals: "Ada", mode: "insensitive" } },
    };

    for (const [name, where] of Object.entries(cases)) {
      const selector = queries.prepareSelector(
        account,
        where as Record<string, unknown>
      );
      const first = queries.lowerSelector(selector, "q0");
      const second = queries.lowerSelector(selector, "q0");
      const third = queries.lowerSelector(selector, "q1");
      assert.ok(first && second && third, `${name} lowered to nothing`);
      assert.equal(
        second.toStatement("?"),
        first.toStatement("?"),
        `${name} drifted when lowered twice`
      );
      assert.deepEqual(second.values, first.values, `${name} rebound values`);
      assert.deepEqual(third.values, first.values, `${name} lost its values`);
      // Lowering consumed nothing: the admitted members are still all there.
      if (name === "plain" || name === "negated" || name === "insensitive")
        assert.equal(
          first.values.length,
          labels.length,
          `${name} lost a member`
        );
    }
  });
});
