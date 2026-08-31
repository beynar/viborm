import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { locatedParentRefSchema } from "@tests/contracts/engine/write/located-parent-ref-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

export function makeClient(driver: PGliteDriver) {
  return createClient({ schema: locatedParentRefSchema, driver });
}

export type LocatedParentRefClient = ReturnType<typeof makeClient>;

export async function seed(client: LocatedParentRefClient): Promise<void> {
  await client.account.create({
    data: { id: 1, email: "decoy@x", code: "DECOY", label: "same" },
  });
  await client.account.create({
    data: { id: 2, email: "target@x", code: "TARGET", label: "same" },
  });
}

/**
 * N1-U3 — the DUAL-SUBSTRATE ORACLE.
 *
 * The behavior suite asserts fixed expectations on each substrate independently. That
 * proves each is right; it does not prove they AGREE, and agreement is the claim the atom
 * makes: one compile path, the substrate is a resolve function (ATOM §7). The Ref is the
 * sharpest test of that claim, because it is the one value that crosses the
 * planning/compile seam — under a transaction the locate is a locked read inside the same
 * scope as the writes; under an atomic batch it runs BEFORE the unit, against committed
 * state, and the value is inlined into entries the driver ships together.
 *
 * So: identical payloads, a FRESH database per arm, comparing the returned result, the
 * whole persisted state, AND the error class + message when the payload fails. Anything
 * the batch side could not express would show up here as a divergence rather than as an
 * assumption — and nothing did, which is why no substrate-naming refusal was added.
 *
 * A fresh database per ARM means two per scenario, so the scenario list is split across
 * three sibling files by the shape each one exercises
 * (`located-parent-ref-oracle-create.test.ts`,
 * `located-parent-ref-oracle-reference.test.ts`,
 * `located-parent-ref-oracle-failure.test.ts`). {@link runOracleAgreement} is the one
 * suite body all three run, so every piece spells the arms and the assertion the same
 * way.
 */
export interface OracleScenario {
  readonly name: string;
  seed(client: LocatedParentRefClient): Promise<void>;
  act(client: LocatedParentRefClient): PromiseLike<unknown>;
}

export interface ArmOutcome {
  readonly result?: unknown;
  readonly error?: { name: string; message: string };
  readonly state: Record<string, unknown[]>;
}

async function dumpState(
  client: LocatedParentRefClient
): Promise<Record<string, unknown[]>> {
  const [accounts, notes, attachments, tickets, owners, memos] =
    await Promise.all([
      client.account.findMany({ orderBy: { id: "asc" } }),
      client.note.findMany({ orderBy: { id: "asc" } }),
      client.attachment.findMany({ orderBy: { id: "asc" } }),
      client.ticket.findMany({ orderBy: { id: "asc" } }),
      client.owner.findMany({
        orderBy: [{ tenantId: "asc" }, { slot: "asc" }],
      }),
      client.memo.findMany({ orderBy: { id: "asc" } }),
    ]);
  return { accounts, notes, attachments, tickets, owners, memos };
}

export async function runOracleArm(
  substrate: "tx" | "batch",
  scenario: OracleScenario
): Promise<ArmOutcome> {
  const db = openBorrowedPGlite();
  const stateClient = makeClient(new PGliteDriver({ client: db }));
  await syncLiveSchema(stateClient);
  await scenario.seed(stateClient);
  const opClient =
    substrate === "tx"
      ? stateClient
      : makeClient(new BatchOnlyPGliteDriver({ client: db }));
  let result: unknown;
  let error: { name: string; message: string } | undefined;
  try {
    try {
      result = await scenario.act(opClient);
    } catch (thrown) {
      if (!(thrown instanceof Error)) throw thrown;
      error = { name: thrown.constructor.name, message: thrown.message };
    }
    const state = await dumpState(stateClient);
    return error ? { error, state } : { result, state };
  } finally {
    // ONE disconnect for both arms, because there is one database: the batch arm's
    // second driver is constructed over the SAME `db`, and closing that instance
    // through either client closes it for both. Disconnecting the batch arm's client
    // as well was tried and MEASURED — the second close raises `ConnectionError:
    // Database disconnection failed`, and seven oracle scenarios fail. What was
    // actually missing is this `finally`: a `dumpState` that threw used to skip the
    // one disconnect and strand the PGlite instance for the rest of the run.
    await stateClient.$disconnect();
  }
}

/** The oracle suite body. Each sibling file supplies the scenarios it owns; the
 *  describe title and the per-scenario test title are spelled here exactly once so
 *  the pieces cannot drift apart. */
export function runOracleAgreement(scenarios: readonly OracleScenario[]): void {
  describe("located-parent Ref dual-substrate oracle (N1-U3)", () => {
    for (const scenario of scenarios) {
      test(
        `${scenario.name}: transaction and atomic batch agree on result, state and error`,
        { timeout: 30_000 },
        async () => {
          const [tx, batch] = await Promise.all([
            runOracleArm("tx", scenario),
            runOracleArm("batch", scenario),
          ]);
          expect(batch).toEqual(tx);
        }
      );
    }
  });
}
