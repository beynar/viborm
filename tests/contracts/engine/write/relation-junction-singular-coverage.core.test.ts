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

const schema = (() => {
  const clip = s
    .model({
      id: s.int().id(),
      title: s.string(),
      board: s.toOne(() => board),
    })
    .map("relation_coverage_clip");
  const board = s
    .model({
      id: s.int().id(),
      label: s.string(),
      items: s.toMany(
        { clip: () => clip },
        { values: { clip: "relation.coverage.clip.v1" } }
      ),
    })
    .map("relation_coverage_board");
  return { board, clip };
})();

prepareSchema(schema);

function operation(data: Record<string, unknown>): UpdateOperation {
  const driver = new PlanningDriver("postgresql");
  const engine = new QueryEngine(
    driver,
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
  return new UpdateOperation(engine, schema.clip, {
    where: { id: 20 },
    data,
    select: { id: true },
  });
}

function compileKnown(
  current: UpdateOperation,
  ownerRows: readonly Record<string, unknown>[],
  slotOwnerRows: readonly Record<string, unknown>[] = []
): Record<string, unknown> {
  return Object.fromEntries(
    current.planning().steps.map((step) => {
      const rows =
        step.id === "clip.locate"
          ? [{ id: 20, title: "clip" }]
          : step.id.endsWith(".slot.owners")
            ? slotOwnerRows
            : ownerRows;
      return [planningKey(step.id, "rows"), rows];
    })
  );
}

function writes(fragment: OperationFragment): readonly WriteStep[] {
  return fragment.steps.filter(
    (step): step is WriteStep => step.kind === "write"
  );
}

function sqlText(step: WriteStep): string {
  return step.statement.strings.join("?");
}

function relationSteps(fragment: OperationFragment): readonly OperationStep[] {
  return fragment.steps.filter((step) => step.id.startsWith("board."));
}

describe("singular member-junction supplier coverage", () => {
  test("create emits the owner before the membership that references it", () => {
    const current = operation({
      board: { create: { id: 3, label: "created" } },
    });
    const compiled = current.compile(compileKnown(current, []));
    const relationWrites = writes(compiled).filter((step) =>
      step.id.startsWith("board.")
    );

    expect(relationWrites.map((step) => step.id)).toEqual([
      "board.create",
      "board.junction.insert",
    ]);
    expect(sqlText(relationWrites[0]!)).toContain(
      'INSERT INTO "public"."relation_coverage_board"'
    );
    expect(sqlText(relationWrites[1]!)).toContain("board_items_clip");
  });

  test("connectOrCreate adopts a captured owner without compiling its create arm", () => {
    const current = operation({
      board: {
        connectOrCreate: {
          where: { id: 2 },
          create: { id: 2, label: "unused" },
        },
      },
    });
    const compiled = current.compile(
      compileKnown(current, [{ id: 2, label: "existing" }])
    );
    const relationWrites = writes(compiled).filter((step) =>
      step.id.startsWith("board.")
    );

    expect(relationWrites.map((step) => step.id)).toEqual([
      "board.junction.insert",
    ]);
    expect(
      relationWrites.some((step) => sqlText(step).includes("board.create"))
    ).toBe(false);
  });

  test("connectOrCreate compiles the fresh owner only when its probe is empty", () => {
    const current = operation({
      board: {
        connectOrCreate: {
          where: { id: 4 },
          create: { id: 4, label: "created" },
        },
      },
    });
    const compiled = current.compile(compileKnown(current, []));

    expect(
      writes(compiled)
        .filter((step) => step.id.startsWith("board."))
        .map((step) => step.id)
    ).toEqual(["board.create", "board.junction.insert"]);
  });
});

describe("singular member-junction selected-arm coverage", () => {
  test("upsert updates the connected owner and leaves the create arm untaken", () => {
    const current = operation({
      board: {
        upsert: {
          create: { id: 5, label: "unused" },
          update: { label: "updated" },
        },
      },
    });
    const compiled = current.compile(
      compileKnown(current, [{ id: 2, label: "before" }])
    );
    const relationWrites = writes(compiled).filter((step) =>
      step.id.startsWith("board.")
    );

    expect(relationWrites.map((step) => step.id)).toEqual(["board.update"]);
    expect(sqlText(relationWrites[0]!)).toContain(
      'UPDATE "public"."relation_coverage_board"'
    );
  });

  test("upsert creates and links an owner when the connected-slot probe is empty", () => {
    const current = operation({
      board: {
        upsert: {
          create: { id: 5, label: "created" },
          update: { label: "unused" },
        },
      },
    });
    const compiled = current.compile(compileKnown(current, []));

    expect(
      writes(compiled)
        .filter((step) => step.id.startsWith("board."))
        .map((step) => step.id)
    ).toEqual(["board.create", "board.junction.insert"]);
  });

  test("update fails closed when the physical singular slot is empty", () => {
    const current = operation({ board: { update: { label: "missing" } } });

    expect(() => current.compile(compileKnown(current, []))).toThrow(
      NestedWriteError
    );
  });

  test("a producing supplier defers its modify to a post-membership record series", () => {
    const current = operation({
      board: {
        disconnect: true,
        create: { id: 6, label: "before" },
        update: { label: "after" },
      },
    });
    const compiled = current.compile(compileKnown(current, []));
    const steps = relationSteps(compiled);

    expect(steps.map((step) => step.id)).toEqual([
      "board.junction.delete",
      "board.create",
      "board.junction.insert",
      "board.continuation",
    ]);
    expect(steps.at(-1)?.kind).toBe("recordSeries");
  });
});

describe("singular member-junction transfer coverage", () => {
  test("an exact reconnect preserves the existing membership without a write", () => {
    const current = operation({ board: { connect: { id: 1 } } });
    const compiled = current.compile(
      compileKnown(current, [{ id: 1, label: "same" }], [{ boardId: 1 }])
    );

    expect(relationSteps(compiled)).toEqual([]);
  });

  test("a different captured owner is vacated before the incoming owner is inserted", () => {
    const current = operation({ board: { connect: { id: 1 } } });
    const compiled = current.compile(
      compileKnown(current, [{ id: 1, label: "incoming" }], [{ boardId: 2 }])
    );
    const relationWrites = writes(compiled).filter((step) =>
      step.id.startsWith("board.")
    );

    expect(relationWrites.map((step) => step.id)).toEqual([
      "board.slot.vacate",
      "board.junction.insert",
    ]);
    expect(relationWrites[0]?.expects).toMatchObject({
      kind: "affectedRows",
      expected: 1,
    });
  });
});
