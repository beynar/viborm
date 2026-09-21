// T3's own receipt (`../../t3/receipts/token-lines.mjs`), repointed at this
// lane's worktree and TMPDIR — T3's were `/private/tmp/viborm-tm`, which no
// longer exists. Nothing else was changed: the census's token-line function is
// byte-identical, and the BASE column reproduces T3's own 385 / 220 / 48.
//
// The base copies were extracted read-only from the round's base commit:
//   git show 88fe2814b:<path> > $TMPDIR/base/<path>
// for the three files below. Output: `01-token-lines.log`.
// The census's OWN token-line function, applied to the two files this unit
// touched, before (the base copies) and after.
import { readFileSync } from "node:fs";
import ts from "/private/tmp/viborm-tint/node_modules/typescript/lib/typescript.js";

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
    "/private/tmp/viborm-tint-tmp/base/src/migrations/drivers/mysql/introspect.ts",
    "/private/tmp/viborm-tint/src/migrations/drivers/mysql/introspect.ts",
  ],
  [
    "src/migrations/drivers/type-mapping.ts",
    "/private/tmp/viborm-tint-tmp/base/src/migrations/drivers/type-mapping.ts",
    "/private/tmp/viborm-tint/src/migrations/drivers/type-mapping.ts",
  ],
  [
    "src/migrations/identity.ts",
    "/private/tmp/viborm-tint-tmp/base/src/migrations/identity.ts",
    "/private/tmp/viborm-tint/src/migrations/identity.ts",
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
