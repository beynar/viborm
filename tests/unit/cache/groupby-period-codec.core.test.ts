/**
 * The cache codec of a `groupBy` by a time step. The period leaf has no
 * declaring scalar (the column is a date or a dateTime, the period neither's
 * value), so the codec composes the period's own: the ISO day string the
 * decoder published, a nullable column's `null` included.
 */

// The route's cache codec belongs to the cache runtime `viborm/cache` loads.
import { routedCodec } from "@cache/result-codec";
import "@cache/runtime";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { CacheConfigurationError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { hydrateSchemaNames, s } from "@schema";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { expect, test } from "vitest";

const facture = s.model({
  id: s.int().id(),
  date: s.dateTime(),
  dueAt: s.dateTime().nullable(),
});
const schema = { facture };
hydrateSchemaNames(schema);

test("a period round-trips as its day; anything else is refused", () => {
  const route = createCommandEngine({
    schema,
    driver: new SqlOnlyDriver(new PostgresAdapter(), "postgresql"),
  });
  const codec = routedCodec(
    route.prepare("facture", "groupBy", {
      by: [{ date: "month" }, { dueAt: "week" }],
      _count: true,
    })
  );
  const rows = [
    { date: "2026-01-01", dueAt: null, _count: 2 },
    { date: "0000-01-01", dueAt: "-0001-12-27", _count: 1 },
  ];
  expect(codec.materialize(codec.snapshot(rows))).toEqual(rows);
  expect(() =>
    codec.snapshot([{ date: new Date(0), dueAt: null, _count: 1 }])
  ).toThrow(CacheConfigurationError);
});
