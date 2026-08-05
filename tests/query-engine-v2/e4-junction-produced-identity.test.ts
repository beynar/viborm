import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import type {
  OperationStep,
  WriteStep,
} from "../../src/query-engine/write-engine/OperationFragment";
import { UpdateOperation } from "../../src/query-engine/write-engine/UpdateOperation";
import {
  producedIdentitySchema,
  registerProducedIdentityBehavior,
} from "./e4-junction-produced-identity-behavior";

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
    name: "transaction",
    make: () => new PGliteDriver({ client: new PGlite() }),
  },
  {
    name: "atomic batch",
    make: () => new BatchOnlyPGliteDriver({ client: new PGlite() }),
  },
] as const;

for (const substrate of substrates) {
  let shared: any;
  registerProducedIdentityBehavior(substrate.name, async () => {
    if (!shared) {
      shared = createClient({
        schema: producedIdentitySchema,
        driver: substrate.make(),
      }) as any;
      await push(shared, { force: true });
    }
    return shared;
  });
}

/** The target table's INSERT, as the pinned statement must spell it. */
const TARGET_INSERT = /INSERT INTO "e4u3_stamps"/;

/** The fragment's write statements, narrowed to the owner of `racePin`. */
function writeSteps(steps: readonly OperationStep[]): readonly WriteStep[] {
  return steps.filter((step): step is WriteStep => step.kind === "write");
}

function operationFor(data: Record<string, unknown>) {
  const schemas = createSchemaRegistry(producedIdentitySchema);
  const engine = new QueryEngine(
    new PGliteDriver({ client: new PGlite() }),
    createModelRegistry(producedIdentitySchema, schemas)
  );
  return new UpdateOperation(engine, producedIdentitySchema.post, {
    where: { id: "p1" },
    data,
  });
}

describe("E4-U3 the missing-premise race pin survives the delegation", () => {
  /** The arm's `where` names the target's `name` unique, so that is the pinned
   *  constraint under both dialect spellings. */
  const STAMP_PIN = {
    fields: ["name"],
    table: "e4u3_stamps",
    columns: ["name"],
    constraints: ["e4u3_stamps_name_key", "e4u3_stamps_name_unique", "name"],
  };

  test("the delegated subtree's ROOT insert carries the arm's pin, and nothing deeper does", () => {
    const operation = operationFor({
      stamps: {
        connectOrCreate: {
          where: { name: "fresh" },
          create: {
            name: "fresh",
            notes: { create: { id: "n-fresh", body: "b" } },
          },
        },
      },
    });
    // The root located its post; the arm's global probe found nothing, so the CREATE
    // branch is taken and the delegated subtree is what runs.
    const compiled = operation.compile({
      "post.locate.rows": [{ id: "p1" }],
      "stamp.find.rows": [],
    });
    const writes = writeSteps(compiled.steps);
    const pinned = writes.filter((step) => step.racePin !== undefined);
    // EXACTLY ONE pinned write, and it is the subtree's root INSERT into the target
    // table — not the join row, not the grandchild.
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.racePin).toMatchObject({
      table: STAMP_PIN.table,
      fields: STAMP_PIN.fields,
    });
    expect(pinned[0]?.statement.strings.join("?") ?? "").toMatch(TARGET_INSERT);
    // The subtree really did carry a grandchild, so the assertion above is about a
    // delegated subtree and not about an empty one.
    expect(
      writes.some((step) =>
        step.statement.strings.join("?").includes("e4u3_notes")
      )
    ).toBe(true);
  });

  test("a scalar-only arm keeps the pin on its own INSERT (nothing regressed)", () => {
    const operation = operationFor({
      stamps: {
        connectOrCreate: {
          where: { name: "plain" },
          create: { name: "plain" },
        },
      },
    });
    const compiled = operation.compile({
      "post.locate.rows": [{ id: "p1" }],
      "stamp.find.rows": [],
    });
    const pinned = writeSteps(compiled.steps).filter(
      (step) => step.racePin !== undefined
    );
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.racePin).toMatchObject({
      table: STAMP_PIN.table,
      fields: STAMP_PIN.fields,
    });
  });

  test("the join row references the subtree's INSERT, not a step the slot never emits", () => {
    // WRONG-ROW PROVENANCE. The slot's own `childInsert` is not in the fragment when the
    // arm is delegated, so the join row must address the SUBTREE's insert step. The
    // fragment validator would fail an unresolved reference at execution; this asserts
    // the wiring at compile, where the mistake is cheap to see.
    const operation = operationFor({
      stamps: {
        create: {
          name: "fresh",
          notes: { create: { id: "n-fresh", body: "b" } },
        },
      },
    });
    const compiled = operation.compile({ "post.locate.rows": [{ id: "p1" }] });
    const writes = writeSteps(compiled.steps);
    const producing = writes.find((step) =>
      step.statement.strings.join("?").includes('INSERT INTO "e4u3_stamps"')
    );
    const join = writes.find((step) => step.id.includes("junction.insert"));
    expect(producing).toBeDefined();
    expect(join).toBeDefined();
    // The join row's parameters carry a reference to the producing step's `id` output.
    const referenced = JSON.stringify(join?.statement.values ?? [], (_k, v) =>
      typeof v === "bigint" ? String(v) : v
    );
    expect(referenced).toContain(producing?.id);
  });
});
