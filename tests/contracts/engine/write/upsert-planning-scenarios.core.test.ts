import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { validateClientSchemaOrThrow } from "@schema/validation/validator";
import type { ExecutableOperation } from "@src/query-engine/write-engine/OperationExecutor";
import type {
  OperationStep,
  WriteStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { UpsertOperation } from "@src/query-engine/write-engine/UpsertOperation";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * TOP-LEVEL `UpsertOperation`, PROBE-FIRST PATH (`UpsertOperation.ts:573` planning,
 * `:590` compile).
 *
 * Every operation here declines the ON CONFLICT fold, so the locate read decides
 * the arm. What each neighbour owns instead:
 *
 *  - `operation-owner-coverage.core.test.ts:257` owns the FOLDED shape (empty
 *    planning, one statement, the parse seam). It never reaches an arm.
 *  - `upsert-on-conflict-fold.test.ts` owns the fold's eligibility conjuncts and
 *    its PGlite oracle.
 *  - `parity-b-upsert-arm.core.test.ts` owns the NESTED upsert arm
 *    (`RelationUpsertPart`), not this shell.
 *  - `create-race-pin.core.test.ts` owns the unit rule that a create pin needs the
 *    INSERT to propose the probed tuple. This file owns the shell's USE of it: the
 *    create arm withholds the pin its own payload cannot claim.
 */

const schema = (() => {
  const account = s
    .model({
      id: s.int().id().increment(),
      email: s.string().unique(),
      score: s.int(),
      notes: s.toMany(() => note),
    })
    .map("upsert_planning_accounts");
  const note = s
    .model({
      id: s.int().id(),
      body: s.string(),
      accountId: s.int(),
      account: s
        .toOne(() => account)
        .fields("accountId")
        .references("id"),
    })
    .map("upsert_planning_notes");
  // A model whose ONLY addressable key is its generated primary key. `account`
  // cannot reach the produced-identity arm: its create payload must spell the
  // required `email`, which is itself a unique, so `createDataUniqueWhere`
  // (`shared.ts:628`) always answers first with the `known` identity.
  const ticket = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
    })
    .map("upsert_planning_tickets");
  return { account, note, ticket };
})();

hydrateSchemaNames(schema);
validateClientSchemaOrThrow(schema);

function engine(
  mode: "transaction" | "batch",
  dialect: "mysql" | "postgresql" = "postgresql"
): QueryEngine {
  const driver = new PlanningDriver(dialect, {
    supportsTransactions: mode === "transaction",
    supportsBatch: true,
  });
  const schemas = createSchemaRegistry(schema);
  return new QueryEngine(driver, createModelRegistry(schema, schemas));
}

function published(
  operation: ExecutableOperation,
  rowsByStep: Readonly<Record<string, readonly Record<string, unknown>[]>>
): Record<string, unknown> {
  return Object.fromEntries(
    operation.planning().steps.flatMap((step) => {
      const rows = rowsByStep[step.id] ?? [];
      return Object.keys(step.outputs).map((output) => [
        `${step.id}.${output}`,
        output === "rows" ? rows : rows[0]?.[output],
      ]);
    })
  );
}

function stepKinds(steps: readonly OperationStep[]): string[] {
  return steps.map((step) => `${step.kind}:${step.id}`);
}

function writeStep(steps: readonly OperationStep[], index: number): WriteStep {
  const step = steps[index];
  if (!step || step.kind !== "write") {
    throw new Error(`expected a write step at position ${index}`);
  }
  return step;
}

function scalarOperation(mode: "transaction" | "batch", extra = {}) {
  return new UpsertOperation(engine(mode), schema.account, {
    where: { email: "one@example.test" },
    create: { email: "one@example.test", score: 1 },
    update: { score: { increment: 1 } },
    select: { id: true, email: true, score: true },
    ...extra,
  });
}

describe("provider-free top-level upsert planning", () => {
  test("a create arm whose payload spells a unique captures nothing and pins the miss", () => {
    const operation = scalarOperation("transaction");

    expect(stepKinds(operation.planning().steps)).toEqual([
      "read:account.locate",
    ]);
    const compiled = operation.compile(
      published(operation, { "account.locate": [] })
    );

    expect(stepKinds(compiled.steps)).toEqual([
      "write:account.create",
      "read:account.select",
    ]);
    const create = writeStep(compiled.steps, 0);
    // `createArmIdentity` answers `known` from the `email` unique the create data
    // spells (UpsertOperation.ts:1255), so `createArmInsert` (:1359) emits a plain
    // INSERT. A capture here would be a read-back of a row the payload already
    // names.
    expect(Object.keys(create.outputs)).toEqual([]);
    // The locate PROVED the `email` tuple absent and this INSERT proposes that
    // same tuple, so its unique violation is the raceable signal
    // (`createArmRacePin`, UpsertOperation.ts:830).
    expect(create.racePin).toMatchObject({
      fields: ["email"],
      table: "upsert_planning_accounts",
    });
  });

  test("a create arm that must produce its key captures it and withholds the race pin", () => {
    const operation = new UpsertOperation(
      engine("transaction"),
      schema.ticket,
      {
        where: { id: 5 },
        create: { label: "fresh" },
        update: { label: "changed" },
        select: { id: true, label: true },
      }
    );
    const compiled = operation.compile(
      published(operation, { "ticket.locate": [] })
    );

    expect(stepKinds(compiled.steps)).toEqual([
      "write:ticket.create",
      "read:ticket.select",
    ]);
    const create = writeStep(compiled.steps, 0);
    // One primary-key member is absent and DB-generated, so the INSERT must
    // capture what the database assigned (UpsertOperation.ts:113, :1372) — the
    // terminal read has nothing else to address the written row by.
    expect(create.outputs).toEqual({
      id: { kind: "firstRowField", field: "id" },
    });
    // The captured value crosses a generated-output segment boundary, which needs
    // its own re-assertion premise (UpsertOperation.ts:746).
    expect(create.progressiveContinuation?.kind).toBe("guard");
    // The INSERT does NOT propose the probed `id: 5`, so a unique violation here
    // is a genuine create conflict, not the locate's missing premise.
    expect(create.racePin).toBeUndefined();
  });

  test("an atomic returning batch publishes a generated-key create result directly", () => {
    const operation = scalarOperation("batch");
    const compiled = operation.compile(
      published(operation, { "account.locate": [] })
    );

    expect(stepKinds(compiled.steps)).toEqual(["write:account.create"]);
    expect(compiled.steps[0]).toMatchObject({
      outputs: { result: { kind: "rows" } },
      racePin: {
        fields: ["email"],
        table: "upsert_planning_accounts",
      },
    });
  });

  test("a matching conditional pins the located identity before the batch update", () => {
    const operation = scalarOperation("batch", {
      targetWhere: { score: { gt: 0 } },
    });
    const known = published(operation, {
      "account.locate": [{ id: 7 }],
      "account.targetWhere": [{ id: 7 }],
    });
    const compiled = operation.compile(known);

    expect(stepKinds(operation.planning().steps)).toEqual([
      "read:account.locate",
      "read:account.targetWhere",
    ]);
    expect(stepKinds(compiled.steps)).toEqual([
      "guard:account.guard.targetWhere",
      "write:account.update",
    ]);
    expect(compiled.steps[0]).toMatchObject({
      kind: "guard",
      premise: { kind: "exists" },
      failure: { raceable: false },
    });
  });

  test("a failed conditional preserves the captured row and pins the no-match premise", () => {
    const operation = scalarOperation("batch", {
      targetWhere: { score: { gt: 100 } },
    });
    const compiled = operation.compile(
      published(operation, {
        "account.locate": [{ id: 7 }],
        "account.targetWhere": [],
      })
    );

    expect(stepKinds(compiled.steps)).toEqual([
      "guard:account.guard.exists",
      "guard:account.guard.targetWhere",
      "read:account.select",
    ]);
    expect(compiled.steps.slice(0, 2)).toMatchObject([
      { premise: { kind: "exists" }, failure: { raceable: false } },
      { premise: { kind: "notExists" }, failure: { raceable: true } },
    ]);
  });
});

describe("relation-bearing top-level upsert arms", () => {
  test("the missing arm delegates the complete fresh relation subtree", () => {
    const operation = new UpsertOperation(
      engine("transaction", "mysql"),
      schema.account,
      {
        where: { email: "fresh@example.test" },
        create: {
          email: "fresh@example.test",
          score: 1,
          notes: { create: { id: 11, body: "fresh note" } },
        },
        update: { score: 2 },
        select: { id: true },
      }
    );
    const compiled = operation.compile(
      published(operation, { "account.locate": [] })
    );

    // The delegated `CreateOperation` shares this shell's `StepScope`
    // (CreateOperation.ts:540), and the shell has already spent the plain
    // `account.create` / `account.select` labels on the arms it did not take
    // (UpsertOperation.ts:375-377), so the delegated root and terminal take the
    // scope's disambiguated spellings.
    expect(stepKinds(compiled.steps)).toEqual([
      "write:account.create#1",
      "write:note.create",
      "read:account.select#1",
    ]);
    expect(compiled.steps[0]).toMatchObject({
      // MySQL cannot return the generated key, so the root INSERT publishes the
      // driver's insert id instead (CreateOperation.ts:3337).
      outputs: { id: { kind: "insertId" } },
      racePin: {
        fields: ["email"],
        table: "upsert_planning_accounts",
      },
    });
  });

  test("the found arm validates and compiles a selected relation subtree", () => {
    const operation = new UpsertOperation(engine("batch"), schema.account, {
      where: { email: "found@example.test" },
      create: { email: "found@example.test", score: 0 },
      update: {
        score: 2,
        notes: { create: { id: 12, body: "found note" } },
      },
      select: { id: true, score: true },
    });
    const compiled = operation.compile(
      published(operation, { "account.locate": [{ id: 8, score: 1 }] })
    );

    expect(stepKinds(compiled.steps)).toEqual([
      "guard:account.guard.exists",
      "write:account.update",
      "write:note.create",
      "read:account.select",
    ]);
    expect(compiled.steps[0]).toMatchObject({
      premise: { kind: "exists" },
      failure: { raceable: false },
    });
  });
});

describe("coverage low value", () => {
  test("planning publications fail closed when their row carriers are absent", () => {
    const locate = scalarOperation("transaction");
    expect(() => locate.compile({})).toThrow(
      "upsert planning did not expose the locate rows"
    );

    const conditional = scalarOperation("batch", {
      targetWhere: { score: { gt: 0 } },
    });
    const known = published(conditional, {
      "account.locate": [{ id: 7 }],
      "account.targetWhere": [{ id: 7 }],
    });
    known["account.targetWhere.rows"] = undefined;
    expect(() => conditional.compile(known)).toThrow(
      "upsert targetWhere probe did not expose rows"
    );
  });
});
