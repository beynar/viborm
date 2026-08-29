import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createOfficialCacheNamespace, generateCacheKey } from "@cache/key";
import { compileCacheResultCodec } from "@query-engine/result/cache-result-codec";
import { parseResult } from "@query-engine/result/ResultParser";
import { buildExpectedResultShape } from "@query-engine/result/result-shape";
import { s } from "@schema";
import {
  indexFor,
  parserFor,
  prepareSchema,
} from "@tests/fixtures/query-scope";
import { createSchemaRegistry } from "@validation";
import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";

/**
 * The decimal's three cache boundaries, which are easy to conflate and behave
 * differently:
 *
 * 1. the SNAPSHOT VALUE — canonical text out, a fresh `Decimal` back on every
 *    hit, because a snapshot is detached and a value object cannot survive a
 *    KV round trip;
 * 2. the SNAPSHOT REVISION — `r3`, byte-pinned, because the stored bytes for a
 *    decimal did not change when they started materializing as a value object,
 *    only their meaning did; and
 * 3. the CACHE KEY — untouched, because the args it hashes are VALIDATED, and
 *    validation emits the same canonical private string for every spelling of
 *    one number, so two callers who spell one filter differently share an entry
 *    instead of splitting it.
 */

const ledger = s
  .model({
    id: s.string().id(),
    amount: s.decimal({ precision: 12, scale: 4 }),
    maybe: s.decimal({ precision: 12, scale: 4 }).nullable(),
  })
  .map("decimal_cache_identity_ledger");

const schema = { ledger };
prepareSchema(schema);
const schemas = createSchemaRegistry(schema);

const READ_ARGS = { select: { id: true, amount: true, maybe: true } };

function codec() {
  const shape = buildExpectedResultShape(
    ledger,
    "findMany",
    READ_ARGS,
    indexFor(ledger)
  );
  if (!shape) throw new Error("the test read has no expected result shape");
  return compileCacheResultCodec(ledger, "findMany", "findMany", shape);
}

/** One read parsed exactly as production parses it, Decimals and all. */
function parsedRows() {
  return parseResult<Record<string, unknown>[]>(
    parserFor(new PostgresAdapter(), ledger),
    "findMany",
    [{ id: "l-1", amount: "1.2000", maybe: null }],
    READ_ARGS
  );
}

function requireDecimal(value: unknown): Decimal {
  if (value instanceof Decimal) return value;
  throw new Error(`expected a Decimal, received ${typeof value}`);
}

function amountOf(rows: unknown): Decimal {
  if (!Array.isArray(rows)) throw new Error("expected a row array");
  const [row] = rows;
  if (typeof row !== "object" || row === null) {
    throw new Error("expected a result row");
  }
  return requireDecimal(Reflect.get(row, "amount"));
}

describe("decimal cache identity", () => {
  test("a snapshot holds canonical text and every hit is a fresh value", () => {
    const cache = codec();
    const stored = JSON.parse(JSON.stringify(cache.snapshot(parsedRows())));

    expect(JSON.stringify(stored)).toContain('"1.2"');

    const first = amountOf(cache.materialize(stored));
    const second = amountOf(cache.materialize(stored));

    expect(first.eq("1.2")).toBe(true);
    expect(first.eq(second)).toBe(true);
    expect(first).not.toBe(second);
  });

  test("a caller who mutates one hit cannot poison the next", () => {
    const cache = codec();
    const stored = JSON.parse(JSON.stringify(cache.snapshot(parsedRows())));

    Object.assign(amountOf(cache.materialize(stored)), { d: [9], e: 3 });

    expect(amountOf(cache.materialize(stored)).eq("1.2")).toBe(true);
  });

  test("a nullable decimal keeps its null across the store", () => {
    const cache = codec();
    const stored = JSON.parse(JSON.stringify(cache.snapshot(parsedRows())));
    const materialized = cache.materialize(stored);
    const [row] = Array.isArray(materialized) ? materialized : [];
    if (typeof row !== "object" || row === null) {
      throw new Error("expected a result row");
    }

    expect(Reflect.get(row, "maybe")).toBeNull();
  });

  test("the official namespace carries the r3 snapshot revision", () => {
    // The bump is the invalidation: an r2 entry stored a decimal's canonical
    // text and handed its caller that string, so it may never be served to a
    // reader that rebuilds a `Decimal` from the same bytes.
    const namespace = createOfficialCacheNamespace({
      dialect: "postgresql",
      namespace: "public",
      version: undefined,
    });

    expect(namespace).toBe(
      "viborm:cache:r3:d:0070006f0073007400670072006500730071006c:k:007000750062006c00690063:u"
    );
  });

  test("two spellings of one decimal filter validate to one cache key", () => {
    // The cache key hashes VALIDATED args (`PendingOperation.cacheKeyArgs`), and
    // validation emits the canonical private string — never a `Decimal`, whose
    // own-property walk would key on decimal.js internals. So the instance a
    // caller happened to spell the filter with cannot split an entry in two.
    const where = schemas.getModelSchemas(ledger).core.where;
    const keyFor = (amount: unknown) => {
      const validated = where["~standard"].validate({ amount });
      if (validated instanceof Promise) {
        throw new Error("validation must be synchronous");
      }
      if (validated.issues) {
        throw new Error(validated.issues[0]?.message ?? "invalid filter");
      }
      return generateCacheKey("ledger", "findMany", {
        where: validated.value,
      });
    };

    const canonical = keyFor("1.2");
    expect(keyFor(new Decimal("1.2"))).toBe(canonical);
    expect(keyFor("1.2000")).toBe(canonical);
    expect(keyFor(1.2)).toBe(canonical);
    expect(keyFor("1.3")).not.toBe(canonical);
  });
});
