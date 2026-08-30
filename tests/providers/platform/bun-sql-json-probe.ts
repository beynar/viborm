/**
 * Real-runtime JSON probe for Bun SQL.
 *
 * Vitest owns discovery and reporting, but Bun owns this process so the probe
 * crosses the real `SQL` transport — which is the whole point: Bun JSON-ENCODES
 * a string bound to a `json`/`jsonb` parameter, so the canonical JSON text the
 * PostgreSQL adapter used to bind was stored as the physical document
 * `"[1,2,3]"` rather than `[1,2,3]` (upstream Drizzle #5287). Only a live
 * server can show that, and only `jsonb_typeof` can tell the two apart: both
 * spellings read back as JSON, and the broken one reads back as a string that
 * happens to look like the document.
 *
 * It uses the repository's existing `PG_TEST_CONNECTION_STRING` convention and
 * an isolated PostgreSQL schema.
 */

import { createClient } from "@client/client";
import { BunSQLDriver } from "@drivers/bun-sql";
import { JsonNull, s } from "@schema";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import type { InputJsonValue } from "@validation";

const databaseUrl = process.env.PG_TEST_CONNECTION_STRING;
if (!databaseUrl) {
  throw new Error(
    "PG_TEST_CONNECTION_STRING is required for the Bun SQL JSON probe"
  );
}

const PROBE_NAMESPACE = "viborm_bun_sql_json_probe";
const PROBE_TABLE = "bun_sql_runtime_json";

/**
 * Every JSON type, because Bun cannot express three of them as a bare
 * JavaScript value at all: a number binds as `integer` and a boolean as
 * `boolean` (both refused by a `jsonb` column), and `null` binds as SQL NULL
 * rather than the JSON null.
 */
const JSON_CASES: ReadonlyArray<readonly [string, InputJsonValue, string]> = [
  ["object", { nested: { value: 123 } }, "object"],
  ["array", [1, 2, 3], "array"],
  ["string", "plain json string primitive", "string"],
  ["number", 42, "number"],
  ["boolean", true, "boolean"],
];

const jsonEvidence = s
  .model({
    id: s.string().id(),
    data: s.json(),
  })
  .map(PROBE_TABLE);

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function recreateProbeNamespace(): Promise<void> {
  const driver = new BunSQLDriver({ databaseUrl });
  try {
    await driver._executeRaw(
      `DROP SCHEMA IF EXISTS "${PROBE_NAMESPACE}" CASCADE`
    );
    await driver._executeRaw(`CREATE SCHEMA "${PROBE_NAMESPACE}"`);
  } finally {
    await driver._disconnect();
  }
}

async function removeProbeNamespace(): Promise<void> {
  const driver = new BunSQLDriver({ databaseUrl });
  try {
    await driver._executeRaw(
      `DROP SCHEMA IF EXISTS "${PROBE_NAMESPACE}" CASCADE`
    );
  } finally {
    await driver._disconnect();
  }
}

await recreateProbeNamespace();

const client = createClient({
  schema: { jsonEvidence },
  driver: new BunSQLDriver({ databaseUrl, namespace: PROBE_NAMESPACE }),
});

try {
  await push(client, { force: true });

  for (const [id, value] of JSON_CASES) {
    const created = await client.jsonEvidence.create({
      data: { id, data: value },
    });
    assert(
      same(created.data, value),
      `create ${id} returned ${JSON.stringify(created.data)}, expected ${JSON.stringify(value)}`
    );

    const read = await client.jsonEvidence.findUniqueOrThrow({ where: { id } });
    assert(
      same(read.data, value),
      `read ${id} returned ${JSON.stringify(read.data)}, expected ${JSON.stringify(value)}`
    );

    const matched = await client.jsonEvidence.findMany({
      where: { data: { equals: value } },
      select: { id: true },
    });
    assert(
      matched.length === 1 && matched[0]?.id === id,
      `filter ${id} matched ${JSON.stringify(matched)}, expected exactly ${id}`
    );
  }

  // `update` and the prepared/batched paths bind the same parameter through a
  // different compiler and a different driver seam (`_prepare`, not
  // `_execute`), so each one carries the document or none of them do.
  const rewritten = await client.jsonEvidence.update({
    where: { id: "object" },
    data: { data: { nested: { value: 456 } } },
  });
  assert(
    same(rewritten.data, { nested: { value: 456 } }),
    `update returned ${JSON.stringify(rewritten.data)}, expected {"nested":{"value":456}}`
  );

  await client.jsonEvidence.createMany({
    data: [
      { id: "batched-object", data: { batched: true } },
      { id: "batched-array", data: ["batched"] },
    ],
  });
  const [batchedObject, batchedArray] = await client.$transaction([
    client.jsonEvidence.findUniqueOrThrow({ where: { id: "batched-object" } }),
    client.jsonEvidence.findUniqueOrThrow({ where: { id: "batched-array" } }),
  ]);
  assert(
    same(batchedObject.data, { batched: true }) &&
      same(batchedArray.data, ["batched"]),
    `batched writes returned ${JSON.stringify([batchedObject.data, batchedArray.data])}`
  );

  const jsonNullRow = await client.jsonEvidence.create({
    data: { id: "json-null", data: JsonNull },
  });
  assert(
    jsonNullRow.data === null,
    `create json-null returned ${JSON.stringify(jsonNullRow.data)}, expected null`
  );
  const jsonNullMatches = await client.jsonEvidence.findMany({
    where: { data: { equals: JsonNull } },
    select: { id: true },
  });
  assert(
    jsonNullMatches.length === 1 && jsonNullMatches[0]?.id === "json-null",
    `JsonNull filter matched ${JSON.stringify(jsonNullMatches)}, expected exactly json-null`
  );

  // The physical document, which is the only place the defect was visible: a
  // double-encoded write reads back as JSON but stores `jsonb_typeof = string`.
  const physical = await client.$queryRawUnsafe<{
    id: string;
    jsonType: string | null;
    columnType: string;
  }>(
    `SELECT id, jsonb_typeof(data) AS "jsonType", pg_typeof(data)::text AS "columnType" FROM "${PROBE_NAMESPACE}"."${PROBE_TABLE}" ORDER BY id`
  );
  const expectedTypes = [
    ...JSON_CASES.map(([id, , jsonType]) => [id, jsonType]),
    ["batched-array", "array"],
    ["batched-object", "object"],
    ["json-null", "null"],
  ].sort(([left], [right]) => (String(left) < String(right) ? -1 : 1));
  assert(
    same(
      physical.map((row) => [row.id, row.jsonType]),
      expectedTypes
    ),
    `physical jsonb_typeof gave ${JSON.stringify(physical)}, expected ${JSON.stringify(expectedTypes)}`
  );
  assert(
    physical.every((row) => row.columnType === "jsonb"),
    `physical column type gave ${JSON.stringify(physical)}, expected jsonb`
  );

  console.log("bun-sql json evidence passed");
} finally {
  try {
    await client.$disconnect();
  } finally {
    await removeProbeNamespace();
  }
}
