/**
 * G4-02 phase-2 review — EVIDENCE (red by construction).
 *
 * Brief item 3 / note §10.1 ask `Queries.updateValue` to answer `decrement`,
 * `multiply` and `divide` for BOTH lowerings: the provider's own assignment and
 * "the symbolic updated-key expression", so that
 * `OperationContext.updatedIdentity` and `CommandExecution.requireTransitions`
 * "need no change once the operators exist".
 *
 * What landed answers the assignment only: `updateValue` REFUSES `multiply` and
 * `divide` (query.ts:787-812). The one caller that needs the name is the
 * non-RETURNING readback — and MySQL is the project's non-RETURNING provider
 * (`mysql-adapter.ts:929 supportsReturning: false`), so the refusal is live on a
 * qualified provider for an ordinary request the shipped engine answers.
 *
 * Phase 2 also made `multiply`/`divide` REACHABLE for the first time, which
 * newly exposes the shipped engine's primary-key portability contract
 * (`operations/mutation-identity.ts` `assertPortablePrimaryKeyUpdateInput`):
 * the shipped engine refuses arithmetic on a `number`/`decimal` primary key and
 * refuses a primary-key `divide: 0` by name. The candidate performs both.
 *
 * Each cell states the SHIPPED answer as the expectation, so it turns green
 * when the divergence is closed (or records the decision that keeps it).
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

/** MySQL's capability, on a driver the review can run credential-free. */
class NonReturningDriver extends SQLite3Driver {
  constructor(options: { client: Database.Database }) {
    super(options);
    this.adapter.capabilities.supportsReturning = false;
  }
}

const intKey = s
  .model({ id: s.int().id(), label: s.string() })
  .map("r2p_int_keys");
const decKey = s
  .model({ id: s.decimal({ precision: 8, scale: 2 }).id(), label: s.string() })
  .map("r2p_dec_keys");
const numKey = s
  .model({ id: s.number().id(), label: s.string() })
  .map("r2p_num_keys");
const schema = { intKey, decKey, numKey };

interface Outcome {
  readonly answer: string;
  readonly rows: unknown[];
}

async function update(
  model: keyof typeof schema,
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
  const client = createClient({ schema, driver });
  assert.equal((await syncLiveSchema(client)).applied, true);
  database.exec(
    `INSERT INTO r2p_int_keys (id,label) VALUES (6,'a');
     INSERT INTO r2p_dec_keys (id,label) VALUES ('600','a');
     INSERT INTO r2p_num_keys (id,label) VALUES (6.0,'a');`
  );
  const candidate = createCommandEngine({ schema, driver });
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
    answer = `ok:${JSON.stringify(value)}`;
  } catch (error) {
    answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
  const rows = database.prepare(`SELECT * FROM ${table}`).all();
  await client.$disconnect();
  database.close();
  return { answer, rows };
}

describe("G4-02 review EVIDENCE — the symbolic updated-key expression", () => {
  it("multiplies a key on a NON-RETURNING provider the way the shipped engine does", async () => {
    const shipped = await update(
      "intKey",
      "r2p_int_keys",
      { id: 6 },
      { id: { multiply: 2 } },
      "shipped",
      false
    );
    const candidate = await update(
      "intKey",
      "r2p_int_keys",
      { id: 6 },
      { id: { multiply: 2 } },
      "candidate",
      false
    );
    assert.deepEqual(
      candidate,
      shipped,
      `candidate ${JSON.stringify(candidate)}\nshipped   ${JSON.stringify(shipped)}`
    );
  });

  it("divides a key on a NON-RETURNING provider the way the shipped engine does", async () => {
    const shipped = await update(
      "intKey",
      "r2p_int_keys",
      { id: 6 },
      { id: { divide: 3 } },
      "shipped",
      false
    );
    const candidate = await update(
      "intKey",
      "r2p_int_keys",
      { id: 6 },
      { id: { divide: 3 } },
      "candidate",
      false
    );
    assert.deepEqual(
      candidate,
      shipped,
      `candidate ${JSON.stringify(candidate)}\nshipped   ${JSON.stringify(shipped)}`
    );
  });
});

describe("G4-02 review EVIDENCE — primary-key arithmetic portability", () => {
  for (const [name, model, table, where, data] of [
    ["decimal key increment", "decKey", "r2p_dec_keys", { id: "6.00" }, { id: { increment: "1.00" } }],
    ["decimal key multiply", "decKey", "r2p_dec_keys", { id: "6.00" }, { id: { multiply: "2.00" } }],
    ["number key multiply", "numKey", "r2p_num_keys", { id: 6 }, { id: { multiply: 2 } }],
    ["int key divide by zero", "intKey", "r2p_int_keys", { id: 6 }, { id: { divide: 0 } }],
  ] as const) {
    it(`${name}: the candidate answers what the shipped engine answers`, async () => {
      const shipped = await update(model, table, where, data, "shipped");
      const candidate = await update(model, table, where, data, "candidate");
      assert.deepEqual(
        candidate,
        shipped,
        `candidate ${JSON.stringify(candidate)}\nshipped   ${JSON.stringify(shipped)}`
      );
    });
  }

  it("a primary key carrying two update operations is refused as the shipped engine refuses it", async () => {
    const shipped = await update(
      "intKey",
      "r2p_int_keys",
      { id: 6 },
      { id: { increment: 1, set: 9 } },
      "shipped"
    );
    const candidate = await update(
      "intKey",
      "r2p_int_keys",
      { id: 6 },
      { id: { increment: 1, set: 9 } },
      "candidate"
    );
    assert.deepEqual(
      candidate,
      shipped,
      `candidate ${JSON.stringify(candidate)}\nshipped   ${JSON.stringify(shipped)}`
    );
  });
});
