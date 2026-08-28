import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { UniqueConstraintError } from "@errors";

import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { isSql } from "@sql";
import type { StatementStep } from "@src/query-engine/write-engine/OperationFragment";
import { UpsertOperation } from "@src/query-engine/write-engine/UpsertOperation";
import {
  producedCompoundSchema,
  registerProducedCompoundBehavior,
} from "@tests/contracts/engine/write/produced-compound-identity-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import v from "@validation/primitives/v";
import { expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

const substrates = [
  {
    name: "PGlite transaction",
    make: () => new PGliteDriver({ client: new PGlite() }),
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
      await syncLiveSchema(shared);
    }
    return shared;
  });
}

// ---------------------------------------------------------------------------
// The compile-level pins: WHICH identity the arm takes, and — the batch capture
// wall (plan rule 9) — HOW the produced member travels on each substrate.
// ---------------------------------------------------------------------------

/** The models the compile pins need beside the behavior fixture: a single-column
 * generated PK and the newly published compound PK with two generated members. */
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
  const parent = s
    .model({
      id: s.string().id(),
      children: s.toMany(() => child),
    })
    .map("e62_pin_parents");
  const child = s
    .model({
      a: s.int().increment(),
      b: s.int().increment(),
      label: s.string(),
      parentId: s.string(),
      parent: s
        .toOne(() => parent)
        .fields("parentId")
        .references("id"),
    })
    .id(["a", "b"])
    .map("e62_pin_children");
  return { badge, child, parent, twin };
})();
hydrateSchemaNames(pinSchema);

const transformedSchema = (() => {
  const transformed = v.string({ transform: (value) => `${value}!` });
  const owner = s
    .model({
      id: s.string().id(),
      code: s.string().schema(transformed).unique(),
      notes: s.toMany(() => note),
    })
    .map("e62_transformed_owners");
  const note = s
    .model({
      id: s.string().id(),
      ownerId: s.string(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
    })
    .map("e62_transformed_notes");
  return { note, owner };
})();
hydrateSchemaNames(transformedSchema);

/** Compile an upsert's CREATE arm (an empty locate result) on the given substrate. */
function compileCreateArm(
  schema: Record<string, Model<any>>,
  model: Model<any>,
  args: { where: Record<string, unknown>; create: Record<string, unknown> },
  mode: "batch" | "transaction" = "transaction"
): { write: StatementStep; terminal: StatementStep | undefined } {
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
  if (!write) throw new Error("create arm did not compile a write");
  return { write, terminal };
}

function requireTerminal(step: StatementStep | undefined): StatementStep {
  if (!step) throw new Error("create arm did not compile a terminal read");
  return step;
}

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
  const terminalRead = statementSql(requireTerminal(terminal));
  // Both members address the read-back — the captured one and the spelled one.
  expect(terminalRead.text).toContain('"a"');
  expect(terminalRead.text).toContain('"b"');
  // The literal half is the value the CREATE wrote, never the one the `where` names.
  expect(terminalRead.values).toContain("written");
  expect(terminalRead.values).not.toContain("asked");
  expect(terminalRead.values).not.toContain(9999);
});

test("the PostgreSQL batch fragment returns the public result from the producer", () => {
  const batch = compileCreateArm(
    producedCompoundSchema,
    producedCompoundSchema.ticket,
    {
      where: { a_b: { a: 9999, b: "asked" } },
      create: { b: "written", label: "made" },
    },
    "batch"
  );
  expect(batch.write.outputs).toEqual({ result: { kind: "rows" } });
  expect(batch.terminal).toBeUndefined();
  const statement = statementSql(batch.write).text;
  expect(statement).toContain('RETURNING "label" AS "label"');
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
  const terminalRead = statementSql(requireTerminal(terminal));
  expect(terminalRead.text).toContain('"id"');
  expect(terminalRead.values).not.toContain(9999);
});

test("an indivisible shared batch returns produced compound identity atomically", async () => {
  const client = createClient({
    schema: producedCompoundSchema,
    driver: new BatchOnlyPGliteDriver({ client: new PGlite() }),
  }) as any;
  await syncLiveSchema(client);
  try {
    const [created] = await client.$transaction([
      client.ticket.upsert({
        where: { a_b: { a: 9999, b: "asked" } },
        create: { b: "written", label: "made" },
        update: { label: "must not run" },
        select: { a: true, b: true, label: true },
      }),
    ]);
    expect(created).toMatchObject({ b: "written", label: "made" });
    expect(created.a).not.toBe(9999);
    await expect(
      client.ticket.findUnique({
        where: { a_b: { a: created.a, b: created.b } },
      })
    ).resolves.toEqual(created);
  } finally {
    await client.$disconnect();
  }
});

test("two absent generated members use field-keyed outputs with no privileged id", () => {
  const { write, terminal } = compileCreateArm(pinSchema, pinSchema.twin, {
    where: { a_b: { a: 1, b: 1 } },
    create: { label: "made" },
  });
  expect(write.outputs).toEqual({
    "produced:a": { kind: "firstRowField", field: "a" },
    "produced:b": { kind: "firstRowField", field: "b" },
  });
  const terminalRead = statementSql(requireTerminal(terminal));
  expect(terminalRead.text).toContain('"a"');
  expect(terminalRead.text).toContain('"b"');
  expect(terminalRead.values).not.toContain(1);
});

test("an untaken relation-bearing plural create is inert on an atomic batch", async () => {
  const database = new PGlite();
  const client = createClient({
    schema: pinSchema,
    driver: new BatchOnlyPGliteDriver({ client: database }),
  });
  await syncLiveSchema(client);
  try {
    await client.parent.create({ data: { id: "parent" } });
    await client.child.createMany({
      data: [{ label: "before", parentId: "parent" }],
    });
    const existing = await client.child.findFirstOrThrow({
      select: { a: true, b: true },
    });
    await expect(
      client.child.upsert({
        where: { a_b: existing },
        create: {
          label: "must-not-run",
          parent: { connect: { id: "parent" } },
        },
        update: { label: "after" },
        select: { label: true },
      })
    ).resolves.toEqual({ label: "after" });
  } finally {
    await client.$disconnect();
  }
});

test("a relation-bearing race pin compares the once-parsed transformed value", () => {
  const engine = new QueryEngine(
    new PGliteDriver(),
    createModelRegistry(
      transformedSchema,
      createSchemaRegistry(transformedSchema)
    )
  );
  const operation = new UpsertOperation(engine, transformedSchema.owner, {
    where: { code: "raw" },
    create: {
      id: "owner",
      code: "raw!",
      notes: { create: { id: "note" } },
    },
    update: {},
  });
  const locate = operation.planning().steps[0];
  if (!locate) throw new Error("upsert did not publish its locate step");
  const fragment = operation.compile({ [`${locate.id}.rows`]: [] });
  const rootWrite = fragment.steps.find(
    (step) => step.kind === "write" && step.id.includes("owner.create")
  );
  expect(
    rootWrite?.kind === "write" ? rootWrite.racePin : undefined
  ).toBeUndefined();
});

test("the two-generated-member table is valid PostgreSQL DDL and returns its exact row", async () => {
  const client = createClient({
    schema: pinSchema,
    driver: new PGliteDriver({ client: new PGlite() }),
  });
  await syncLiveSchema(client);
  try {
    const rootCreated = await client.twin.create({
      data: { label: "root-create" },
      select: { a: true, b: true, label: true },
    });
    expect(rootCreated.label).toBe("root-create");

    const nested = await client.parent.create({
      data: {
        id: "parent",
        children: { create: { label: "nested-create" } },
      },
      include: { children: true },
    });
    expect(nested.children).toHaveLength(1);
    expect(nested.children[0]?.label).toBe("nested-create");

    const created = await client.twin.upsert({
      where: { a_b: { a: 10_000, b: 20_000 } },
      create: { label: "made" },
      update: { label: "must not run" },
      select: { a: true, b: true, label: true },
    });
    expect(created.label).toBe("made");
    expect(created.a).not.toBe(10_000);
    expect(created.b).not.toBe(20_000);
    await expect(
      client.twin.findUnique({
        where: { a_b: { a: created.a, b: created.b } },
      })
    ).resolves.toEqual(created);
  } finally {
    await client.$disconnect();
  }
});

test("a different create key cannot borrow the missing where's race pin", async () => {
  const client = createClient({
    schema: pinSchema,
    driver: new PGliteDriver({ client: new PGlite() }),
  });
  await syncLiveSchema(client);
  try {
    await client.twin.create({ data: { a: 77, b: 88, label: "occupied" } });
    const rejection = await client.twin
      .upsert({
        where: { a_b: { a: 1, b: 2 } },
        create: { a: 77, b: 88, label: "loser" },
        update: { label: "must not run" },
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(rejection).toBeInstanceOf(UniqueConstraintError);
    await expect(
      client.twin.findUnique({ where: { a_b: { a: 77, b: 88 } } })
    ).resolves.toEqual({ a: 77, b: 88, label: "occupied" });
    expect(await client.twin.count()).toBe(1);
  } finally {
    await client.$disconnect();
  }
});
