/**
 * G4 performance pass 2, item 2 — an immutable schema fact is resolved once.
 *
 * `Queries.prepareProjection` rebuilt the model's DEFAULT projection on every
 * read: `Object.fromEntries(scalarFieldNames.filter(…).map(…))`, then a fresh
 * frozen descriptor and a fresh frozen leaf per field, on an input that names
 * neither `select` nor `include` and therefore depends on nothing but the model
 * and the dialect (`g4/perf2/note.md` §0.4, rows 1 and 3). It is now memoised
 * per (adapter, model), and each scalar leaf per (adapter, model, field).
 *
 * A memo is only as good as what it refuses to hold, so these cells pin the
 * refusals, not the speed:
 *
 * - an operation that names `select`, `include` or `omit` still prepares its
 *   own projection, and never receives — or replaces — the shared one. `omit`
 *   is the load-bearing case, because the memo's whole safety argument is that
 *   admission desugars an operation-level `omit` into `select` before the
 *   projection owner ever sees it (rule 5: capture is not permanent truth);
 * - a second ADAPTER does not read the first adapter's memo, which is why the
 *   store is keyed by the adapter at all: a leaf carries the adapter's own
 *   `dateTime` representation;
 * - what is shared holds no alias and no `Sql` — a memo that captured a
 *   statement-local alias would publish one operation's alias in another's SQL.
 *
 * Not registered in `scripts/raptor3-manifest.mjs` by this pass (it edits no
 * manifest); the count is reported to the integrator for `g4-unit02-author`.
 */

import assert from "node:assert/strict";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { Sql } from "@sql";
import { describe, it } from "vitest";

function reuseSchema() {
  const author = s
    .model({
      id: s.int().id(),
      name: s.string(),
      secret: s.string(),
      posts: s.toMany(() => post).name("authored"),
    })
    .map("g4_perf2_reuse_authors");
  const post = s
    .model({
      id: s.int().id(),
      title: s.string(),
      authorId: s.int().map("author_id"),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id")
        .name("authored"),
    })
    .map("g4_perf2_reuse_posts");
  return { author, post };
}

/** Every field name the prepared projection publishes, in its own order. */
function names(projection: { fields: readonly { name: string }[] }): string[] {
  return projection.fields.map((field) => field.name);
}

/** Whether any alias or lowered SQL is reachable from a value that is shared. */
function holdsSql(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value instanceof Sql) return true;
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  for (const key of Reflect.ownKeys(value))
    if (holdsSql(Reflect.get(value, key), seen)) return true;
  return false;
}

describe("G4 perf pass 2 item 2 — one default projection per (adapter, model)", () => {
  it("answers the same projection for every operation that names no selection", () => {
    const schema = reuseSchema();
    const engine = new EngineSchema(schema);
    const adapter = new SQLiteAdapter();
    const first = new Queries(engine, adapter);
    const second = new Queries(engine, adapter);

    const one = first.prepareProjection(schema.author, {});
    const two = first.prepareProjection(schema.author, { where: { id: 1 } });
    const three = second.prepareProjection(schema.author, {});

    assert.equal(one, two, "two default projections of one model differ");
    assert.equal(
      one,
      three,
      "a second Queries over the same schema and adapter rebuilt the default"
    );
    assert.deepEqual(names(one), ["id", "name", "secret"]);
    assert.equal(Object.isFrozen(one), true);
    assert.equal(Object.isFrozen(one.fields), true);
    assert.equal(Object.isFrozen(one.shape), true);
    assert.equal(holdsSql(one), false, "a shared projection retained lowered SQL");

    // And a different MODEL of the same schema gets its own, not this one.
    const other = first.prepareProjection(schema.post, {});
    assert.notEqual(other, one);
    assert.deepEqual(names(other), ["id", "title", "authorId"]);
  });

  it("never hands the shared projection to an operation that names a selection", () => {
    const schema = reuseSchema();
    const queries = new Queries(new EngineSchema(schema), new SQLiteAdapter());
    const shared = queries.prepareProjection(schema.author, {});

    const selected = queries.prepareProjection(schema.author, {
      select: { id: true, name: true },
    });
    assert.notEqual(selected, shared);
    assert.deepEqual(names(selected), ["id", "name"]);

    const included = queries.prepareProjection(schema.author, {
      include: { posts: true },
    });
    assert.notEqual(included, shared);
    assert.deepEqual(names(included), ["id", "name", "secret", "posts"]);

    // Neither replaced the shared one, and neither is remembered itself.
    assert.equal(queries.prepareProjection(schema.author, {}), shared);
    assert.notEqual(
      queries.prepareProjection(schema.author, {
        select: { id: true, name: true },
      }),
      selected
    );
  });

  it("refuses the shared projection to an omit, because admission desugared it", () => {
    const schema = reuseSchema();
    const engine = new EngineSchema(schema);
    const queries = new Queries(engine, new SQLiteAdapter());
    const shared = queries.prepareProjection(schema.author, {});

    const admitted = engine.admit(schema.author, "findMany", {
      omit: { secret: true },
    });
    assert.notEqual(
      admitted.select,
      undefined,
      "admission no longer desugars omit into select, which the memo relies on"
    );

    const omitted = queries.prepareProjection(schema.author, admitted);
    assert.notEqual(omitted, shared, "an omit received the default projection");
    assert.deepEqual(names(omitted), ["id", "name"]);
    assert.deepEqual(names(queries.prepareProjection(schema.author, {})), [
      "id",
      "name",
      "secret",
    ]);
  });

  it("keys the store by the adapter, and one leaf per (adapter, model, field)", () => {
    const schema = reuseSchema();
    const engine = new EngineSchema(schema);
    const sqlite = new Queries(engine, new SQLiteAdapter());
    const other = new Queries(engine, new SQLiteAdapter());

    const mine = sqlite.prepareProjection(schema.author, {});
    const theirs = other.prepareProjection(schema.author, {});
    assert.notEqual(mine, theirs, "a second adapter read the first one's memo");
    assert.deepEqual(names(mine), names(theirs));

    // One leaf per field, shared by every projection of that adapter.
    const selected = sqlite.prepareProjection(schema.author, {
      select: { name: true },
    });
    assert.equal(
      selected.shape.fields.name,
      mine.shape.fields.name,
      "the same field's leaf was rebuilt for a selected projection"
    );
    assert.notEqual(
      theirs.shape.fields.name,
      mine.shape.fields.name,
      "two adapters shared one leaf"
    );
  });
});

/**
 * G4 performance pass 2, item 4 — the prepared predicate is frozen; each of its
 * operands is not.
 *
 * `prepareOperand` froze one box per admitted member, so an
 * `id: { in: ids₁₀₀ }` paid 100 `Object.freeze` map transitions per operation
 * — measured at 1.98–2.20 µs against 0.25–0.28 µs for the same 100 boxes
 * (`g4/perf2/receipts/micro-in-list.json`), which is `prepareOperand`'s whole
 * measured self time on `bulk-update-returning-100/prepare`. One owner builds
 * an operand (`Queries.prepareOperations`) and one reads it
 * (`Queries.lowerOperation`), both inside `shared/query.ts`, and no cell of
 * this harness ever observed a prepared operand's frozen-ness; the immutability
 * that IS observable — the predicate and the operand list — stays.
 */
/** The prepared predicate type, read from the one owner that publishes it. */
type PreparedPredicate = NonNullable<
  ReturnType<Queries["prepareSelector"]>["predicate"]
>;

/** The one `in` operation of a prepared predicate tree, wherever it sits. */
function findIn(
  predicate: PreparedPredicate | undefined
): Extract<PreparedPredicate, { kind: "operation" }> | undefined {
  if (!predicate) return undefined;
  if (predicate.kind === "operation")
    return predicate.operator === "in" ? predicate : undefined;
  if (predicate.kind === "and" || predicate.kind === "or") {
    for (const member of predicate.predicates) {
      const found = findIn(member);
      if (found) return found;
    }
  }
  if (predicate.kind === "not") return findIn(predicate.predicate);
  return undefined;
}

describe("G4 perf pass 2 item 4 — one freeze per predicate, not per member", () => {
  it("freezes the predicate and its operand list, and binds every member once", () => {
    const schema = reuseSchema();
    const queries = new Queries(new EngineSchema(schema), new SQLiteAdapter());
    const ids = Array.from({ length: 8 }, (_, index) => index + 1);
    const selector = queries.prepareSelector(schema.author, {
      id: { in: ids },
    });

    const conjunction = selector.predicate;
    assert.ok(conjunction && conjunction.kind === "and");
    assert.equal(Object.isFrozen(conjunction), true);
    assert.equal(Object.isFrozen(conjunction.predicates), true);
    const operation = findIn(conjunction);
    assert.ok(operation, "the prepared selector carries no `in` operation");
    assert.equal(Object.isFrozen(operation), true);
    assert.ok(operation.operands);
    assert.equal(Object.isFrozen(operation.operands), true);
    assert.deepEqual(
      operation.operands.map((operand) =>
        operand.kind === "value" ? operand.value : "field"
      ),
      ids
    );

    // The one thing a consumer can see: the same selector lowers to the same
    // statement and the same parameters, twice.
    const first = queries.lowerSelector(selector, "q0");
    const second = queries.lowerSelector(selector, "q0");
    assert.ok(first && second);
    assert.equal(first.toStatement("?"), second.toStatement("?"));
    assert.deepEqual(first.values, ids);
    assert.deepEqual(second.values, ids);
  });
});
