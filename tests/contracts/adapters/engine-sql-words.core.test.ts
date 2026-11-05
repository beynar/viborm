/**
 * The query engine states no SQL word: the adapter owns the language
 * (`src/adapters/AGENTS.md`). Read from the AST, so a template spanning lines,
 * a raw string and a separator handed to `sql.join` all count, and comments and
 * error sentences do not.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ENGINE = join(process.cwd(), "src/query-engine");
const SQL_WORD =
  /\b(?:SELECT|FROM|WHERE|JOIN|LATERAL|WITH|RECURSIVE|EXISTS|UNION|INTERSECT|EXCEPT|VALUES|INSERT|UPDATE|DELETE|RETURNING|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|DISTINCT|CASE|WHEN|THEN|ELSE|END|AND|OR|NOT|NULL|AS|IN|ON|SET|CONFLICT|NOTHING|COALESCE|CAST|FOR UPDATE)\b/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** The literal text of a template or string: its substitutions are not text. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return [
      node.head.text,
      ...node.templateSpans.map((span) => span.literal.text),
    ].join(" ");
  return undefined;
}

/** The node whose text is SQL, or a text test that reads SQL back. */
function sqlText(node: ts.Node): ts.Node | undefined {
  if (ts.isTaggedTemplateExpression(node)) {
    const tag = node.tag.getText();
    return tag === "sql" || tag === "sql.raw" ? node.template : undefined;
  }
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression.getText();
  if (callee === "sql.raw") return node.arguments[0];
  if (callee === "sql.join") return node.arguments[1];
  return callee.endsWith(".startsWith") ? node.arguments[0] : undefined;
}

function sqlWordSites(path: string): string[] {
  const file = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const sites: string[] = [];
  const visit = (node: ts.Node): void => {
    const held = sqlText(node);
    const text = held && literalText(held);
    if (text !== undefined && SQL_WORD.test(text)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart());
      sites.push(
        `${relative(process.cwd(), path)}:${line + 1} ${text.replace(/\s+/g, " ").trim()}`
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
}

describe("the query engine states no SQL word", () => {
  it("leaves every keyword to the adapter", () => {
    expect(sourceFiles(ENGINE).flatMap(sqlWordSites)).toEqual([]);
  });
});
