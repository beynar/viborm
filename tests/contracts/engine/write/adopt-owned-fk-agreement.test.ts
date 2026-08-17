import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import type { StatementStep } from "@src/query-engine/write-engine/OperationFragment";
import {
  adoptOwnedFkSchema,
  registerAdoptOwnedFkBehavior,
} from "@tests/contracts/engine/write/adopt-owned-fk-agreement-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

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
  registerAdoptOwnedFkBehavior(substrate.name, async () => {
    if (!shared) {
      shared = createClient({
        schema: adoptOwnedFkSchema,
        driver: substrate.make(),
      }) as any;
      await push(shared, { force: true });
    }
    return shared;
  });
}

const THING_UPDATE = /UPDATE "e5u2_things"/;
const THING_INSERT = /INSERT INTO "e5u2_things"/;
const TIME_UPDATE = /UPDATE "e5u2_time_rows"/;
const OWNER_COLUMN = /"owner_fk"/g;
const SET_CLAUSE = /SET (.*?) WHERE /;

function sqlOf(step: { statement: { strings: readonly string[] } }): string {
  return step.statement.strings.join("?");
}

/** The assignment list of an UPDATE — the only place a second provenance for the owned
 *  column could show up (the RETURNING list names it too, by design). */
function setClause(sql: string): string {
  return SET_CLAUSE.exec(sql)?.[1] ?? "";
}

function compiledFor(
  data: Record<string, unknown>,
  known: Record<string, unknown>
) {
  const schemas = createSchemaRegistry(adoptOwnedFkSchema);
  const engine = new QueryEngine(
    new PGliteDriver({ client: new PGlite() }),
    createModelRegistry(adoptOwnedFkSchema, schemas)
  );
  return new CreateOperation(engine, adoptOwnedFkSchema.owner, {
    data,
  }).compile(known);
}

describe("E5-U2 the fold stays the single provenance", () => {
  test("the FOUND arm's SET names the owned column exactly once", () => {
    // The agreeing spelling is gone before `separateData` runs, so the arm's update
    // data carries no `ownerId` and the only assignment in the SET is the fold's. A
    // kept key would put the column in the statement twice — rejected outright by some
    // dialects, and a second provenance in every one of them.
    const compiled = compiledFor(
      {
        id: "o1",
        email: "o1@x",
        things: {
          upsert: {
            where: { slug: "s" },
            create: { id: "t", slug: "s" },
            update: { label: "y", ownerId: "o1" },
          },
        },
      },
      { "thing.find.rows": [{ id: "t-found" }] }
    );
    const arm = compiled.steps.find(
      (step): step is StatementStep =>
        step.kind === "write" && THING_UPDATE.test(sqlOf(step))
    );
    expect(arm).toBeDefined();
    const assignments = setClause(sqlOf(arm as StatementStep));
    expect(assignments).not.toBe("");
    expect(assignments.match(OWNER_COLUMN) ?? []).toHaveLength(1);
    // …and the value it writes is the parent's own key.
    expect(JSON.stringify(arm?.statement.values ?? [])).toContain("o1");
  });

  test("a dateTime referenced key AGREES on the canonical value the parse produced", () => {
    // M6's ALL-CANONICAL measurement, pinned where the decision is made. Both operands
    // are the ISO string the parse boundary produced — no `Date` instance reaches the
    // comparator, so `fkEquals` is the whole of it. Compile-level because the decision
    // is made before any statement runs; the LIVE twin — which U-E6.0's
    // destination-cast fix unblocked — is in `adopt-owned-fk-agreement-behavior.ts`.
    const at = new Date("2021-06-02T03:04:05.000Z");
    const compiled = new CreateOperation(
      new QueryEngine(
        new PGliteDriver({ client: new PGlite() }),
        createModelRegistry(
          adoptOwnedFkSchema,
          createSchemaRegistry(adoptOwnedFkSchema)
        )
      ),
      adoptOwnedFkSchema.timeOwner,
      {
        data: {
          at,
          rows: {
            upsert: {
              where: { slug: "d" },
              create: { id: "never", slug: "d" },
              update: { atRef: at },
            },
          },
        },
      }
    ).compile({ "timeRow.find.rows": [{ id: "d0" }] });
    const arm = compiled.steps.find(
      (step): step is StatementStep =>
        step.kind === "write" && TIME_UPDATE.test(sqlOf(step))
    );
    expect(arm).toBeDefined();
    expect(JSON.stringify(arm?.statement.values ?? [])).toContain(
      at.toISOString()
    );
  });

  test("the ABSENT arm's subtree INSERT names the owned column exactly once", () => {
    const compiled = compiledFor(
      {
        id: "o1",
        email: "o1@x",
        things: {
          upsert: {
            where: { slug: "s" },
            create: {
              id: "t",
              slug: "s",
              notes: { create: { id: "n", body: "b" } },
            },
            update: { ownerId: "o1" },
          },
        },
      },
      { "thing.find.rows": [] }
    );
    const insert = compiled.steps.find(
      (step): step is StatementStep =>
        step.kind === "write" && THING_INSERT.test(sqlOf(step))
    );
    expect(insert).toBeDefined();
    expect(
      sqlOf(insert as StatementStep).match(OWNER_COLUMN) ?? []
    ).toHaveLength(1);
  });
});
