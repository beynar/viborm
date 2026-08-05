import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { TransactionError } from "@errors";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { isSql } from "@sql";
import { createSchemaRegistry } from "@validation";
import { expect, test } from "vitest";
import type { StatementStep } from "../../src/query-engine/write-engine/OperationFragment";
import { UnsupportedOperationError } from "../../src/query-engine/write-engine/shared";
import { UpsertOperation } from "../../src/query-engine/write-engine/UpsertOperation";
import {
  producedCompoundSchema,
  registerProducedCompoundBehavior,
} from "./e6-produced-compound-identity-behavior";

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

const substrates = [
  {
    name: "PGlite transaction",
    make: () => new PGliteDriver({ client: new PGlite() }),
  },
  {
    name: "PGlite atomic batch",
    make: () => new BatchOnlyPGliteDriver({ client: new PGlite() }),
  },
] as const;

for (const substrate of substrates) {
  let shared: any;
  registerProducedCompoundBehavior(substrate.name, async () => {
    if (!shared) {
      shared = createClient({
        schema: producedCompoundSchema,
        driver: substrate.make(),
      }) as any;
      await push(shared, { force: true });
    }
    return shared;
  });
}

// ---------------------------------------------------------------------------
// The compile-level pins: WHICH identity the arm takes, and — the batch capture
// wall (plan rule 9) — HOW the produced member travels on each substrate.
// ---------------------------------------------------------------------------

/** The models the compile pins need beside the behavior fixture: a single-column
 *  generated PK (the degenerate case of the same rung) and a compound PK with TWO
 *  generated members (the shape that stays refused — one INSERT publishes ONE
 *  identity, so two absent members cannot both be produced). */
const pinSchema = (() => {
  const badge = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
    })
    .map("e62_pin_badges");
  const twin = s
    .model({
      a: s.int().increment(),
      b: s.int().increment(),
      label: s.string(),
    })
    .id(["a", "b"])
    .map("e62_pin_twins");
  return { badge, twin };
})();
hydrateSchemaNames(pinSchema);

/** Compile an upsert's CREATE arm (an empty locate result) on the given substrate. */
function compileCreateArm(
  schema: Record<string, Model<any>>,
  model: Model<any>,
  args: { where: Record<string, unknown>; create: Record<string, unknown> },
  mode: "batch" | "transaction" = "transaction"
): { write: StatementStep; terminal: StatementStep } {
  const schemas = createSchemaRegistry(schema);
  const engine = new QueryEngine(
    mode === "transaction"
      ? new PGliteDriver()
      : new BatchOnlyPGliteDriver({ client: new PGlite() }),
    createModelRegistry(schema, schemas)
  );
  const operation = new UpsertOperation(engine, model, {
    ...args,
    update: { label: "changed" },
    select: { label: true },
  });
  const fragment = operation.compile({
    [`${operation.planning().steps[0]!.id}.rows`]: [],
  });
  const statements = fragment.steps.filter(
    (step): step is StatementStep => step.kind !== "guard"
  );
  const write = statements.find((step) => step.kind === "write");
  const terminal = statements.find((step) => step.kind === "read");
  if (!(write && terminal)) {
    throw new Error(
      "create arm did not compile to a write plus a terminal read"
    );
  }
  return { write, terminal };
}

/** The two halves of the surviving refusal's message. */
const NO_COMPLETE_UNIQUE = /nor any complete unique constraint of the model/;
const NO_SINGLE_PRODUCED_MEMBER =
  /absent primary-key members are not a single database-generated identity/;

/** The SQL a step runs, as text plus bound values. */
function statementSql(step: StatementStep): {
  text: string;
  values: unknown[];
} {
  const statement = step.statement;
  if (!isSql(statement)) throw new Error("step is not one Sql");
  return { text: statement.toStatement("$n"), values: statement.values };
}

test("the produced compound identity is the capture UNION the spelled literal", () => {
  const { write, terminal } = compileCreateArm(
    producedCompoundSchema,
    producedCompoundSchema.ticket,
    {
      where: { a_b: { a: 9999, b: "asked" } },
      create: { b: "written", label: "made" },
    }
  );
  // The INSERT captures the generated member and nothing else.
  expect(write.outputs).toEqual({ id: { kind: "firstRowField", field: "a" } });
  const terminalRead = statementSql(terminal);
  // Both members address the read-back — the captured one and the spelled one.
  expect(terminalRead.text).toContain('"a"');
  expect(terminalRead.text).toContain('"b"');
  // The literal half is the value the CREATE wrote, never the one the `where` names.
  expect(terminalRead.values).toContain("written");
  expect(terminalRead.values).not.toContain("asked");
  expect(terminalRead.values).not.toContain(9999);
});

test("THE BATCH CAPTURE WALL: the produced member rides insertId on the atomic batch", () => {
  // Plan rule 9. The terminal read is a LATER statement, and `compileToEntries`
  // threads only `insertId` outputs of writes — a write's `firstRowField` cannot
  // feed a later statement in an atomic batch. So the batch substrate compiles the
  // capture as `insertId` (the scratch-store path the executor certifies) while the
  // returning-driver transaction keeps `firstRowField`. This absorption widens which
  // MEMBERS the read-back joins; it does not carry a RETURNING output across the wall.
  const batch = compileCreateArm(
    producedCompoundSchema,
    producedCompoundSchema.ticket,
    {
      where: { a_b: { a: 9999, b: "asked" } },
      create: { b: "written", label: "made" },
    },
    "batch"
  );
  expect(batch.write.outputs).toEqual({ id: { kind: "insertId" } });
  // ...and the INSERT itself carries no RETURNING on that substrate.
  expect(statementSql(batch.write).text).not.toContain("RETURNING");
});

test("a single-column generated PK compiles the SAME shape it always did", () => {
  // The degenerate case of the widened rung: the literal half is empty, so the
  // read-back is the flat `{ id: <ref> }` this arm has produced since W4. One rung,
  // not two — the compound case is the general form of the same union.
  const { write, terminal } = compileCreateArm(pinSchema, pinSchema.badge, {
    where: { id: 9999 },
    create: { label: "made" },
  });
  expect(write.outputs).toEqual({ id: { kind: "firstRowField", field: "id" } });
  const terminalRead = statementSql(terminal);
  expect(terminalRead.text).toContain('"id"');
  expect(terminalRead.values).not.toContain(9999);
});

test("THE THIRD SEAM: the produced compound arm stays refused from a SHARED driver batch", async () => {
  // Plan rule 10. The capture rides the adapter's per-operation scratch store, which
  // a `$transaction([…])` merge on a batch-only driver cannot isolate — so the merge
  // refuses, typed, exactly as it already does for the single-column generated PK.
  // Widening WHICH members the read-back joins does not widen that seam, and the
  // same operation on its OWN atomic unit is unaffected.
  const client = createClient({
    schema: producedCompoundSchema,
    driver: new BatchOnlyPGliteDriver({ client: new PGlite() }),
  }) as any;
  await push(client, { force: true });
  try {
    const rejection = await client
      .$transaction([
        client.ticket.upsert({
          where: { a_b: { a: 9999, b: "asked" } },
          create: { b: "written", label: "made" },
          update: { label: "must not run" },
          select: { label: true },
        }),
      ])
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(rejection).toBeInstanceOf(TransactionError);
    expect((rejection as Error).message).toContain(
      "cannot merge an insertId-scratch operation into a shared driver batch"
    );
    expect(
      await client.ticket.upsert({
        where: { a_b: { a: 9999, b: "asked" } },
        create: { b: "written", label: "made" },
        update: { label: "must not run" },
        select: { label: true },
      })
    ).toEqual({ label: "made" });
  } finally {
    await client.$disconnect();
  }
});

test("two absent generated members stay refused — one INSERT publishes one identity", () => {
  // The survivor. `a` and `b` are both `increment` and both absent, so the INSERT
  // publishes ONE value and the other member is unknowable. The refusal is typed and
  // fires only when the create arm is TAKEN.
  const compile = () =>
    compileCreateArm(pinSchema, pinSchema.twin, {
      where: { a_b: { a: 1, b: 1 } },
      create: { label: "made" },
    });
  expect(compile).toThrow(UnsupportedOperationError);
  expect(compile).toThrow(NO_COMPLETE_UNIQUE);
  expect(compile).toThrow(NO_SINGLE_PRODUCED_MEMBER);
});
