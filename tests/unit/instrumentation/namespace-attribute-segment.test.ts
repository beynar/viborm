import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import {
  ATTR_DB_NAMESPACE,
  ATTR_DB_SYSTEM,
  ATTR_VIBORM_WRITE_ATOMICITY,
  SPAN_EXECUTE,
  SPAN_OPERATION,
  SPAN_RECORD_SERIES_SEGMENT,
} from "@instrumentation/spans";
import { s } from "@schema";
import { instrumentation } from "@src/instrumentation/exports";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import {
  type OtelRecorder,
  withOtelRecorder,
} from "@tests/unit/instrumentation/_capture";
import { afterAll, beforeAll, expect, test } from "vitest";

const seriesAccount = s
  .model({
    id: s.string().id(),
    label: s.string(),
    notes: s.toMany(() => seriesNote),
  })
  .map("ns_series_accounts");
const seriesNote = s
  .model({
    id: s.string().id(),
    body: s.string(),
    seriesAccountId: s.string(),
    account: s
      .toOne(() => seriesAccount)
      .fields("seriesAccountId")
      .references("id"),
  })
  .map("ns_series_notes");
const seriesSchema = { seriesAccount, seriesNote };

class BatchOnlySegmentDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

/**
 * The database is the worker's ONE PGlite and this suite takes only a private
 * schema in it. The suite still writes its own two tables, so the family is
 * given no models of its own; every statement below names `family.namespace`,
 * because raw SQL is sent verbatim and the driver rewrites only the ORM's.
 */
const getFamily = usePGliteSchemaFamily({});

let recorder: OtelRecorder;

beforeAll(async () => {
  recorder = withOtelRecorder();
  const { database, namespace } = getFamily();
  await database.exec(
    `CREATE TABLE "${namespace}"."ns_series_accounts" ("id" TEXT PRIMARY KEY, "label" TEXT NOT NULL)`
  );
  await database.exec(
    `CREATE TABLE "${namespace}"."ns_series_notes" ("id" TEXT PRIMARY KEY, "body" TEXT NOT NULL, "seriesAccountId" TEXT NOT NULL)`
  );
});

afterAll(async () => {
  await recorder.dispose();
});

test("progressive segment spans are gone, and every unit this write emits names the namespace", async () => {
  const family = getFamily();
  const driver = new BatchOnlySegmentDriver({
    client: family.database,
    namespace: family.namespace,
  });
  const client = createClient({ schema: seriesSchema, driver }).$extends(
    instrumentation({ tracing: true })
  );
  const from = recorder.spans().length;

  await client.seriesAccount.createMany({
    data: [
      {
        id: "a1",
        label: "one",
        notes: { create: [{ id: "n1", body: "b" }] },
      },
      {
        id: "a2",
        label: "two",
        notes: { create: [{ id: "n2", body: "c" }] },
      },
    ],
  });

  const spans = recorder.spans().slice(from);
  const operation = spans.find((span) => span.name === SPAN_OPERATION);
  expect(operation?.attributes[ATTR_DB_NAMESPACE]).toBe(family.namespace);

  // D-15 retired the V1 write-engine, which owned the ONLY emitter of
  // SPAN_RECORD_SERIES_SEGMENT: the shipped engine keeps the committed-segment
  // fact as `recordSeriesProgress` error metadata, never as a span, so the unit
  // that carried `viborm.write.*` and no `db.*` no longer exists. What a
  // progressive write emits is the operation unit and its statement units, and
  // `getBaseAttributes` (drivers/driver-instrumentation.ts) gives EVERY one of
  // them the namespace.
  expect(
    spans.filter((span) => span.name === SPAN_RECORD_SERIES_SEGMENT)
  ).toEqual([]);
  const statements = spans.filter((span) => span.name === SPAN_EXECUTE);
  expect(statements.length).toBeGreaterThan(1);
  expect(spans.length).toBe(statements.length + 1);
  for (const span of spans) {
    expect(span.attributes[ATTR_DB_NAMESPACE]).toBe(family.namespace);
    expect(span.attributes[ATTR_DB_SYSTEM]).toBe("postgresql");
    expect(Object.hasOwn(span.attributes, ATTR_VIBORM_WRITE_ATOMICITY)).toBe(
      false
    );
  }

  // The transport is supplied by the shared family, which owns its lifecycle:
  // disconnecting this client releases the driver, never the worker database.
  await client.$disconnect();
});
