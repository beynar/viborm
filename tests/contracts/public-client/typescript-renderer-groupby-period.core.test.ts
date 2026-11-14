/**
 * `renderOperationResultType` for `groupBy` by a time step: the stepped
 * column renders as the period's string, like `GroupByResultType` types it.
 */

import { renderOperationResultType } from "@client/schema-introspection";
import { s } from "@schema";
import { expect, test } from "vitest";

const facture = s.model({
  id: s.int().id(),
  statut: s.string(),
  montant: s.int(),
  date: s.dateTime(),
  dueAt: s.dateTime().nullable(),
});
const schema = { facture };

test("a stepped column renders as string, null kept where the column is nullable", () => {
  expect(
    renderOperationResultType(schema, "facture", "groupBy", {
      by: ["statut", { date: "month" }, { dueAt: "week" }],
      _count: true,
    })
  ).toBe(
    [
      "Array<{",
      "  statut: string;",
      "  date: string;",
      "  dueAt: string | null;",
      "  _count: number;",
      "}>",
    ].join("\n")
  );
  // Without a step the same column renders as its Date.
  expect(
    renderOperationResultType(schema, "facture", "groupBy", {
      by: ["date"],
      _count: true,
    })
  ).toBe(["Array<{", "  date: Date;", "  _count: number;", "}>"].join("\n"));
});
