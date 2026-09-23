/**
 * Review probe (independent reviewer, follow-up round) — unit "Independent
 * witnesses C01/C12/C13".
 *
 * Claim under attack, after the repair of must-fix 2: the four campaign
 * profiles are now four EXECUTED read-transport models rather than four names
 * (`note.md` §4, §12.5), and every cell records the model its transport
 * exhibited.
 *
 * The author's own self-test compares (statements, envelopes) tuples for
 * pairwise distinctness. This probe attacks the layer underneath it: it drives
 * the sealed driver directly and requires each model's DEFINING behaviour to be
 * physically real — an atomic submission that really wraps the statement in
 * BEGIN/COMMIT on the connection, a weak returning envelope whose rows are
 * genuinely frozen copies (a decoder that writes into one must throw) and whose
 * `rowCount` is genuinely 0, and an acknowledging envelope that completes an
 * awaited turn before the rows are handed over and reports the exact count.
 *
 * If any of these were bookkeeping only — a model name pushed into a set with
 * no behaviour behind it — the corresponding assertion below fails.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  createGeneratedWorld,
  type G4GenerationProfile,
} from "../../generation/world";

interface RawResult {
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number;
}

type RawDriver = {
  execute(
    client: unknown,
    statement: string,
    parameters: unknown[]
  ): Promise<RawResult>;
};

const SEED = 20_003;
const ROWS = 6;
const QUERY = "SELECT id AS id, label_value AS label FROM g4_gen_specimens ORDER BY id";

async function submit(profile: G4GenerationProfile) {
  const world = await createGeneratedWorld(SEED, ROWS, profile);
  try {
    world.driver.statements.length = 0;
    world.driver.envelopes.length = 0;
    const raw = world.driver as unknown as RawDriver;
    const result = await raw.execute(world.database, QUERY, []);
    return {
      result,
      statements: [...world.driver.statements],
      envelopes: world.driver.envelopes.map((envelope) => ({ ...envelope })),
    };
  } finally {
    await world.close();
  }
}

describe("review probe: the four G4 transport models are executed, not named", () => {
  it("an interactive session submits one statement and borrows its rows", async () => {
    const { result, statements, envelopes } = await submit("sqlite-interactive");
    assert.deepEqual(statements, [QUERY]);
    assert.ok(result.rows.length > 0);
    assert.equal(result.rowCount, result.rows.length);
    assert.equal(Object.isFrozen(result.rows[0]), false);
    assert.deepEqual(envelopes, [
      {
        rowCount: result.rowCount,
        rows: result.rows.length,
        detached: false,
        acknowledged: false,
      },
    ]);
  });

  it("an atomic submission really wraps the statement in BEGIN/COMMIT", async () => {
    const { result, statements } = await submit("sqlite-atomic-batch");
    assert.deepEqual(statements, ["BEGIN", QUERY, "COMMIT"]);
    assert.equal(statements.length % 3, 0);
    assert.ok(result.rows.length > 0);
  });

  it("a weak returning envelope hands back frozen copies and no row count", async () => {
    const { result, envelopes } = await submit("scripted-returning-weak");
    assert.ok(result.rows.length > 0);
    assert.equal(result.rowCount, 0, "the weak envelope acknowledged the rows");
    const first = result.rows[0];
    assert.ok(first);
    assert.equal(Object.isFrozen(first), true);
    // A decoder that wrote back into the provider's row would work by accident
    // on a borrowed transport; on this one it must throw.
    assert.throws(() => {
      (first as Record<string, unknown>).label = "mutated";
    }, TypeError);
    assert.equal(envelopes[0]?.detached, true);
    assert.equal(envelopes[0]?.acknowledged, false);
  });

  it("an acknowledging envelope completes its turn before the rows and counts them", async () => {
    const world = await createGeneratedWorld(SEED, ROWS, "scripted-returning-ack");
    try {
      assert.equal(world.driver.supportsOrderedCommittedSegments, true);
      world.driver.statements.length = 0;
      world.driver.envelopes.length = 0;
      const raw = world.driver as unknown as RawDriver;
      const order: string[] = [];
      const pending = raw.execute(world.database, QUERY, []).then((result) => {
        order.push("rows");
        return result;
      });
      // One microtask turn: the acknowledging transport must still be holding
      // the rows here, because it awaits its own acknowledgement first.
      await Promise.resolve();
      order.push("turn");
      const result = await pending;
      assert.deepEqual(order, ["turn", "rows"]);
      assert.ok(result.rows.length > 0);
      assert.equal(result.rowCount, result.rows.length);
      assert.equal(world.driver.envelopes[0]?.acknowledged, true);
      assert.equal(world.driver.envelopes[0]?.detached, false);
    } finally {
      await world.close();
    }
  });

  it("the driver reports no model when a cell exhibits two", async () => {
    // `observedTransport()` is the per-cell witness the receipt compares with
    // the manifest's frozen expectation. It must not answer a model name for a
    // cell that behaved as two, or a collapsed profile could still pass.
    const world = await createGeneratedWorld(SEED, ROWS, "sqlite-interactive");
    try {
      const observed = Reflect.get(world.driver, "observed") as Set<string>;
      assert.ok(observed instanceof Set);
      const raw = world.driver as unknown as RawDriver;
      await raw.execute(world.database, QUERY, []);
      assert.equal(world.driver.observedTransport(), "interactive-session");
      observed.add("atomic-submission");
      assert.equal(world.driver.observedTransport(), "none");
    } finally {
      await world.close();
    }
  });
});
