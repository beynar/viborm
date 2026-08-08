import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createClient } from "@client/client";
import type { AnyDriver, BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import type {
  OperationStep,
  WriteStep,
} from "@src/query-engine/write-engine/OperationFragment";
import {
  constructRoutedOperation,
  executeRoutedOperation,
} from "@src/query-engine/write-engine/routing";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { batchIsAtomicUnit } from "@tests/fixtures/atomic-unit-batch";
import { producedIdentitySchema } from "@tests/contracts/engine/write/produced-identity-depth-behavior";

/** Runs one mutation on the same database just before the atomic batch commits — the
 *  concurrent-writer injection every other pin falsification in this estate uses. */
class BeforeBatchPGliteDriver extends BatchOnlyPGliteDriver {
  private beforeBatch: (() => Promise<void>) | undefined;

  constructor(
    beforeBatch: () => Promise<void>,
    options: ConstructorParameters<typeof PGliteDriver>[0]
  ) {
    super(options);
    this.beforeBatch = beforeBatch;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const hook = this.beforeBatch;
    // Fire once, before the operation's compiled ATOMIC UNIT — not the first
    // batch of any kind, since planning reads ride a batch too once grouped by
    // level (PLAN Phase 6.1). Once: the retry must run against a clean
    // database, which is exactly what makes the second attempt find the row and
    // adopt it.
    if (hook && batchIsAtomicUnit(queries)) {
      this.beforeBatch = undefined;
      await hook();
    }
    return super.executeBatch<T>(client, queries);
  }
}

/** The fragment's write statements, narrowed to the owner of `racePin`. */
function writeSteps(steps: readonly OperationStep[]): readonly WriteStep[] {
  return steps.filter((step): step is WriteStep => step.kind === "write");
}

function engineFor(driver: AnyDriver): QueryEngine {
  const schemas = createSchemaRegistry(producedIdentitySchema);
  return new QueryEngine(
    driver,
    createModelRegistry(producedIdentitySchema, schemas)
  );
}

/** `org.update > teams.upsert` whose CREATE arm is taken. `carriesRelations` chooses
 *  the two spellings the pin has to behave identically for: the scalar arm (one INSERT,
 *  the pin on its own leaf) and the relation-carrying arm (a create subtree, the pin on
 *  its root record). */
function upsertArgs(carriesRelations: boolean): Record<string, unknown> {
  return {
    where: { id: 2 },
    data: {
      teams: {
        upsert: {
          // A unique that is NEITHER the primary key the create data spells NOR the
          // parent discriminator — so the pinned constraint is unambiguous.
          where: { code: "T-FRESH" },
          create: {
            id: 20,
            code: "T-FRESH",
            title: "fresh",
            ...(carriesRelations
              ? {
                  tasks: { create: { id: 100, label: "deep" } },
                  lead: { create: { id: 8, name: "fresh-lead" } },
                }
              : {}),
          },
          update: { title: "adopted" },
        },
      },
    },
  };
}

/** The root located its org; the arm's probe found nothing, so the CREATE arm is taken. */
const CREATE_ARM_TAKEN = {
  "org.locate.rows": [{ id: 2 }],
  "team.find.rows": [],
};

const TEAM_CODE_PIN = {
  fields: ["code"],
  table: "n4pi_teams",
  columns: ["code"],
  constraints: ["n4pi_teams_code_key"],
};

describe("N4-U2 — the adopt arm's missing-premise pin after the move", () => {
  // Both substrates: the pin is a property of the compiled fragment, and the batch
  // lowering must not drop it (the substrate where a lost race is most likely, since
  // the whole plan is decided before any of it runs).
  for (const substrate of [
    { name: "transaction", make: () => new PGliteDriver() },
    { name: "atomic batch", make: () => new BatchOnlyPGliteDriver() },
  ]) {
    test(`the pin rides the subtree's ROOT record and nothing deeper (${substrate.name})`, async () => {
      const driver = substrate.make();
      try {
        const engine = engineFor(driver);
        const subtree = new UpdateOperation(
          engine,
          producedIdentitySchema.org,
          upsertArgs(true)
        );
        // The root's own locate, then the arm's probe — the probe rows are the
        // three-way decision, so an empty result is the CREATE arm.
        expect(subtree.planning().steps.map((step) => step.id)).toEqual([
          "org.locate",
          "team.find",
        ]);
        const missing = subtree.compile(CREATE_ARM_TAKEN);
        const writes = writeSteps(missing.steps);
        // The arm's own INSERT is the subtree's root record, and it is the ONLY write
        // in the whole tree carrying a pin: the grandchild task and the before-parent
        // lead are unconditional creates.
        expect(
          writes
            .filter((step) => step.racePin !== undefined)
            .map((step) => step.id)
        ).toEqual(["team.create"]);
        expect(
          writes.find((step) => step.id === "team.create")?.racePin
        ).toEqual(TEAM_CODE_PIN);
        // The deeper records are present (so the assertion above is about a real
        // subtree, not an empty one) and unpinned.
        expect(writes.map((step) => step.id)).toEqual(
          expect.arrayContaining(["lead.create", "task.create"])
        );

        // The scalar spelling of the same arm pins the SAME constraint on the SAME
        // statement id — the move preserved the pin rather than relocating it.
        const scalar = new UpdateOperation(
          engine,
          producedIdentitySchema.org,
          upsertArgs(false)
        );
        const scalarWrites = writeSteps(scalar.compile(CREATE_ARM_TAKEN).steps);
        expect(
          scalarWrites
            .filter((step) => step.racePin !== undefined)
            .map((step) => step.id)
        ).toEqual(["team.create"]);
        expect(
          scalarWrites.find((step) => step.id === "team.create")?.racePin
        ).toEqual(TEAM_CODE_PIN);

        // The FOUND branch takes the update arm, whose premise is a guard (batch) or an
        // affected-rows expectation (tx) — never a constraint, so never a pin.
        const found = subtree.compile({
          "org.locate.rows": [{ id: 2 }],
          // Already correlated to this parent, so the arm's three-way lands on `found`.
          "team.find.rows": [{ id: 21, orgId: 2 }],
        });
        // `.every` answers `true` for an empty list, so the non-empty check is what
        // this arm alone catches: an update arm that stopped emitting a write would
        // otherwise satisfy the pin claim without ever compiling one.
        const foundWrites = writeSteps(found.steps);
        expect(foundWrites.length).toBeGreaterThan(0);
        expect(foundWrites.every((step) => step.racePin === undefined)).toBe(
          true
        );
      } finally {
        await driver.disconnect();
      }
    });
  }

  test("a concurrent create between the probe and the arm's INSERT converges by retry-and-adopt", async () => {
    const db = new PGlite();
    const base = createClient({
      schema: producedIdentitySchema,
      driver: new PGliteDriver({ client: db }),
    });
    await push(base, { force: true });
    await base.org.create({ data: { id: 2, slug: "target-org" } });

    const driver = new BeforeBatchPGliteDriver(
      async () => {
        // The concurrent winner creates the very row the CREATE arm was about to — same
        // `code`, a DIFFERENT primary key, so the violation the loser hits can only be
        // the pinned `code` unique and not the primary key. (Colliding on the primary
        // key too would leave which constraint the provider reports up to the provider,
        // and the pin is attributed per constraint.)
        await base.team.create({
          data: { id: 21, code: "T-FRESH", title: "winner", orgId: 2 },
        });
      },
      { client: db }
    );
    const engine = engineFor(driver);
    const executor = new OperationExecutor(engine);
    const operation = constructRoutedOperation(
      engine,
      producedIdentitySchema.org,
      "update",
      { ...upsertArgs(true), select: { id: true } }
    );
    if (!operation) throw new Error("update did not route");

    const result = await executeRoutedOperation<unknown>(
      executor,
      operation,
      createOperationExecutionContext("org", "update", engine.instrumentation)
    );

    // Converged rather than surfaced: the retry re-planned, its probe found the winner,
    // and the UPDATE arm adopted it. Without the pin on the arm's INSERT the unique
    // violation is not a race and this call rejects with a `UniqueConstraintError`.
    expect(result).toEqual({ id: 2 });
    await expect(
      base.team.findMany({ orderBy: { id: "asc" } })
    ).resolves.toEqual([
      { id: 21, code: "T-FRESH", title: "adopted", orgId: 2, leadId: null },
    ]);
    // The adopted row is the winner's, so the create arm's subtree — its grandchild task
    // and its before-parent lead — describes a row this call did not create, and none of
    // it ran on either attempt.
    await expect(base.task.findMany({})).resolves.toEqual([]);
    await expect(base.lead.findMany({})).resolves.toEqual([]);
    // One PGlite instance backs both the state client and the injecting driver, so the
    // client's disconnect closes it once.
    await base.$disconnect();
  }, 45_000);
});
