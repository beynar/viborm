/**
 * G4-02 author check (repair round 3) — the symbolic updated-key expression and
 * the row key's portability contract.
 *
 * Two facts the phase-2 round left unpinned, both raised by the independent
 * review of that round (findings 1 and 2):
 *
 * 1. `Queries.updateValue` must NAME the value a key will carry for every
 *    operator its assignment accepts, because the non-RETURNING readback and
 *    every dependent's key transition address the row by that name. MySQL is
 *    the project's only `supportsReturning: false` adapter, so the refusal that
 *    landed in phase 2 was live for an ordinary request. The cells below run on
 *    a SQLite driver with `supportsReturning` forced off — MySQL's capability,
 *    credential-free — and compare the candidate to the shipped engine.
 *    `native-key-arithmetic.test.ts` runs the same comparison on real MySQL,
 *    whose `/` is the reason the integer quotient needed an adapter seam.
 * 2. Implementing `multiply`/`divide` brought the shipped engine's key
 *    portability contract within reach for the first time. The candidate now
 *    states the two refusals that cover THOSE operators, in the shipped
 *    engine's own sentences, where the shipped engine states them: at
 *    admission for `update`/`updateMany` (`EngineSchema.admit`), and on the
 *    found arm of a relation-bearing `upsert`, which
 *    `upsert-key-portability.test.ts` measures (note §R3.1).
 *
 * Three shapes of that family were recorded as R-D2 and DECIDED by Arnaud on
 * 2026-09-15 ("adopt (a)"): the decimal key `increment` the candidate supports
 * is now the contract, and the other two — a `number` key's arithmetic, and
 * `set` beside another operation — revert to the shipped refusals. The third
 * `describe` states that decision: one positive contract cell whose answer is
 * the candidate's, and parity cells for (b) and (c) (note §R2.2, §R3.2, and the
 * "Decisions applied" section).
 *
 * The one shape `updateValue` still refuses is an EXACT DECIMAL under
 * `multiply` or `divide`, whose assignment is a guarded coefficient rewrite
 * with no expression form. A decimal PRIMARY key never reaches it (the contract
 * above refuses first); the reachable shape is a decimal RELATION key, recorded
 * as a decision in note §R2.1 and pinned here by its identity.
 */
import assert from "node:assert/strict";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryEngineError, UnsupportedOperationError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

/** MySQL's `supportsReturning: false`, on a credential-free driver. */
class NonReturningDriver extends SQLite3Driver {
  constructor(options: { client: Database.Database }) {
    super(options);
    this.adapter.capabilities.supportsReturning = false;
  }
}

/** A D1-shaped ATOMIC BATCH profile: no interactive transaction, one batch. */
class AtomicBatchDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

const intKey = s
  .model({ id: s.int().id(), label: s.string() })
  .map("g4u2k_int_keys");
const bigKey = s
  .model({ id: s.bigInt().id(), label: s.string() })
  .map("g4u2k_big_keys");
const decKey = s
  .model({ id: s.decimal({ precision: 8, scale: 2 }).id(), label: s.string() })
  .map("g4u2k_dec_keys");
const numKey = s
  .model({ id: s.number().id(), label: s.string() })
  .map("g4u2k_num_keys");
const keySchema = { intKey, bigKey, decKey, numKey };

interface Outcome {
  readonly answer: string;
  readonly rows: unknown[];
}

const SEED = `
  INSERT INTO g4u2k_int_keys (id,label) VALUES (7,'a');
  INSERT INTO g4u2k_big_keys (id,label) VALUES (7,'a');
  INSERT INTO g4u2k_dec_keys (id,label) VALUES ('600','a');
  INSERT INTO g4u2k_num_keys (id,label) VALUES (6.0,'a');
`;

async function update(
  model: keyof typeof keySchema,
  table: string,
  where: unknown,
  data: unknown,
  engine: "shipped" | "candidate",
  returning = true
): Promise<Outcome> {
  const database = new Database(":memory:");
  const driver = returning
    ? new SQLite3Driver({ client: database })
    : new NonReturningDriver({ client: database });
  const client = createClient({ schema: keySchema, driver });
  // biome-ignore lint/suspicious/noMisplacedAssertion: this helper is only ever called from inside a Vitest cell.
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
              { update(args: unknown): Promise<unknown> }
            >
          )[model]!.update({ where, data })
        : await candidate.execute(model, "update", { where, data });
    answer = `ok:${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}`;
  } catch (error) {
    answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
  const rows = database.prepare(`SELECT * FROM ${table}`).all();
  await client.$disconnect();
  database.close();
  return { answer, rows };
}

async function bothEngines(
  model: keyof typeof keySchema,
  table: string,
  where: unknown,
  data: unknown,
  returning = true
): Promise<void> {
  const shipped = await update(model, table, where, data, "shipped", returning);
  const candidate = await update(
    model,
    table,
    where,
    data,
    "candidate",
    returning
  );
  // biome-ignore lint/suspicious/noMisplacedAssertion: this helper is only ever called from inside a Vitest cell.
  assert.deepEqual(
    candidate,
    shipped,
    `candidate ${JSON.stringify(candidate)}\nshipped   ${JSON.stringify(shipped)}`
  );
}

describe("G4-02 — the updated key is NAMED on a non-RETURNING provider", () => {
  it("multiplies an int key the way the shipped engine does", async () => {
    await bothEngines(
      "intKey",
      "g4u2k_int_keys",
      { id: 7 },
      { id: { multiply: 2 } },
      false
    );
  });

  it("divides an int key with the dialect's truncation, as shipped", async () => {
    // 7 / 2 is the quotient that distinguishes integer truncation from real
    // division: the SET clause writes 3 and the readback must address 3.
    await bothEngines(
      "intKey",
      "g4u2k_int_keys",
      { id: 7 },
      { id: { divide: 2 } },
      false
    );
  });

  it("multiplies and divides a bigint key the way the shipped engine does", async () => {
    await bothEngines(
      "bigKey",
      "g4u2k_big_keys",
      { id: 7n },
      { id: { multiply: 3n } },
      false
    );
    await bothEngines(
      "bigKey",
      "g4u2k_big_keys",
      { id: 7n },
      { id: { divide: 2n } },
      false
    );
  });

  it("still increments and decrements a key as it did", async () => {
    await bothEngines(
      "intKey",
      "g4u2k_int_keys",
      { id: 7 },
      { id: { increment: 4 } },
      false
    );
    await bothEngines(
      "intKey",
      "g4u2k_int_keys",
      { id: 7 },
      { id: { decrement: 4 } },
      false
    );
  });
});

describe("G4-02 — the row key's portability contract, as the shipped engine states it", () => {
  for (const [name, model, table, where, data] of [
    [
      "decimal key multiply",
      "decKey",
      "g4u2k_dec_keys",
      { id: "6.00" },
      { id: { multiply: "2.00" } },
    ],
    [
      "number key multiply",
      "numKey",
      "g4u2k_num_keys",
      { id: 6 },
      { id: { multiply: 2 } },
    ],
    [
      "decimal key divide",
      "decKey",
      "g4u2k_dec_keys",
      { id: "6.00" },
      { id: { divide: "2.00" } },
    ],
    [
      "int key divide by zero",
      "intKey",
      "g4u2k_int_keys",
      { id: 7 },
      { id: { divide: 0 } },
    ],
  ] as const) {
    it(`${name}: the candidate answers what the shipped engine answers`, async () => {
      await bothEngines(model, table, where, data);
    });
  }
});

describe("G4-02 — R-D2, decided by Arnaud on 2026-09-15", () => {
  // "adopt (a)": the candidate's decimal key `increment` IS the contract, and
  // (b) a `number` key's arithmetic and (c) `set` beside another operation
  // revert to the shipped refusals. The three cells below are what that
  // decision looks like as checks: one positive contract, two parity.
  it("R-D2 (a) THE CONTRACT: names a decimal key increment, which is exact in coefficient space", async () => {
    // Legacy baseline, recorded not asserted: the shipped engine refuses this
    // request with `QueryEngineError: Arithmetic updates are not portable for
    // decimal primary key field 'id'. Use an explicit set value.` Arnaud
    // adopted the candidate's answer (R-D2 (a)), so the candidate is the
    // contract this cell states — and the capability
    // `tests/raptor3/g3/review-execution-boundaries.test.ts` ("reads a
    // supported decimal key increment through its provider expression")
    // registers. It is why the portability rule stops at `multiply`/`divide`
    // for a decimal key: those two carry the provider's rounding, `increment`
    // and `decrement` do not.
    const candidate = await update(
      "decKey",
      "g4u2k_dec_keys",
      { id: "6.00" },
      { id: { increment: "1.00" } },
      "candidate"
    );
    assert.equal(candidate.answer, 'ok:{"id":"7","label":"a"}');
    assert.deepEqual(candidate.rows, [{ id: 700, label: "a" }]);
  });

  it("R-D2 (c) PARITY: refuses `set` beside an operator with the shipped sentence", async () => {
    const shipped = await update(
      "intKey",
      "g4u2k_int_keys",
      { id: 7 },
      { id: { increment: 1, set: 9 } },
      "shipped"
    );
    const candidate = await update(
      "intKey",
      "g4u2k_int_keys",
      { id: 7 },
      { id: { increment: 1, set: 9 } },
      "candidate"
    );
    assert.deepEqual(candidate, shipped);
    assert.equal(
      candidate.answer,
      "QueryEngineError: Primary key field 'id' accepts exactly one update operation; received set, increment."
    );
    // The row is untouched on both engines: the refusal precedes every
    // statement, as `assertPortablePrimaryKeyUpdateInput` does.
    assert.deepEqual(candidate.rows, [{ id: 7, label: "a" }]);
  });

  it("R-D2 (c) PARITY: the same sentence when `set` accompanies an operator phase 2 added", async () => {
    const shipped = await update(
      "intKey",
      "g4u2k_int_keys",
      { id: 7 },
      { id: { divide: 0, set: 9 } },
      "shipped"
    );
    const candidate = await update(
      "intKey",
      "g4u2k_int_keys",
      { id: 7 },
      { id: { divide: 0, set: 9 } },
      "candidate"
    );
    assert.deepEqual(candidate, shipped);
    assert.equal(
      candidate.answer,
      "QueryEngineError: Primary key field 'id' accepts exactly one update operation; received set, divide."
    );
    // The arity question is asked BEFORE the operator question, as shipped:
    // `divide: 0` beside a `set` is answered by the arity sentence, never by
    // "Cannot divide primary key field 'id' by zero."
    assert.deepEqual(candidate.rows, [{ id: 7, label: "a" }]);
  });

  it("R-D2 (b) PARITY: refuses a number key increment with the shipped sentence", async () => {
    // The whole `number` arithmetic family, not just `increment`: the rule is
    // the scalar's, so `decrement` answers it too.
    for (const data of [
      { id: { increment: 1 } },
      { id: { decrement: 1 } },
    ] as const) {
      const shipped = await update(
        "numKey",
        "g4u2k_num_keys",
        { id: 6 },
        data,
        "shipped"
      );
      const candidate = await update(
        "numKey",
        "g4u2k_num_keys",
        { id: 6 },
        data,
        "candidate"
      );
      assert.deepEqual(candidate, shipped, JSON.stringify(data));
      assert.equal(
        candidate.answer,
        "QueryEngineError: Arithmetic updates are not portable for number primary key field 'id'. Use an explicit set value."
      );
      assert.deepEqual(candidate.rows, [{ id: 6, label: "a" }]);
    }
  });

  it("R-D2 (a) leaves the exact-domain decimal operators reachable and the rounding ones refused", async () => {
    // The two halves of (a) in one cell: `decrement` is named like `increment`,
    // and `multiply` still answers the portability sentence on both engines —
    // so the adopted divergence is exactly "exact-domain arithmetic", not "any
    // arithmetic on a decimal key".
    const decremented = await update(
      "decKey",
      "g4u2k_dec_keys",
      { id: "6.00" },
      { id: { decrement: "1.00" } },
      "candidate"
    );
    assert.equal(decremented.answer, 'ok:{"id":"5","label":"a"}');
    await bothEngines(
      "decKey",
      "g4u2k_dec_keys",
      { id: "6.00" },
      { id: { multiply: "2.00" } }
    );
  });
});

describe("G4-02 — the integer quotient is the dialect's own spelling", () => {
  const dialects = [
    {
      name: "sqlite",
      adapter: new SQLiteAdapter(),
      // SQLite drivers bind a JS number as REAL, so the divisor is cast.
      sql: "(CAST(? AS INTEGER) / CAST(? AS INTEGER))",
    },
    {
      name: "postgres",
      adapter: new PostgresAdapter(),
      // PostgreSQL integer division already truncates toward zero.
      sql: "(CAST(? AS INTEGER) / ?)",
    },
    {
      name: "mysql",
      adapter: new MySQLAdapter(),
      // MySQL `/` yields DECIMAL even for two integers.
      sql: "TRUNCATE(CAST(? AS SIGNED) / ?, 0)",
    },
  ];

  it("names an int key's quotient through expressions.integerDivide", () => {
    for (const { name, adapter, sql: expected } of dialects) {
      const queries = new Queries(new EngineSchema(keySchema), adapter);
      const named = queries.updateValue(
        intKey,
        "id",
        { divide: 2 },
        queries.fieldValue(intKey, "id", 7)
      );
      assert.equal(named.toStatement(), expected, name);
      assert.deepEqual(named.values, [7, 2], name);
    }
  });

  it("names a multiplied key natively on every dialect", () => {
    for (const { name, adapter } of dialects) {
      const queries = new Queries(new EngineSchema(keySchema), adapter);
      const named = queries.updateValue(
        intKey,
        "id",
        { multiply: 3 },
        queries.fieldValue(intKey, "id", 7)
      );
      assert.equal(named.toStatement().includes("*"), true, name);
      assert.deepEqual(named.values, [7, 3], name);
    }
  });
});

describe("G4-02 — the one shape with no expression form stays refused", () => {
  // R-D1, decided by Arnaud on 2026-09-15: "authorize" — the candidate MAY
  // name an exact-decimal key under `multiply`/`divide` (a symbolic expression
  // beside the provider's guarded assignment) if a reachable shape ever needs
  // it. No code changes: no admitted public request reaches this refusal today
  // (§R3.3 measured it; admission refuses a decimal ROW key first and a decimal
  // relation key's transition is spelled by the provider's own assignment), and
  // writing the expression now would be dead code. The authorization is
  // recorded; this unit-level pin stays until a reachable shape exists.
  it("refuses to name an exact decimal under multiply, with its registered identity", () => {
    const queries = new Queries(
      new EngineSchema(keySchema),
      new SQLiteAdapter()
    );
    for (const operator of ["multiply", "divide"] as const) {
      assert.throws(
        () =>
          queries.updateValue(
            decKey,
            "id",
            { [operator]: "2.00" },
            queries.fieldValue(decKey, "id", "6.00")
          ),
        (error: Error) =>
          error.name === "QueryEngineError" &&
          error.message ===
            `Raptor 3 cannot name the updated value of 'decKey.id' under '${operator}': the provider owns that operator's rounding inside its own assignment.`,
        operator
      );
    }
  });

  it("names an exact decimal under increment and decrement, which are exact", () => {
    const queries = new Queries(
      new EngineSchema(keySchema),
      new SQLiteAdapter()
    );
    for (const operator of ["increment", "decrement"] as const) {
      const named = queries.updateValue(
        decKey,
        "id",
        { [operator]: "2.00" },
        queries.fieldValue(decKey, "id", "6.00")
      );
      assert.equal(named.values.length, 2, operator);
    }
  });
});

describe("G4-02 — R-D3: the batch publication gap has a public identity", () => {
  /**
   * Under an atomic-batch profile an expression update is published through the
   * adapter's batch references and read back with an INTEGER cast
   * (`shared/operation-context.ts`, `usesBatch` arm), so a non-`int` field
   * demanded by a dependent cannot be published. Arnaud decided on 2026-09-15:
   * "give it a public identity now" (R-D3). The refusal is raised at the same
   * point it always was — before any statement of the update is dispatched — and
   * is now a registered `UnsupportedOperationError` naming the model, the field
   * and the operation, with `meta` `{ model, operation, field }`. The CLASS is
   * Arnaud's 2026-09-16 answer to R-D3-class: `UnsupportedOperationError`
   * (V8003 UNSUPPORTED_OPERATION), a `QueryEngineError` subclass, so a consumer
   * can tell this deliberate capability boundary from a crash (V9001
   * INTERNAL_ERROR) without reading the sentence.
   *
   * The divergence from the shipped row answer is the recorded, accepted half of
   * the decision: the shipped engine computes the value in JavaScript and
   * answers the row. Widening the candidate to match would need a typed scratch
   * read per domain, and an answer to the decimal rounding question that
   * `Queries.updateValue` refuses — a capability change, not an identity.
   */
  async function batchUpsert(
    engine: "shipped" | "candidate",
    update: unknown
  ): Promise<Outcome & { raised?: unknown }> {
    const database = new Database(":memory:");
    const driver = new AtomicBatchDriver({ client: database });
    const client = createClient({ schema: keySchema, driver });
    // biome-ignore lint/suspicious/noMisplacedAssertion: this helper is only ever called from inside a Vitest cell.
    assert.equal((await syncLiveSchema(client)).applied, true);
    database.exec(SEED);
    const candidate = createCommandEngine({ schema: keySchema, driver });
    const args = { where: { id: 6 }, create: { id: 6, label: "a" }, update };
    let answer: string;
    let raised: unknown;
    try {
      const value =
        engine === "shipped"
          ? await (
              client as unknown as Record<
                string,
                { upsert(args: unknown): Promise<unknown> }
              >
            ).numKey!.upsert(args)
          : await candidate.execute("numKey", "upsert", args);
      answer = `ok:${JSON.stringify(value)}`;
    } catch (error) {
      raised = error;
      answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
    }
    const rows = database.prepare("SELECT * FROM g4u2k_num_keys").all();
    await client.$disconnect();
    database.close();
    return { answer, raised, rows };
  }

  for (const [name, update, shippedAnswer] of [
    ["increment", { id: { increment: 1 } }, 'ok:{"id":7,"label":"a"}'],
    ["multiply", { id: { multiply: 2 } }, 'ok:{"id":12,"label":"a"}'],
  ] as const) {
    it(`R-D3 refuses a number key ${name} under a batch with its registered identity`, async () => {
      const shipped = await batchUpsert("shipped", update);
      const candidate = await batchUpsert("candidate", update);
      // The accepted divergence, recorded: the shipped engine computes the
      // value in JavaScript and answers the row.
      assert.equal(shipped.answer, shippedAnswer);
      // The decided identity: a registered UnsupportedOperationError (R-D3
      // plus R-D3-class), naming the model, the field and the operation, raised
      // before any statement is dispatched. It is still a QueryEngineError —
      // the class narrows the code, it does not leave the family.
      assert.equal(
        candidate.answer,
        "UnsupportedOperationError: Cannot publish the updated value of 'numKey.id' for operation \"upsert\" inside an atomic batch: the batch scratch reads back as an integer, and 'id' is a number field."
      );
      assert.equal(
        candidate.raised instanceof UnsupportedOperationError,
        true
      );
      assert.equal(candidate.raised instanceof QueryEngineError, true);
      assert.deepEqual(
        { ...(candidate.raised as QueryEngineError).meta },
        {
          field: "id",
          model: "numKey",
          operation: "upsert",
        }
      );
      assert.deepEqual(candidate.rows, [{ id: 6, label: "a" }]);
    });
  }

  it("answers an INT key under the same batch profile on both engines", async () => {
    // The gap is exactly "non-`int` demanded expression", not "batch": the
    // integer arm is green on both engines on the same driver.
    const database = new Database(":memory:");
    const driver = new AtomicBatchDriver({ client: database });
    const client = createClient({ schema: keySchema, driver });
    assert.equal((await syncLiveSchema(client)).applied, true);
    database.exec(SEED);
    const candidate = createCommandEngine({ schema: keySchema, driver });
    const args = {
      where: { id: 7 },
      create: { id: 7, label: "a" },
      update: { id: { increment: 1 } },
    };
    const value = await candidate.execute("intKey", "upsert", args);
    assert.deepEqual(value, { id: 8, label: "a" });
    await client.$disconnect();
    database.close();
  });
});
