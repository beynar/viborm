/**
 * Independent review probe — G4-02 DECISIONS unit, R-D2 (a)/(b)/(c).
 *
 * The decision was "adopt (a)": an exact-decimal primary key under
 * `increment`/`decrement` is the contract, and every OTHER key-update shape
 * reverts to the shipped engine's own sentence. The author's cells pin the
 * three shapes that were recorded as R-D2. This probe asks the question the
 * author did not: is the revert EXACTLY the shipped predicate and nothing
 * wider or narrower, on the shapes nobody pinned?
 *
 * Each row runs the same request on both engines and records the answer AND
 * the table's rows; the cell fails on any divergence that is not the one
 * adopted exception.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const intKey = s
  .model({ id: s.int().id(), label: s.string() })
  .map("g4r2d_int_keys");
const bigKey = s
  .model({ id: s.bigInt().id(), label: s.string() })
  .map("g4r2d_big_keys");
const decKey = s
  .model({ id: s.decimal({ precision: 8, scale: 2 }).id(), label: s.string() })
  .map("g4r2d_dec_keys");
const numKey = s
  .model({ id: s.number().id(), label: s.string() })
  .map("g4r2d_num_keys");
const keySchema = { intKey, bigKey, decKey, numKey };

const SEED = `
  INSERT INTO g4r2d_int_keys (id,label) VALUES (7,'a');
  INSERT INTO g4r2d_big_keys (id,label) VALUES (7,'a');
  INSERT INTO g4r2d_dec_keys (id,label) VALUES ('600','a');
  INSERT INTO g4r2d_num_keys (id,label) VALUES (6.0,'a');
`;

interface Outcome {
  readonly answer: string;
  readonly rows: unknown[];
}

const jsonish = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));

async function run(
  engine: "shipped" | "candidate",
  model: keyof typeof keySchema,
  table: string,
  operation: "update" | "updateMany" | "upsert",
  args: unknown
): Promise<Outcome> {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const client = createClient({ schema: keySchema, driver });
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper called only from cells.
  assert.equal((await syncLiveSchema(client)).applied, true);
  database.exec(SEED);
  const candidate = createCommandEngine({ schema: keySchema, driver });
  let answer: string;
  try {
    const value =
      engine === "shipped"
        ? await (
            client as unknown as Record<
              string,
              Record<string, (args: unknown) => Promise<unknown>>
            >
          )[model]![operation]!(args)
        : await candidate.execute(model, operation, args);
    answer = `ok:${jsonish(value)}`;
  } catch (error) {
    answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
  const rows = database.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  await client.$disconnect();
  database.close();
  return { answer, rows };
}

type Row = readonly [
  name: string,
  model: keyof typeof keySchema,
  table: string,
  operation: "update" | "updateMany" | "upsert",
  args: unknown,
];

/**
 * The one adopted divergence (R-D2 (a)) plus its `decrement` twin. Every other
 * row must agree with the shipped engine byte for byte.
 */
const ADOPTED = new Set([
  "decimal key increment (R-D2 (a), the adopted contract)",
  "decimal key decrement (R-D2 (a), the adopted contract)",
]);

const ROWS: readonly Row[] = [
  // Arity — the shapes the shipped predicate answers with "received …".
  [
    "key update naming NOTHING",
    "intKey",
    "g4r2d_int_keys",
    "update",
    { where: { id: 7 }, data: { id: {} } },
  ],
  [
    "key update naming TWO operators (no set)",
    "intKey",
    "g4r2d_int_keys",
    "update",
    { where: { id: 7 }, data: { id: { increment: 1, decrement: 1 } } },
  ],
  [
    "key update naming THREE operations",
    "intKey",
    "g4r2d_int_keys",
    "update",
    { where: { id: 7 }, data: { id: { set: 9, increment: 1, multiply: 2 } } },
  ],
  [
    "key update naming set beside divide-by-zero",
    "intKey",
    "g4r2d_int_keys",
    "update",
    { where: { id: 7 }, data: { id: { divide: 0, set: 9 } } },
  ],
  [
    "updateMany with set beside an operator",
    "intKey",
    "g4r2d_int_keys",
    "updateMany",
    { where: { id: 7 }, data: { id: { set: 9, increment: 1 } } },
  ],
  [
    "updateMany naming nothing",
    "intKey",
    "g4r2d_int_keys",
    "updateMany",
    { where: { id: 7 }, data: { id: {} } },
  ],
  // `undefined` members are filtered out by both predicates, so this is ONE op.
  [
    "set: undefined beside increment is ONE operation",
    "intKey",
    "g4r2d_int_keys",
    "update",
    { where: { id: 7 }, data: { id: { set: undefined, increment: 1 } } },
  ],
  // A bare value is not a record: neither predicate looks inside it.
  [
    "a bare key value is not an operation record",
    "intKey",
    "g4r2d_int_keys",
    "update",
    { where: { id: 7 }, data: { id: 9 } },
  ],
  // Domains — the portability rule's own question.
  [
    "int key increment stays supported",
    "intKey",
    "g4r2d_int_keys",
    "update",
    { where: { id: 7 }, data: { id: { increment: 1 } } },
  ],
  [
    "bigint key increment stays supported",
    "bigKey",
    "g4r2d_big_keys",
    "update",
    { where: { id: 7 }, data: { id: { increment: 1 } } },
  ],
  [
    "bigint key divide by zero",
    "bigKey",
    "g4r2d_big_keys",
    "update",
    { where: { id: 7 }, data: { id: { divide: 0 } } },
  ],
  [
    "int key divide by zero",
    "intKey",
    "g4r2d_int_keys",
    "update",
    { where: { id: 7 }, data: { id: { divide: 0 } } },
  ],
  [
    "number key multiply (R-D2 (b) family)",
    "numKey",
    "g4r2d_num_keys",
    "update",
    { where: { id: 6 }, data: { id: { multiply: 2 } } },
  ],
  [
    "number key divide (R-D2 (b) family)",
    "numKey",
    "g4r2d_num_keys",
    "update",
    { where: { id: 6 }, data: { id: { divide: 2 } } },
  ],
  [
    "decimal key multiply stays refused",
    "decKey",
    "g4r2d_dec_keys",
    "update",
    { where: { id: "6.00" }, data: { id: { multiply: "2.00" } } },
  ],
  [
    "decimal key divide stays refused",
    "decKey",
    "g4r2d_dec_keys",
    "update",
    { where: { id: "6.00" }, data: { id: { divide: "2.00" } } },
  ],
  [
    "decimal key increment (R-D2 (a), the adopted contract)",
    "decKey",
    "g4r2d_dec_keys",
    "update",
    { where: { id: "6.00" }, data: { id: { increment: "1.00" } } },
  ],
  [
    "decimal key decrement (R-D2 (a), the adopted contract)",
    "decKey",
    "g4r2d_dec_keys",
    "update",
    { where: { id: "6.00" }, data: { id: { decrement: "1.00" } } },
  ],
  // The shipped arm this unit deliberately does not mirror.
  [
    "int key increment by a NON-FINITE operand",
    "intKey",
    "g4r2d_int_keys",
    "update",
    { where: { id: 7 }, data: { id: { increment: Number.POSITIVE_INFINITY } } },
  ],
  [
    "int key multiply by a NON-FINITE operand",
    "intKey",
    "g4r2d_int_keys",
    "update",
    { where: { id: 7 }, data: { id: { multiply: Number.NaN } } },
  ],
  // The root `upsert` arm, with NO relation in the update payload — the place
  // the found-arm channel does not run.
  [
    "upsert (no relations) with set beside an operator",
    "intKey",
    "g4r2d_int_keys",
    "upsert",
    {
      where: { id: 7 },
      create: { id: 7, label: "a" },
      update: { id: { set: 9, increment: 1 } },
    },
  ],
  [
    "upsert (no relations) with a number key increment",
    "numKey",
    "g4r2d_num_keys",
    "upsert",
    {
      where: { id: 6 },
      create: { id: 6, label: "a" },
      update: { id: { increment: 1 } },
    },
  ],
  [
    "upsert (no relations) naming nothing",
    "intKey",
    "g4r2d_int_keys",
    "upsert",
    {
      where: { id: 7 },
      create: { id: 7, label: "a" },
      update: { id: {} },
    },
  ],
];

describe("G4-02 decisions review — the key-update predicate, beyond the pinned shapes", () => {
  it("answers every unpinned key-update shape the way the shipped engine does", async () => {
    const divergences: string[] = [];
    for (const [name, model, table, operation, args] of ROWS) {
      const shipped = await run(engineOf("shipped"), model, table, operation, args);
      const candidate = await run(
        engineOf("candidate"),
        model,
        table,
        operation,
        args
      );
      const same =
        shipped.answer === candidate.answer &&
        jsonish(shipped.rows) === jsonish(candidate.rows);
      // biome-ignore lint/suspicious/noConsole: the probe's output IS its receipt.
      console.log(
        `[${name}]\n  shipped   ${shipped.answer}\n            rows ${jsonish(shipped.rows)}\n  candidate ${candidate.answer}\n            rows ${jsonish(candidate.rows)}\n  ${same ? "AGREE" : ADOPTED.has(name) ? "DIVERGE (adopted)" : "DIVERGE"}`
      );
      if (!same && !ADOPTED.has(name)) divergences.push(name);
      if (same && ADOPTED.has(name)) divergences.push(`${name} — NO LONGER the adopted divergence`);
    }
    assert.deepEqual(divergences, [], "diverging key-update shapes");
  }, 180_000);
});

/** Identity helper so the two calls read symmetrically. */
function engineOf(engine: "shipped" | "candidate"): "shipped" | "candidate" {
  return engine;
}
