import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import type {
  OperationFragment,
  WriteStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { planningKey } from "@src/query-engine/write-engine/Part";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { prepareSchema } from "@tests/fixtures/query-scope";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * ONE ordered step sequence per nested relation VERB on an ordinary
 * many-to-many, plus the two singular member-junction verbs nothing else spells
 * standalone. The verb is the dimension: a payload keyword must reach exactly
 * one lowering in `RelationJunctionPart.allocatePlan` (:1381) and emit that
 * plan's writes in that plan's order.
 *
 * Deliberately NOT restated here, because each already has an owner:
 *  - `updateMany` / `deleteMany` / correlated `upsert` on this same junction —
 *    `relation-junction-collection-coverage.core.test.ts:135,:155,:181`, which
 *    also pins their parameters.
 *  - every singular member-junction supplier (`create`, `connectOrCreate`,
 *    `upsert`, correlated `update`, the slot transfer and its vacate) —
 *    `relation-junction-singular-coverage.core.test.ts`.
 *  - variant collection labels and their step ids —
 *    `relation-write-parity-anchors.core.test.ts`.
 *  - the behavioral oracle for all of them — `m2m-mutation.test.ts` (PGlite).
 */

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

function planningDriver(): PlanningDriver {
  return new PlanningDriver("postgresql", {
    supportsTransactions: true,
    supportsBatch: true,
  });
}

function collectionOperation(data: Record<string, unknown>): UpdateOperation {
  const schemas = createSchemaRegistry(collectionSchema);
  const engine = new QueryEngine(
    planningDriver(),
    createModelRegistry(collectionSchema, schemas)
  );
  return new UpdateOperation(engine, collectionSchema.author, {
    where: { id: 1 },
    data,
    select: { id: true },
  });
}

function singularOperation(data: Record<string, unknown>): UpdateOperation {
  const schemas = createSchemaRegistry(singularSchema);
  const engine = new QueryEngine(
    planningDriver(),
    createModelRegistry(singularSchema, schemas)
  );
  return new UpdateOperation(engine, singularSchema.clip, {
    where: { id: 30 },
    data,
    select: { id: true },
  });
}

/**
 * Publish one row set per planning read: the root locate answers with its own
 * row, every relation probe with the captured target set.
 */
function knownRows(
  operation: UpdateOperation,
  rootLocate: { readonly id: string; readonly row: Record<string, unknown> },
  relationRows: readonly Record<string, unknown>[]
): Record<string, unknown> {
  return Object.fromEntries(
    operation
      .planning()
      .steps.map((step) => [
        planningKey(step.id, "rows"),
        step.id === rootLocate.id ? [rootLocate.row] : relationRows,
      ])
  );
}

const AUTHOR_LOCATE = {
  id: "author.locate",
  row: { id: 1, name: "author" },
};
const CLIP_LOCATE = { id: "clip.locate", row: { id: 30, title: "clip" } };

function relationStepIds(
  fragment: OperationFragment,
  prefix: string
): readonly string[] {
  return fragment.steps
    .filter((step) => step.id.startsWith(prefix))
    .map((step) => step.id);
}

function sqlText(step: WriteStep): string {
  return step.statement.strings.join("?");
}

function writes(fragment: OperationFragment): readonly WriteStep[] {
  return fragment.steps.filter(
    (step): step is WriteStep => step.kind === "write"
  );
}

describe("collection junction mutation matrix", () => {
  // Each row is the plan `allocatePlan` must select and the exact ordered writes
  // that plan emits under an interactive transaction (no premise guards). A verb
  // that silently reached another plan — `set` skipping its clear, `delete`
  // dropping the membership row before the target row, `connect` writing the
  // target table — changes this list.
  for (const scenario of [
    {
      name: "connect",
      data: { tags: { connect: [{ id: 20 }] } },
      steps: ["tag.connect"],
    },
    {
      name: "disconnect",
      data: { tags: { disconnect: [{ id: 20 }] } },
      steps: ["tag.disconnect"],
    },
    {
      name: "set",
      data: { tags: { set: [{ id: 20 }] } },
      steps: ["tag.set.clear", "tag.set.insert"],
    },
    {
      name: "create",
      data: { tags: { create: [{ id: 21, label: "created" }] } },
      steps: ["tag.create", "tag.junction.insert"],
    },
    {
      name: "update",
      data: {
        tags: { update: [{ where: { id: 20 }, data: { label: "updated" } }] },
      },
      steps: ["tag.update"],
    },
    {
      name: "delete",
      data: { tags: { delete: [{ id: 20 }] } },
      steps: ["tag.delete", "tag.delete.child"],
    },
    {
      name: "connectOrCreate",
      data: {
        tags: {
          connectOrCreate: {
            where: { id: 20 },
            create: { id: 20, label: "unused" },
          },
        },
      },
      steps: ["tag.junction.insert"],
    },
  ]) {
    test(`${scenario.name} compiles its plan's ordered writes`, () => {
      const operation = collectionOperation(scenario.data);
      const compiled = operation.compile(
        knownRows(operation, AUTHOR_LOCATE, [{ id: 20, label: "before" }])
      );

      expect(relationStepIds(compiled, "tag.")).toEqual(scenario.steps);
    });
  }

  test("createMany writes the target rows and their junction memberships", () => {
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
    const compiled = operation.compile(knownRows(operation, AUTHOR_LOCATE, []));
    const statements = writes(compiled).map(sqlText);

    // Two tables, not one: a bulk arm that inserted only the targets would leave
    // them unreachable from this author.
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
});

describe("singular member-junction removal verbs", () => {
  // `RelationJunctionToOnePart`'s measured facts 1 and 2: the ordinary junction
  // lowerings answer both of these wrongly for a singular slot, so this owner
  // exists precisely to keep them apart. `disconnect` drops the membership and
  // KEEPS the owner row; `delete` drops the membership and then the one captured
  // owner row behind it.
  test("disconnect removes only the membership row", () => {
    const operation = singularOperation({ board: { disconnect: true } });
    const compiled = operation.compile(
      knownRows(operation, CLIP_LOCATE, [{ id: 2, label: "connected" }])
    );

    expect(relationStepIds(compiled, "board.")).toEqual([
      "board.junction.delete",
    ]);
  });

  test("delete removes the membership and then the one connected owner", () => {
    const operation = singularOperation({ board: { delete: true } });
    const compiled = operation.compile(
      knownRows(operation, CLIP_LOCATE, [{ id: 2, label: "connected" }])
    );

    expect(relationStepIds(compiled, "board.")).toEqual([
      "board.junction.delete",
      "board.delete",
    ]);
  });
});
