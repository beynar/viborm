/**
 * G4 C13 falsifiers — observation lifecycle (LX-13, LX-14, LX-15).
 *
 * Each test runs its oracle twice against the SHIPPED route first: once
 * normally, to show the oracle observes a complete lifecycle, and once with a
 * deliberately crippled recorder, to show the oracle actually fails when an
 * event is missing. Only then does it run the same oracle through the private
 * candidate route, which is the C13 claim and is red until G4-03 lands the
 * seam named in `route-contract.ts`.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  createRoutedClient,
  lifecycleRecorder,
  missingUnits,
  REQUIRED_READ_UNITS,
} from "./route-contract";

const LIFECYCLE_TABLE = "g4_lifecycle_records";

function lifecycleSchema() {
  const record = s
    .model({
      id: s.int().id(),
      label: s.string().map("record_label"),
      score: s.int().map("record_score"),
    })
    .map(LIFECYCLE_TABLE);
  return { record };
}

type AnyClient = {
  $extends(definition: unknown): AnyClient;
  $disconnect(): Promise<unknown>;
} & Record<string, { findMany(args?: unknown): Promise<unknown> }>;

describe("G4 C13 lifecycle observation falsifiers", () => {
  let database: Database.Database;
  let driver: SQLite3Driver;
  let shipped: AnyClient;

  beforeEach(async () => {
    database = new Database(":memory:");
    driver = new SQLite3Driver({ client: database });
    shipped = createClient({
      schema: lifecycleSchema(),
      driver,
    }) as unknown as AnyClient;
    const migration = await syncLiveSchema(shipped as never);
    assert.equal(migration.applied, true);
    database.exec(
      `INSERT INTO ${LIFECYCLE_TABLE} (id, record_label, record_score) VALUES (1,'one',10),(2,'two',20)`
    );
  });

  afterEach(async () => {
    await shipped?.$disconnect();
    database?.close();
  });

  it("C13 missing-event: one model read publishes every required lifecycle unit", async () => {
    const complete = lifecycleRecorder();
    const observed = shipped.$extends(complete.extension);
    await observed.record?.findMany({ where: { score: { gte: 10 } } });
    await complete.settle();
    assert.deepEqual(
      missingUnits(complete.units),
      [],
      `the shipped route published ${JSON.stringify(complete.units)}`
    );

    // Falsify the oracle: a recorder that loses the statement unit must be
    // detected, otherwise a silent candidate omission would pass too.
    const crippled = lifecycleRecorder("statement");
    const blind = shipped.$extends(crippled.extension);
    await blind.record?.findMany({ where: { score: { gte: 10 } } });
    await crippled.settle();
    assert.deepEqual(missingUnits(crippled.units), ["statement"]);

    const routedRecorder = lifecycleRecorder();
    const routed = createRoutedClient({
      schema: lifecycleSchema(),
      driver,
    }) as unknown as AnyClient;
    const routedObserved = routed.$extends(routedRecorder.extension);
    await routedObserved.record?.findMany({ where: { score: { gte: 10 } } });
    await routedRecorder.settle();
    assert.deepEqual(
      missingUnits(routedRecorder.units),
      [],
      "the candidate route lost a required lifecycle unit"
    );
    await routed.$disconnect();
  });

  it("C13 observer-failure-isolation: a throwing observer never changes the outcome", async () => {
    const failures: unknown[] = [];
    const hostile = {
      name: "g4-hostile-observer",
      observe(_unit: unknown, proceed: () => Promise<unknown>) {
        proceed().catch((failure: unknown) => failures.push(failure));
        throw new Error("observer failure must stay inside the observer");
      },
    };
    const control = await shipped.record?.findMany({ orderBy: { id: "asc" } });
    const observed = await shipped
      .$extends(hostile)
      .record?.findMany({ orderBy: { id: "asc" } });
    assert.deepStrictEqual(observed, control);
    assert.deepEqual(failures, []);

    const routed = createRoutedClient({
      schema: lifecycleSchema(),
      driver,
    }) as unknown as AnyClient;
    const routedControl = await routed.record?.findMany({
      orderBy: { id: "asc" },
    });
    const routedObserved = await routed
      .$extends(hostile)
      .record?.findMany({ orderBy: { id: "asc" } });
    assert.deepStrictEqual(routedObserved, routedControl);
    await routed.$disconnect();
  });

  it("C13 statement observation covers the physical statements of one operation", async () => {
    const recorder = lifecycleRecorder();
    const observed = shipped.$extends(recorder.extension);
    await observed.record?.findMany({ orderBy: { id: "asc" } });
    await recorder.settle();
    const statements = recorder.units.filter(
      (unit) => unit.kind === "statement"
    );
    assert.ok(
      statements.length >= 1,
      `a model read must publish at least one statement unit, saw ${JSON.stringify(recorder.units)}`
    );
    for (const unit of recorder.units) {
      assert.notEqual(unit.status, "unknown", JSON.stringify(unit));
    }
    assert.deepEqual([...REQUIRED_READ_UNITS].sort(), ["operation", "statement"]);

    const routedRecorder = lifecycleRecorder();
    const routed = createRoutedClient({
      schema: lifecycleSchema(),
      driver,
    }) as unknown as AnyClient;
    await routed
      .$extends(routedRecorder.extension)
      .record?.findMany({ orderBy: { id: "asc" } });
    await routedRecorder.settle();
    assert.ok(
      routedRecorder.units.some((unit) => unit.kind === "statement"),
      "the candidate route published no statement unit"
    );
    await routed.$disconnect();
  });
});
