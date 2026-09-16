/**
 * INDEPENDENT REVIEW — G4 performance pass 2, item 2 (memoised schema facts).
 *
 * The author's own cells pin two `Queries` over one `EngineSchema`, a second
 * ADAPTER, and a query-level `omit`. These probes attack the three keys the
 * author did NOT separate:
 *
 *  - a second `EngineSchema` over the SAME model objects and the SAME adapter
 *    object (two clients over one schema module is the real deployment shape);
 *  - a second schema whose models carry the same NAMES but different fields —
 *    the memo must not publish one model's field list for another;
 *  - a model-level `.omit()`, which is the one omission that never travels in
 *    the args at all and therefore cannot be desugared into `select`: if the
 *    memo ever captured a pre-omit field list, a hidden column would ship.
 *
 * And the alias question the sharing raises: the SAME frozen projection is now
 * lowered by many statements, so lowering must neither mutate it nor leak an
 * alias into the next statement.
 */

import assert from "node:assert/strict";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import type { Sql } from "@sql";
import { describe, it } from "vitest";

function names(projection: { fields: readonly { name: string }[] }): string[] {
  return projection.fields.map((field) => field.name);
}

/** Two independent schema modules that share nothing but their model NAMES. */
function wideSchema() {
  const account = s
    .model({
      id: s.int().id(),
      email: s.string(),
      secret: s.string(),
    })
    .map("g4_review_perf2_accounts");
  return { account };
}

function narrowSchema() {
  const account = s
    .model({
      id: s.int().id(),
      nickname: s.string(),
    })
    .map("g4_review_perf2_accounts");
  return { account };
}

/** A model whose `.omit()` is SCHEMA truth: it never travels in the args. */
function hiddenSchema() {
  const person = s
    .model({
      id: s.int().id(),
      name: s.string(),
      passwordHash: s.string(),
    })
    .omit({ passwordHash: true })
    .map("g4_review_perf2_people");
  return { person };
}

describe("review/perf2 — what the (adapter, model) memo may not share", () => {
  it("does not let a second EngineSchema read the first one's memo", () => {
    const schema = wideSchema();
    // The deployment shape the author did not separate: one adapter object and
    // one set of model objects, two engines over them.
    const adapter = new SQLiteAdapter();
    const first = new Queries(new EngineSchema(schema), adapter);
    const second = new Queries(new EngineSchema(schema), adapter);

    const mine = first.prepareProjection(schema.account, {});
    const theirs = second.prepareProjection(schema.account, {});
    assert.notEqual(
      mine,
      theirs,
      "a second EngineSchema over the same adapter read the first one's memo"
    );
    assert.deepEqual(names(mine), names(theirs));
    assert.deepEqual(names(mine), ["id", "email", "secret"]);

    // Within each engine the memo still holds.
    assert.equal(first.prepareProjection(schema.account, {}), mine);
    assert.equal(second.prepareProjection(schema.account, {}), theirs);
  });

  it("never publishes one schema's field list for a same-named model of another", () => {
    const wide = wideSchema();
    const narrow = narrowSchema();
    const adapter = new SQLiteAdapter();
    // One EngineSchema per client, as the engine factories build them, but the
    // WORST case for the memo: the same adapter object for both.
    const wideQueries = new Queries(new EngineSchema(wide), adapter);
    const narrowQueries = new Queries(new EngineSchema(narrow), adapter);

    assert.deepEqual(names(wideQueries.prepareProjection(wide.account, {})), [
      "id",
      "email",
      "secret",
    ]);
    assert.deepEqual(
      names(narrowQueries.prepareProjection(narrow.account, {})),
      ["id", "nickname"]
    );
    // …and again, in the other order, after both memos are warm.
    assert.deepEqual(
      names(narrowQueries.prepareProjection(narrow.account, {})),
      ["id", "nickname"]
    );
    assert.deepEqual(names(wideQueries.prepareProjection(wide.account, {})), [
      "id",
      "email",
      "secret",
    ]);
  });

  it("keeps a model-level .omit() out of the shared default projection", () => {
    const schema = hiddenSchema();
    const queries = new Queries(new EngineSchema(schema), new SQLiteAdapter());
    const first = queries.prepareProjection(schema.person, {});
    assert.deepEqual(names(first), ["id", "name"]);
    // The memo must answer the SAME hidden-column-free projection every time.
    const second = queries.prepareProjection(schema.person, {});
    assert.equal(second, first);
    assert.deepEqual(names(second), ["id", "name"]);
    assert.equal(
      names(second).includes("passwordHash"),
      false,
      "a model-level .omit()-ed column reached the shared default projection"
    );
    assert.equal(
      JSON.stringify(Object.keys(first.shape.fields)),
      JSON.stringify(["id", "name"])
    );
  });

  it("lowers one shared projection under many aliases without mutating it", () => {
    const schema = wideSchema();
    const queries = new Queries(new EngineSchema(schema), new SQLiteAdapter());
    const shared = queries.prepareProjection(schema.account, {});
    const snapshot = JSON.stringify(names(shared));

    const zero = queries.lowerProjection(shared, "q0");
    const one = queries.lowerProjection(shared, "q1");
    const zeroAgain = queries.lowerProjection(shared, "q0");

    const text = (lowered: { readonly columns: readonly Sql[] }) =>
      lowered.columns.map((column) => column.toStatement("?")).join(", ");

    assert.notEqual(text(zero), text(one), "the alias did not reach the SQL");
    assert.equal(
      text(zeroAgain),
      text(zero),
      "lowering the shared projection twice under one alias drifted"
    );
    assert.match(text(zero), /"q0"/);
    assert.doesNotMatch(text(zero), /"q1"/);
    // The shared value itself is untouched, and is still the memo's answer.
    assert.equal(JSON.stringify(names(shared)), snapshot);
    assert.equal(queries.prepareProjection(schema.account, {}), shared);
  });

  it("gives two dialects their own leaf for the same field", () => {
    const schema = wideSchema();
    const engine = new EngineSchema(schema);
    const sqlite = new Queries(engine, new SQLiteAdapter());
    const postgres = new Queries(engine, new PostgresAdapter());
    const mine = sqlite.prepareProjection(schema.account, {});
    const theirs = postgres.prepareProjection(schema.account, {});
    assert.notEqual(mine, theirs, "two dialects shared one projection");
    assert.notEqual(
      mine.shape.fields.email,
      theirs.shape.fields.email,
      "two dialects shared one leaf"
    );
    assert.deepEqual(names(mine), names(theirs));
  });
});
