// What the schema diagram shows, computed here; `SchemaDiagram` draws it.
// Each model is a card of its columns then its relations; each edge a line
// from the columns that hold a key to the key they point to, its ends in
// crow's foot notation. Where the cards stand is `schema-layout`.
import type { StudioEdge, StudioModel, StudioSchema } from "./api";

export const CARD_WIDTH = 280;
export const CARD_HEADER = 44;
export const CARD_ROW = 28;

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
