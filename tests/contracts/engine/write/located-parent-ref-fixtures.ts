import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { locatedParentRefSchema } from "@tests/contracts/engine/write/located-parent-ref-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
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
 * So: identical payloads, EMPTY TABLES per arm, comparing the returned result, the
 * whole persisted state, AND the error class + message when the payload fails. Anything
 * the batch side could not express would show up here as a divergence rather than as an
 * assumption — and nothing did, which is why no substrate-naming refusal was added.
 *
 * The arms run one after the other in the file's OWN PGlite schema
 * (`usePGliteSchemaFamily`), with `family.reset()` truncating every table between them —
 * the arm shape `upsert-family.test.ts` and `update-depth-upsert.test.ts` already use for
 * their own multi-substrate oracles. Each arm used to open a PGlite of its own, two per
 * scenario, and that is what made this the file group that could bust the process ceiling
 * on its own: a PGlite instance is a whole Postgres compiled to Wasm. A schema is not,
 * and the arms are as independent inside one as they were across two instances, because
 * nothing here asserts on the database itself.
 *
 * The scenario list stays split across three sibling files by the shape each one
 * exercises (`located-parent-ref-oracle-create.test.ts`,
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

/**
 * The shared PGlite schema an oracle file provisions for itself, reduced to the three
 * members the arms use. The database is SHARED with every other suite in the worker, so
 * every driver built over it below carries `namespace` — without it the driver addresses
 * `public`, where this suite has no tables at all.
 */
export interface OracleFamily {
  readonly database: PGlite;
  readonly namespace: string;
  readonly reset: () => Promise<void>;
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
  family: OracleFamily,
  substrate: "tx" | "batch",
  scenario: OracleScenario
): Promise<ArmOutcome> {
  // Empty tables are the arm's premise, and the whole premise: an arm that could see
  // what the other one wrote would compare the two substrates on different states.
  await family.reset();
  const options = { client: family.database, namespace: family.namespace };
  const stateClient = makeClient(new PGliteDriver(options));
  await scenario.seed(stateClient);
  const opClient =
    substrate === "tx"
      ? stateClient
      : makeClient(new BatchOnlyPGliteDriver(options));
  let result: unknown;
  let error: { name: string; message: string } | undefined;
  try {
    result = await scenario.act(opClient);
  } catch (thrown) {
    if (!(thrown instanceof Error)) throw thrown;
    error = { name: thrown.constructor.name, message: thrown.message };
  }
  const state = await dumpState(stateClient);
  // NO disconnect: the database belongs to the worker and serves every later suite in
  // the process, and the schema family owns the connection lifecycle for this file.
  return error ? { error, state } : { result, state };
}

/** The oracle suite body. Each sibling file supplies the schema family it provisioned
 *  and the scenarios it owns; the describe title and the per-scenario test title are
 *  spelled here exactly once so the pieces cannot drift apart. */
export function runOracleAgreement(
  getFamily: () => OracleFamily,
  scenarios: readonly OracleScenario[]
): void {
  describe("located-parent Ref dual-substrate oracle (N1-U3)", () => {
    for (const scenario of scenarios) {
      test(
        `${scenario.name}: transaction and atomic batch agree on result, state and error`,
        { timeout: 30_000 },
        async () => {
          // Sequential, because the two arms share one schema: the `reset` that opens
          // each arm is what keeps them independent, and it cannot do that for two
          // arms running at once.
          const family = getFamily();
          const tx = await runOracleArm(family, "tx", scenario);
          const batch = await runOracleArm(family, "batch", scenario);
          expect(batch).toEqual(tx);
        }
      );
    }
  });
}
