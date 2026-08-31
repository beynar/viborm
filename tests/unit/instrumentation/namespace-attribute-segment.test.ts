import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import {
  ATTR_DB_NAMESPACE,
  ATTR_DB_SYSTEM,
  ATTR_VIBORM_WRITE_ATOMICITY,
  SPAN_OPERATION,
  SPAN_RECORD_SERIES_SEGMENT,
} from "@instrumentation/spans";
import { s } from "@schema";
import { instrumentation } from "@src/instrumentation/exports";
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

let recorder: OtelRecorder;
let database: PGlite;

beforeAll(async () => {
  recorder = withOtelRecorder();
  database = new PGlite();
  await database.exec('CREATE SCHEMA "billing"');
  await database.exec(
    'CREATE TABLE "billing"."ns_series_accounts" ("id" TEXT PRIMARY KEY, "label" TEXT NOT NULL)'
  );
  await database.exec(
    'CREATE TABLE "billing"."ns_series_notes" ("id" TEXT PRIMARY KEY, "body" TEXT NOT NULL, "seriesAccountId" TEXT NOT NULL)'
  );
});

afterAll(async () => {
  await recorder.dispose();
  await database.close();
});

test("progressive segment spans carry no database namespace", async () => {
  const driver = new BatchOnlySegmentDriver({
    client: database,
    namespace: "billing",
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
  expect(operation?.attributes[ATTR_DB_NAMESPACE]).toBe("billing");

  const segments = spans.filter(
    (span) => span.name === SPAN_RECORD_SERIES_SEGMENT
  );
  expect(segments.length).toBeGreaterThan(0);
  for (const span of segments) {
    expect(span.attributes[ATTR_VIBORM_WRITE_ATOMICITY]).toBe("segment");
    expect(Object.hasOwn(span.attributes, ATTR_DB_SYSTEM)).toBe(false);
    expect(Object.hasOwn(span.attributes, ATTR_DB_NAMESPACE)).toBe(false);
  }

  // The transport is supplied; the suite owns it and closes it in afterAll.
  await client.$disconnect();
});
