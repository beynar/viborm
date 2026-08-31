import { NestedWriteError } from "@errors";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import type {
  OperationFragment,
  OperationStep,
  WriteStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { planningKey } from "@src/query-engine/write-engine/Part";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { prepareSchema } from "@tests/fixtures/query-scope";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const collectionSchema = (() => {
  const author = s
    .model({
      id: s.int().id(),
      name: s.string(),
      tags: s.toMany(() => tag).through("relation_matrix_author_tag"),
    })
    .map("relation_matrix_author");
  const tag = s
    .model({
      id: s.int().id(),
      label: s.string(),
      authors: s.toMany(() => author),
    })
    .map("relation_matrix_tag");
  return { author, tag };
})();

const singularSchema = (() => {
  const clip = s
    .model({
      id: s.int().id(),
      title: s.string(),
      board: s.toOne(() => board),
    })
    .map("relation_matrix_clip");
  const board = s
    .model({
      id: s.int().id(),
      label: s.string(),
      items: s.toMany(
        { clip: () => clip },
        { values: { clip: "relation.matrix.clip.v1" } }
      ),
    })
    .map("relation_matrix_board");
  return { board, clip };
})();

prepareSchema(collectionSchema);
prepareSchema(singularSchema);

function collectionEngine(batch = false): QueryEngine {
  const driver = new PlanningDriver("postgresql", {
    supportsTransactions: !batch,
    supportsBatch: true,
  });
  const schemas = createSchemaRegistry(collectionSchema);
  return new QueryEngine(
    driver,
    createModelRegistry(collectionSchema, schemas)
  );
}

function singularEngine(): QueryEngine {
  const driver = new PlanningDriver("postgresql", {
    supportsTransactions: true,
    supportsBatch: true,
  });
  const schemas = createSchemaRegistry(singularSchema);
  return new QueryEngine(driver, createModelRegistry(singularSchema, schemas));
}

function collectionOperation(
  data: Record<string, unknown>,
  batch = false
): UpdateOperation {
  return new UpdateOperation(collectionEngine(batch), collectionSchema.author, {
    where: { id: 1 },
    data,
    select: { id: true },
  });
}

function singularOperation(data: Record<string, unknown>): UpdateOperation {
  return new UpdateOperation(singularEngine(), singularSchema.clip, {
    where: { id: 30 },
    data,
    select: { id: true },
  });
}

function knownRows(
  operation: UpdateOperation,
  rootName: string,
  relationRows: readonly Record<string, unknown>[],
  slotRows: readonly Record<string, unknown>[] = []
): Record<string, unknown> {
  return Object.fromEntries(
    operation
      .planning()
      .steps.map((step) => [
        planningKey(step.id, "rows"),
        step.id === `${rootName}.locate`
          ? rootName === "author"
            ? [{ id: 1, name: "author" }]
            : [{ id: 30, title: "clip" }]
          : step.id.endsWith(".slot.owners")
            ? slotRows
            : relationRows,
      ])
  );
}

function writes(fragment: OperationFragment): readonly WriteStep[] {
  return fragment.steps.filter(
    (step): step is WriteStep => step.kind === "write"
  );
}

function relationSteps(
  fragment: OperationFragment,
  prefix: string
): readonly OperationStep[] {
  return fragment.steps.filter((step) => step.id.startsWith(prefix));
}

function sql(step: WriteStep): string {
  return step.statement.strings.join("?");
}

describe("collection junction mutation matrix", () => {
  for (const scenario of [
    {
      name: "connect",
      data: { tags: { connect: [{ id: 20 }] } },
      expected: ["INSERT", "relation_matrix_author_tag"],
    },
    {
      name: "disconnect",
      data: { tags: { disconnect: [{ id: 20 }] } },
      expected: ["DELETE", "relation_matrix_author_tag"],
    },
    {
      name: "set",
      data: { tags: { set: [{ id: 20 }] } },
      expected: ["DELETE", "relation_matrix_author_tag"],
    },
    {
      name: "create",
      data: { tags: { create: [{ id: 21, label: "created" }] } },
      expected: ["INSERT", "relation_matrix_tag"],
    },
    {
      name: "update",
      data: {
        tags: {
          update: [{ where: { id: 20 }, data: { label: "updated" } }],
        },
      },
      expected: ["UPDATE", "relation_matrix_tag"],
    },
    {
      name: "delete",
      data: { tags: { delete: [{ id: 20 }] } },
      expected: ["DELETE", "relation_matrix_tag"],
    },
  ]) {
    test(`${scenario.name} compiles its target and membership effects`, () => {
      const operation = collectionOperation(scenario.data);
      const compiled = operation.compile(
        knownRows(operation, "author", [{ id: 20, label: "before" }])
      );
      const statements = writes(compiled).map(sql);

      expect(
        statements.some(
          (statement) =>
            statement.includes(scenario.expected[0]!) &&
            statement.includes(scenario.expected[1]!)
        )
      ).toBe(true);
    });
  }

  test("createMany emits the target rows and their junction memberships", () => {
    const operation = collectionOperation({
      tags: {
        createMany: {
          data: [
            { id: 31, label: "first" },
            { id: 32, label: "second" },
          ],
        },
      },
    });
    const compiled = operation.compile(knownRows(operation, "author", []));
    const statements = writes(compiled).map(sql);

    expect(
      statements.some((statement) =>
        statement.includes('"relation_matrix_tag"')
      )
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.includes('"relation_matrix_author_tag"')
      )
    ).toBe(true);
  });

  test("bulk target mutations stay correlated through the junction", () => {
    const cases = [
      {
        data: {
          tags: {
            updateMany: {
              where: { label: { contains: "before" } },
              data: { label: "after" },
            },
          },
        },
        verb: "UPDATE",
      },
      {
        data: { tags: { deleteMany: { label: { startsWith: "stale" } } } },
        verb: "DELETE",
      },
    ];

    for (const current of cases) {
      const operation = collectionOperation(current.data, true);
      const compiled = operation.compile(
        knownRows(operation, "author", [
          { id: 20, label: "stale-before" },
          { id: 21, label: "stale-before-2" },
        ])
      );
      expect(
        writes(compiled).some(
          (step) =>
            sql(step).includes(current.verb) &&
            sql(step).includes('"relation_matrix_tag"')
        )
      ).toBe(true);
    }
  });

  test("connectOrCreate and upsert select only the arm proven by their probes", () => {
    const cases = [
      {
        data: {
          tags: {
            connectOrCreate: {
              where: { id: 20 },
              create: { id: 20, label: "unused" },
            },
          },
        },
        forbiddenId: "tag.create",
      },
      {
        data: {
          tags: {
            upsert: {
              where: { id: 20 },
              create: { id: 20, label: "unused" },
              update: { label: "updated" },
            },
          },
        },
        forbiddenId: "tag.create",
      },
    ];

    for (const current of cases) {
      const operation = collectionOperation(current.data);
      const compiled = operation.compile(
        knownRows(operation, "author", [{ id: 20, label: "existing" }])
      );
      expect(relationSteps(compiled, "tag.")).not.toEqual([]);
      expect(
        compiled.steps.some((step) => step.id === current.forbiddenId)
      ).toBe(false);
    }
  });
});

describe("singular junction mutation matrix", () => {
  test("connect replaces a different slot owner before linking the selected owner", () => {
    const operation = singularOperation({ board: { connect: { id: 2 } } });
    const compiled = operation.compile(
      knownRows(
        operation,
        "clip",
        [{ id: 2, label: "incoming" }],
        [{ boardId: 3 }]
      )
    );

    expect(relationSteps(compiled, "board.").map((step) => step.id)).toEqual([
      "board.slot.vacate",
      "board.junction.insert",
    ]);
  });

  for (const scenario of [
    {
      name: "disconnect",
      data: { board: { disconnect: true } },
      expectedVerb: "DELETE",
    },
    {
      name: "delete",
      data: { board: { delete: true } },
      expectedVerb: "DELETE",
    },
    {
      name: "update",
      data: { board: { update: { label: "updated" } } },
      expectedVerb: "UPDATE",
    },
  ]) {
    test(`${scenario.name} acts on the one connected owner`, () => {
      const operation = singularOperation(scenario.data);
      const compiled = operation.compile(
        knownRows(operation, "clip", [{ id: 2, label: "connected" }])
      );

      expect(
        writes(compiled).some((step) =>
          sql(step).includes(scenario.expectedVerb)
        )
      ).toBe(true);
    });
  }

  test("create and missing-slot upsert publish an owner before its membership", () => {
    const cases = [
      { board: { create: { id: 4, label: "created" } } },
      {
        board: {
          upsert: {
            create: { id: 5, label: "created by upsert" },
            update: { label: "unused" },
          },
        },
      },
    ];

    for (const data of cases) {
      const operation = singularOperation(data);
      const compiled = operation.compile(knownRows(operation, "clip", []));
      const ids = writes(compiled)
        .filter((step) => step.id.startsWith("board."))
        .map((step) => step.id);
      expect(ids).toEqual(["board.create", "board.junction.insert"]);
    }
  });
});

describe("coverage low value", () => {
  test("singular update fails closed when the connected-slot probe is empty", () => {
    const operation = singularOperation({
      board: { update: { label: "missing" } },
    });

    expect(() => operation.compile(knownRows(operation, "clip", []))).toThrow(
      NestedWriteError
    );
  });
});
