import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import type {
  OperationStep,
  StatementStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import {
  junctionUpsertArmSchema,
  registerJunctionUpsertArmProbeBehavior,
} from "@tests/contracts/engine/write/junction-upsert-arm-probe-behavior";
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
  registerJunctionUpsertArmProbeBehavior(substrate.name, async () => {
    if (!shared) {
      shared = createClient({
        schema: junctionUpsertArmSchema,
        driver: substrate.make(),
      }) as any;
      await push(shared, { force: true });
    }
    return shared;
  });
}

function engineFor(): QueryEngine {
  return new QueryEngine(
    new PGliteDriver({ client: new PGlite() }),
    createModelRegistry(
      junctionUpsertArmSchema,
      createSchemaRegistry(junctionUpsertArmSchema)
    )
  );
}

function sqlOf(step: { statement: { strings: readonly string[] } }): string {
  return step.statement.strings.join("?");
}

function reads(steps: readonly OperationStep[]): readonly StatementStep[] {
  return steps.filter((step): step is StatementStep => step.kind === "read");
}

function writes(steps: readonly OperationStep[]): readonly StatementStep[] {
  return steps.filter((step): step is StatementStep => step.kind === "write");
}

const NOTE_INSERT = /INSERT INTO (?:"[^"]+"\.)?"e61_notes"/;
const TAG_UPDATE = /UPDATE (?:"[^"]+"\.)?"e61_tags"/;
const jsonOf = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v));

const UPDATE_ROOT_WHOLE_TARGET = {
  where: { id: "u1" },
  data: {
    tags: {
      upsert: {
        where: { slug: "target" },
        create: { slug: "target" },
        update: { owner: { connect: { id: "o1" } } },
      },
    },
  },
};

describe("U-E6.1 the arm's address is the probe's key, not the selector", () => {
  test("the record compiler reuses the MEMBER probe", () => {
    const planning = new UpdateOperation(
      engineFor(),
      junctionUpsertArmSchema.user,
      UPDATE_ROOT_WHOLE_TARGET
    ).planning();
    expect(reads(planning.steps).some((step) => step.id === "tag.locate")).toBe(
      false
    );
    const probe = reads(planning.steps).find(
      (step) => step.id === "tag.member"
    );
    expect(probe?.outputs).toMatchObject({
      id: { kind: "firstRowField", field: "id", optional: true },
    });
  });

  test("the member probe PUBLISHES the captured key, and optionally", () => {
    const planning = new UpdateOperation(
      engineFor(),
      junctionUpsertArmSchema.user,
      UPDATE_ROOT_WHOLE_TARGET
    ).planning();
    const probe = reads(planning.steps).find(
      (step) => step.id === "tag.member"
    );
    expect(probe?.outputs).toMatchObject({
      rows: { kind: "rows" },
      id: { kind: "firstRowField", field: "id", optional: true },
    });
    // OPTIONAL is the create arm's whole legality: a required output would abort the
    // planning pass on the branch that is meant to be taken.
    expect(probe?.expects).toBeUndefined();
  });

  test("the fresh-parent arm reads the GLOBAL probe instead", () => {
    const planning = new CreateOperation(
      engineFor(),
      junctionUpsertArmSchema.user,
      {
        data: {
          id: "u2",
          name: "u",
          tags: {
            upsert: {
              where: { slug: "target" },
              create: { slug: "target" },
              update: { notes: { create: { id: "n-2", body: "b" } } },
            },
          },
        },
      }
    ).planning();
    const probe = reads(planning.steps).find((step) => step.id === "tag.find");
    expect(probe?.outputs).toMatchObject({
      id: { kind: "firstRowField", field: "id", optional: true },
    });
    // A fresh parent has no membership read at all (E5-U1's elision), so the global
    // probe is the only row this arm ever acted on.
    expect(reads(planning.steps).some((step) => step.id === "tag.member")).toBe(
      false
    );
  });

  test("CREATE root: the record compiler reuses the GLOBAL probe", () => {
    const planning = new CreateOperation(
      engineFor(),
      junctionUpsertArmSchema.user,
      {
        data: {
          id: "u3",
          name: "u",
          tags: {
            upsert: {
              where: { slug: "target" },
              create: { slug: "target" },
              update: { owner: { connect: { id: "o1" } } },
            },
          },
        },
      }
    ).planning();
    expect(reads(planning.steps).some((step) => step.id === "tag.locate")).toBe(
      false
    );
    const probe = reads(planning.steps).find((step) => step.id === "tag.find");
    expect(probe?.outputs).toMatchObject({
      id: { kind: "firstRowField", field: "id", optional: true },
    });
  });

  test("CORRUPT LOCATE: the deeper edge follows the probe row, not the selector", () => {
    // WRONG-ROW PROVENANCE. The probe is made to return a DIFFERENT existing primary
    // key than the selector names. The note's foreign key must follow the probe — if it
    // re-derived the value from `where: { slug }` it would be unaffected, and the
    // wrong-row doctrine would be unenforced on this new `planned` path.
    const operation = new UpdateOperation(
      engineFor(),
      junctionUpsertArmSchema.user,
      {
        where: { id: "u1" },
        data: {
          tags: {
            upsert: {
              where: { slug: "target" },
              create: { slug: "target" },
              update: { notes: { create: { id: "n-1", body: "b" } } },
            },
          },
        },
      }
    );
    const compiled = operation.compile({
      "user.locate.rows": [{ id: "u1" }],
      "tag.member.rows": [{ id: 4242 }],
      "tag.find.rows": [{ id: 4242 }],
    });
    const insert = writes(compiled.steps).find((step) =>
      NOTE_INSERT.test(sqlOf(step))
    );
    expect(insert).toBeDefined();
    expect(jsonOf((insert as StatementStep).statement.values)).toContain(
      "4242"
    );
  });

  test("CORRUPT LOCATE: the arm's own UPDATE addresses the probe row too", () => {
    const compiled = new UpdateOperation(
      engineFor(),
      junctionUpsertArmSchema.user,
      {
        where: { id: "u1" },
        data: {
          tags: {
            upsert: {
              where: { slug: "target" },
              create: { slug: "target" },
              update: { weight: 9 },
            },
          },
        },
      }
    ).compile({
      "user.locate.rows": [{ id: "u1" }],
      "tag.member.rows": [{ id: 4242 }],
      "tag.find.rows": [{ id: 4242 }],
    });
    const update = writes(compiled.steps).find((step) =>
      TAG_UPDATE.test(sqlOf(step))
    );
    expect(jsonOf((update as StatementStep).statement.values)).toContain(
      "4242"
    );
  });
});
