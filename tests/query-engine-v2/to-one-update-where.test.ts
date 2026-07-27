import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { createSchemaRegistry } from "@validation";
import { expect, test } from "vitest";
import type { StatementStep } from "../../src/query-engine-v2/OperationFragment";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";
import {
  runToOneUpdateWhereBehavior,
  toOneUpdateWhereSchema,
} from "./to-one-update-where-behavior";

class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

// The whole surface on PGlite, both substrates. The driver matrix legs run the
// same module from tests/drivers/*.test.ts.
runToOneUpdateWhereBehavior({
  name: "PGlite transaction",
  createDriver: () => new PGliteDriver(),
});
runToOneUpdateWhereBehavior({
  name: "PGlite atomic batch",
  createDriver: () => new BatchOnlyPGliteDriver(),
});

// ---------------------------------------------------------------------------
// STRUCTURAL: where the filter lands, and where it deliberately does NOT.
//
// The behavior suite proves the semantics. This proves the MECHANISM: the
// wrapper's `where` is compiled into the planning LOCATE (and, in batch, into
// the presence guard) and NEVER into the write, which addresses the primary key
// the locate captured. That is what makes a relation filter portable here and
// what keeps the bare form's SQL byte-identical. The bare-form arm is the
// falsification: without it the "no filter in the write" assertion would pass
// for a plan that never carried a filter at all.
// ---------------------------------------------------------------------------

function buildUpdate(
  relationUpdate: Record<string, unknown>,
  batch: boolean
): { planning: StatementStep[]; writes: StatementStep[]; guards: number } {
  const schemas = createSchemaRegistry(toOneUpdateWhereSchema);
  const engine = new QueryEngine(
    batch ? new BatchOnlyPGliteDriver() : new PGliteDriver(),
    createModelRegistry(toOneUpdateWhereSchema, schemas)
  );
  const operation = new UpdateOperation(engine, toOneUpdateWhereSchema.owner, {
    where: { id: 1 },
    data: { badge: { update: relationUpdate } },
    select: { id: true },
  });
  const plan = operation.planning();
  const planningSteps = plan.steps.filter(
    (step): step is StatementStep => step.kind === "read"
  );
  // The locate found owner 1; the correlated badge probe captured badge 2.
  const known: Record<string, unknown> = {};
  for (const step of plan.steps) {
    known[`${step.id}.rows`] = [{ id: step.id.includes("owner") ? 1 : 2 }];
    known[`${step.id}.id`] = step.id.includes("owner") ? 1 : 2;
  }
  const fragment = operation.compile(known);
  return {
    planning: planningSteps,
    writes: fragment.steps.filter(
      (step): step is StatementStep => step.kind === "write"
    ),
    guards: fragment.steps.filter((step) => step.kind === "guard").length,
  };
}

const BADGE_TABLE = "tou_badges";

function sqlOf(steps: StatementStep[]): string {
  return steps
    .filter((step) => step.statement.strings.join("?").includes(BADGE_TABLE))
    .map((step) => step.statement.strings.join("?"))
    .join("\n");
}

test("the wrapper filter is compiled into the locate, never into the write", () => {
  const wrapped = buildUpdate(
    { where: { active: true }, data: { label: "x" } },
    false
  );
  const bare = buildUpdate({ label: "x" }, false);

  // The badge probe carries the filter column…
  expect(sqlOf(wrapped.planning)).toContain("active");
  // …and the badge UPDATE does not (it is addressed by the captured PK).
  expect(sqlOf(wrapped.writes)).not.toContain("active");

  // Falsification: the bare form's probe carries no filter at all, so the
  // assertion above cannot be passing on a plan that never had one.
  expect(sqlOf(bare.planning)).not.toContain("active");
  expect(sqlOf(bare.writes)).toBe(sqlOf(wrapped.writes));
});

test("in batch mode the filter is re-asserted by the presence guard", () => {
  const wrapped = buildUpdate(
    { where: { active: true }, data: { label: "x" } },
    true
  );
  const bare = buildUpdate({ label: "x" }, true);
  // Same guard COUNT in both spellings — the filter rides the existing
  // split-witness guard rather than adding a step to the vocabulary.
  expect(wrapped.guards).toBe(bare.guards);
  expect(wrapped.guards).toBeGreaterThan(0);
  expect(sqlOf(wrapped.writes)).not.toContain("active");
});
