import { s } from "@schema";
import type {
  GeneratedRecurrenceOperation,
  RecurrenceRecipe,
  RecurrenceWorld,
} from "./recurrence-world";
import { compareText } from "./recurrence-world";

function nodeId(recipe: RecurrenceRecipe, operation: number, path: string) {
  return `n-${recipe.seed}-${operation}-${path}`;
}

function nodeBody(
  recipe: RecurrenceRecipe,
  operation: number,
  level: number,
  repeated: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: nodeId(recipe, operation, `s${level}`),
    label: `level-${level}`,
  };
  if (level >= recipe.depth) return body;
  const children = [
    nodeBody(recipe, operation, level + 1, repeated),
    ...Array.from({ length: recipe.fanout }, (_, index) => ({
      id: nodeId(recipe, operation, `s${level}-f${index}`),
      label: `leaf-${level}-${index}`,
    })),
  ];
  body.children = repeated
    ? { createMany: { data: children } }
    : { create: children };
  return body;
}

function expectedNodeRows(
  recipe: RecurrenceRecipe,
  successful: (operation: number) => boolean
) {
  const rows: { id: string; label: string; parentId: string | null }[] = [];
  for (let operation = 0; operation < recipe.operations; operation++) {
    if (!successful(operation)) continue;
    for (let level = 0; level <= recipe.depth; level++) {
      const id = nodeId(recipe, operation, `s${level}`);
      rows.push({
        id,
        label: `level-${level}`,
        parentId:
          level === 0 ? null : nodeId(recipe, operation, `s${level - 1}`),
      });
      if (level === recipe.depth) continue;
      for (let index = 0; index < recipe.fanout; index++)
        rows.push({
          id: nodeId(recipe, operation, `s${level}-f${index}`),
          label: `leaf-${level}-${index}`,
          parentId: id,
        });
    }
  }
  return rows.sort((left, right) => compareText(left.id, right.id));
}

export function recurrenceOrdinaryWorld(
  recipe: RecurrenceRecipe,
  repeated: boolean
): RecurrenceWorld {
  const node = s
    .model({
      id: s.string().id(),
      label: s.string(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => node),
    })
    .map("g3_generated_recurrence_nodes");
  const schema = { node };
  const operations = Array.from(
    { length: recipe.operations },
    (_, operation): GeneratedRecurrenceOperation => ({
      model: "node",
      operation: "create",
      args: {
        data: nodeBody(recipe, operation, 0, repeated),
        select: { id: true },
      },
      expected: { id: nodeId(recipe, operation, "s0") },
    })
  );
  const initial = { nodes: [] };
  const final = {
    nodes: expectedNodeRows(
      recipe,
      (operation) => recipe.fault === "none" || operation !== 0
    ),
  };
  return {
    schema,
    operations,
    initial,
    final,
    seed(database) {
      database.exec(`
        CREATE TABLE g3_generated_recurrence_nodes(
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          parentId TEXT REFERENCES g3_generated_recurrence_nodes(id)
        ) STRICT;
      `);
    },
    inspect(database) {
      return {
        nodes: database
          .prepare(
            "SELECT id,label,parentId FROM g3_generated_recurrence_nodes ORDER BY id"
          )
          .all(),
      };
    },
  };
}
