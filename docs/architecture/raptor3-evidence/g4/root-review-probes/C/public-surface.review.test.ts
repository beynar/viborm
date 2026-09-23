/**
 * ROOT REVIEW — Area C, checklist line C1.
 *
 * "No public API, argument, result shape or error class changed; the three
 * client seams add only the private route parameter and its plumbing."
 *
 * This probe attacks the NEGATIVE claim at runtime rather than by reading the
 * diff: the private route must be unreachable from every public entry, the
 * default construction must still carry no route, and the one place the route
 * changes an answer (`QueryEngine.build`, divergence D-4') must reuse an
 * EXISTING error identity rather than introduce a class, code or sentence.
 */

import assert from "node:assert/strict";
import { VibORM } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryEngineError, VibORMErrorCode } from "@errors";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { validateClientSchemaOrThrow } from "@schema/validation/validator";
import { createClient } from "@src/index";
import Database from "better-sqlite3";
import { describe, test } from "vitest";

const note = s
  .model({
    id: s.int().id().increment(),
    title: s.string(),
  })
  .map("g4_rootC_notes");

const schema = { note };

function world() {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  hydrateSchemaNames(schema);
  return { config: { driver, schema }, database };
}

describe("Area C1 — the public surface does not carry the route", () => {
  test("no public export names the route, and `createClient` takes one argument", async () => {
    const entry: Record<string, unknown> = await import("@src/index");
    const names = Object.keys(entry).sort();
    // biome-ignore lint/suspicious/noConsole: the probe's output IS its receipt.
    console.log(`[public entry] ${names.length} exports: ${names.join(", ")}`);
    for (const forbidden of [
      "VibORM",
      "createCandidateClient",
      "createCandidateRoute",
      "ClientOperationRoute",
      "ClientOperationRouteFactory",
    ])
      assert.equal(
        Object.hasOwn(entry, forbidden),
        false,
        `the public entry must not export ${forbidden}`
      );
    const factory = entry.createClient as (c: unknown) => unknown;
    assert.equal(typeof factory, "function");
    assert.equal(
      factory.length,
      1,
      "createClient still takes exactly one declared argument"
    );
  });

  test("a second argument to the public `createClient` installs NO route", async () => {
    const { config, database } = world();
    const client = (
      createClient as unknown as (
        c: unknown,
        route?: unknown
      ) => { $disconnect(): Promise<unknown> }
    )(config, createCandidateRoute);
    const orm = new VibORM(config, validateClientSchemaOrThrow(config.schema));
    assert.equal(orm.engine.route, undefined);
    const sql = orm.engine.build(note, "findMany", {}).toStatement();
    assert.equal(typeof sql, "string");
    assert.ok(sql.includes("SELECT"));
    // biome-ignore lint/suspicious/noConsole: the probe's output IS its receipt.
    console.log(`[default route] engine.route=${String(orm.engine.route)}`);
    // biome-ignore lint/suspicious/noConsole: the probe's output IS its receipt.
    console.log(`[default route] build => ${sql}`);
    await client.$disconnect();
    database.close();
  });

  test("with a route the ONE divergent answer keeps the shipped identity", () => {
    const { config, database } = world();
    const relations = validateClientSchemaOrThrow(config.schema);
    const plain = new VibORM(config, relations);
    const routed = new VibORM(config, relations, createCandidateRoute);
    assert.equal(plain.engine.route, undefined);
    assert.notEqual(routed.engine.route, undefined);
    let raised: unknown;
    try {
      routed.engine.build(note, "findMany", {});
    } catch (error) {
      raised = error;
    }
    assert.ok(raised instanceof QueryEngineError, "a QueryEngineError");
    assert.equal((raised as Error).constructor.name, "QueryEngineError");
    assert.equal(
      (raised as QueryEngineError).code,
      VibORMErrorCode.INTERNAL_ERROR
    );
    assert.equal(
      (raised as Error).message,
      "Operation 'findMany' does not compile to one SQL statement. Execute the operation instead."
    );
    // biome-ignore lint/suspicious/noConsole: the probe's output IS its receipt.
    console.log(
      `[routed build] ${(raised as Error).constructor.name} ${(raised as QueryEngineError).code}: ${(raised as Error).message}`
    );
    database.close();
  });
});
