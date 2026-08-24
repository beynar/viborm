/**
 * Isolated A/B of the read result parser: fast path (identity decoders +
 * whole-row passthrough) ON vs OFF, over the SAME 1000 synthetic post rows the
 * drizzle-pglite `findMany 1000` bench reads. No DB round trip — this measures
 * exactly what the read fast path changes, free of the round-trip noise that
 * dominates the end-to-end bench.
 *
 * Run: pnpm vitest bench benchmarks/read-fastpath-parse.bench.ts --run
 */
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { ResultParser } from "@query-engine/result/ResultParser";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { resolveSchemaOrThrow } from "@schema/validation/validator";
import { afterAll, bench, describe } from "vitest";

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  content: s.string().nullable(),
  published: s.boolean().default(false),
  views: s.int().default(0),
  authorId: s.string(),
});

const schema = { post };
hydrateSchemaNames(schema);
// The parse boundary reads slot emptiness from the resolved index; this model
// declares no relation, so resolving it is one empty map.
const relations = resolveSchemaOrThrow(schema);

function makeRows(): readonly Readonly<Record<string, unknown>>[] {
  const rows: Record<string, unknown>[] = new Array(1000);
  for (let i = 0; i < 1000; i++) {
    rows[i] = Object.freeze({
      id: `p${i}`,
      title: `Post ${i}`,
      content: `content ${i}`,
      published: i % 2 === 1,
      views: i,
      authorId: `u${i % 100}`,
    });
  }
  return Object.freeze(rows);
}

const immutableRows = makeRows();

// Fast path ON: Postgres declares nativeScalarPassthrough, no driver middleware.
const fastAdapter = new PostgresAdapter();
// Fast path OFF: same passthrough decode, identity shortcut disabled.
const fullAdapter = new PostgresAdapter();
(
  fullAdapter.result as { nativeScalarPassthrough?: boolean }
).nativeScalarPassthrough = false;
let sink = 0;

describe("read result parser: findMany 1000 rows (parse only)", () => {
  bench("fast path ON (identity + whole-row passthrough)", () => {
    const fastParser = new ResultParser(
      { adapter: fastAdapter, relations },
      post
    );
    const rows = fastParser.parse<readonly Record<string, unknown>[]>(
      "findMany",
      immutableRows,
      {}
    );
    sink += rows.length + String(rows[0]?.id).charCodeAt(1);
  });
  bench("fast path OFF (full typed parse)", () => {
    const fullParser = new ResultParser(
      { adapter: fullAdapter, relations },
      post
    );
    const rows = fullParser.parse<readonly Record<string, unknown>[]>(
      "findMany",
      immutableRows,
      {}
    );
    sink += rows.length + String(rows[0]?.id).charCodeAt(1);
  });
});

afterAll(() => {
  if (sink < 0) throw new Error("Unreachable benchmark sink");
});
