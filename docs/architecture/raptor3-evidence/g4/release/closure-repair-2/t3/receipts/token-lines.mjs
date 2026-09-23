// The census's OWN token-line function, applied to the two files this unit
// touched, before (the base copies) and after.
import { readFileSync } from "node:fs";
import ts from "/private/tmp/viborm-tm/node_modules/typescript/lib/typescript.js";

function countTokenLines(sourceFile) {
  const tokenLineNumbers = new Set();
  function visit(node) {
    if (ts.isJSDoc(node)) return;
    const children = node.getChildren(sourceFile);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    if (
      node.kind < ts.SyntaxKind.FirstToken ||
      node.kind > ts.SyntaxKind.LastToken ||
      node.kind === ts.SyntaxKind.EndOfFileToken
    ) {
      return;
    }
    tokenLineNumbers.add(
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
    );
  }
  visit(sourceFile);
  return tokenLineNumbers.size;
}

const count = (file) => {
  const source = readFileSync(file, "utf8");
  return countTokenLines(
    ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  );
};

const pairs = [
  [
    "src/migrations/drivers/mysql/introspect.ts",
    "/private/tmp/viborm-tm-tmp/base/src/migrations/drivers/mysql/introspect.ts",
    "/private/tmp/viborm-tm/src/migrations/drivers/mysql/introspect.ts",
  ],
  [
    "src/migrations/drivers/type-mapping.ts",
    "/private/tmp/viborm-tm-tmp/base/src/migrations/drivers/type-mapping.ts",
    "/private/tmp/viborm-tm/src/migrations/drivers/type-mapping.ts",
  ],
  [
    "src/migrations/identity.ts",
    "/private/tmp/viborm-tm-tmp/base/src/migrations/identity.ts",
    "/private/tmp/viborm-tm/src/migrations/identity.ts",
  ],
];
let before = 0;
let after = 0;
for (const [label, basePath, nowPath] of pairs) {
  const b = count(basePath);
  const a = count(nowPath);
  before += b;
  after += a;
  console.log(`${label}: ${b} -> ${a} (${a - b >= 0 ? "+" : ""}${a - b})`);
}
console.log(`total: ${before} -> ${after} (+${after - before})`);
