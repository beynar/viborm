/**
 * `commands/` says what a write means and describes the rows it asks about; it
 * spells no condition (`docs/architecture/query-backend-frontier.md`). Read from
 * the AST, so an adapter held in a local counts. What it may still read of an
 * adapter are strategy facts: `capabilities`, and the two named below.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const COMMANDS = join(process.cwd(), "src/query-engine/raptor3/commands");
const ADAPTER_SYNTAX = new Set([
  "identifiers",
  "literals",
  "operators",
  "expressions",
  "aggregates",
  "json",
  "arrays",
  "orderBy",
  "clauses",
  "set",
  "filters",
  "subqueries",
  "cte",
  "mutations",
  "assertions",
  "joins",
  "setOperations",
  "vector",
  "geoPoint",
]);
const STRATEGY_FACTS = new Set(["upserted", "skipDuplicatesStrategy"]);
const QUERIES_SYNTAX = new Set([
  "column",
  "fieldValue",
  "updateValue",
  "lowerIdentity",
]);
const ADAPTER = /(?:^|\.)(?:a|adapter)$/;
const QUERIES = /(?:^|\.)(?:q|queries)$/;

function spelledSite(node: ts.PropertyAccessExpression): boolean {
  const owner = node.expression.getText();
  const member = node.name.text;
  if (QUERIES.test(owner)) return QUERIES_SYNTAX.has(member);
  if (!(ADAPTER.test(owner) && ADAPTER_SYNTAX.has(member))) return false;
  const { parent } = node;
  return !(
    member === "mutations" &&
    ts.isPropertyAccessExpression(parent) &&
    STRATEGY_FACTS.has(parent.name.text)
  );
}

function spelledSites(path: string): string[] {
  const file = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const sites: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && spelledSite(node)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart());
      sites.push(
        `${relative(process.cwd(), path)}:${line + 1} ${node.getText()}`
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
}

describe("commands/ states no syntax", () => {
  it("describes its conditions and leaves spelling them to the lowering", () => {
    const files = readdirSync(COMMANDS)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(COMMANDS, name));
    expect(files.flatMap(spelledSites)).toEqual([]);
  });
});
