import { readFileSync, statSync } from "node:fs";
import ts from "typescript";

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
    ) return;
    tokenLineNumbers.add(
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
    );
  }
  visit(sourceFile);
  return tokenLineNumbers.size;
}

const files = process.argv.slice(2);
let bytes = 0, physical = 0, tokens = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  bytes += statSync(file).size;
  physical += text.split("\n").length - 1;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  tokens += countTokenLines(source);
}
console.log(JSON.stringify({ files: files.length, bytes, physical, tokenLines: tokens }));
