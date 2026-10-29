// What the schema diagram shows, computed here; `SchemaDiagram` draws it.
// Each model is a card of its columns then its relations; each edge a line
// from the columns that hold a key to the key they point to, its ends in
// crow's foot notation. Layout and line routing follow Pyxel's diagram.
import type { StudioEdge, StudioModel, StudioSchema } from "./api";

export const CARD_WIDTH = 280;
export const CARD_HEADER = 44;
export const CARD_ROW = 28;
const COLUMN_GAP = 220;
const ROW_GAP = 96;

export const cardHeight = (model: StudioModel) =>
  CARD_HEADER +
  (model.fields.length + model.relations.length) * CARD_ROW +
  (model.relations.length > 0 ? 9 : 0) +
  8;

export type End = StudioEdge["fromEnd"];
export const END_LABELS: Record<End, string> = {
  one: "exactly one",
  "zero-or-one": "zero or one",
  "zero-or-many": "zero or many",
};

/** A line: one column pair of an edge, or the edge itself when it holds no columns. */
export interface Link {
  readonly id: string;
  readonly edge: StudioEdge;
  readonly from: string;
  readonly fromAnchor: string;
  readonly to: string;
  readonly toAnchor: string;
}

/** The anchor a line meets a card at: a column, or a relation row. */
export const columnAnchor = (column: string) => `c:${column}`;
export const relationAnchor = (relation: string) => `r:${relation}`;
export const handleOf = (anchor: string, side: "left" | "right") =>
  `${anchor}:${side}`;

export function linksOf(schema: StudioSchema): Link[] {
  return schema.edges.flatMap((edge) => {
    // A many-to-many line joins the two relations: neither model holds a key.
    if (edge.kind === "many-to-many") {
      return [
        {
          id: edge.id,
          edge,
          from: edge.from.model,
          fromAnchor: relationAnchor(edge.from.relation),
          to: edge.to.model,
          toAnchor: relationAnchor(edge.to.relation ?? ""),
        },
      ];
    }
    const pairs = Math.max(edge.from.columns.length, 1);
    return Array.from({ length: pairs }, (_, index) => {
      const fromColumn = edge.from.columns[index];
      const toColumn = edge.to.columns[index] ?? edge.to.columns[0];
      return {
        id: pairs > 1 ? `${edge.id}.${index}` : edge.id,
        edge,
        from: edge.from.model,
        fromAnchor:
          fromColumn === undefined
            ? relationAnchor(edge.from.relation)
            : columnAnchor(fromColumn),
        to: edge.to.model,
        toAnchor:
          toColumn === undefined
            ? relationAnchor(edge.to.relation ?? "")
            : columnAnchor(toColumn),
      };
    });
  });
}

/**
 * Where each card stands: the models pointed to on the left, each model one
 * column right of the deepest it points to; in a column, by name, one under
 * another. A loop of relations stops where it would come back.
 */
export function schemaLayout(
  schema: StudioSchema
): Map<string, { x: number; y: number }> {
  const byName = new Map(schema.models.map((model) => [model.name, model]));
  const pointsTo = new Map<string, string[]>();
  for (const edge of schema.edges) {
    if (edge.kind === "many-to-many" || edge.from.model === edge.to.model) {
      continue;
    }
    const targets = pointsTo.get(edge.from.model) ?? [];
    targets.push(edge.to.model);
    pointsTo.set(edge.from.model, targets);
  }
  const levels = new Map<string, number>();
  const levelOf = (name: string, seen: ReadonlySet<string>): number => {
    const known = levels.get(name);
    if (known !== undefined) return known;
    const targets = (pointsTo.get(name) ?? []).filter(
      (target) => !seen.has(target) && byName.has(target)
    );
    const level =
      targets.length > 0
        ? 1 +
          Math.max(
            ...targets.map((target) =>
              levelOf(target, new Set([...seen, name]))
            )
          )
        : 0;
    levels.set(name, level);
    return level;
  };
  for (const model of schema.models) levelOf(model.name, new Set());
  const columns = new Map<number, StudioModel[]>();
  for (const model of [...schema.models].sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const level = levels.get(model.name) ?? 0;
    columns.set(level, [...(columns.get(level) ?? []), model]);
  }
  const at = new Map<string, { x: number; y: number }>();
  for (const [level, column] of columns) {
    let y = 0;
    for (const model of column) {
      at.set(model.name, { x: level * (CARD_WIDTH + COLUMN_GAP), y });
      y += cardHeight(model) + ROW_GAP;
    }
  }
  return at;
}
