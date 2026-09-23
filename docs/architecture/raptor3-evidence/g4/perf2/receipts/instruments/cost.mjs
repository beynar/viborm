/** Charged-cost census, same countTokenLines function as scripts/query-engine-structure.mjs. */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";

function countTokenLines(sourceFile) {
  const tokenLineNumbers = new Set();
  function visit(node) {
    if (ts.isJSDoc(node)) return;
    const children = node.getChildren(sourceFile);
    if (children.length > 0) { for (const child of children) visit(child); return; }
    if (node.kind < ts.SyntaxKind.FirstToken || node.kind > ts.SyntaxKind.LastToken ||
        node.kind === ts.SyntaxKind.EndOfFileToken) return;
    tokenLineNumbers.add(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line);
  }
  visit(sourceFile);
  return tokenLineNumbers.size;
}

function measure(name, source) {
  const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  return { bytes: Buffer.byteLength(source), physical: source.split("\n").length, tokenLines: countTokenLines(sf) };
}

const core = [
  "src/query-engine/raptor3/commands/assignments.ts",
  "src/query-engine/raptor3/commands/command-attempt.ts",
  "src/query-engine/raptor3/commands/commands.ts",
  "src/query-engine/raptor3/commands/execution.ts",
  "src/query-engine/raptor3/commands/index.ts",
  "src/query-engine/raptor3/commands/relation-body.ts",
  "src/query-engine/raptor3/commands/selection.ts",
  "src/query-engine/raptor3/route/client-route.ts",
  "src/query-engine/raptor3/shared/operation-context.ts",
  "src/query-engine/raptor3/shared/query.ts",
  "src/query-engine/raptor3/shared/schema.ts",
  "src/query-engine/raptor3/shared/storage.ts",
  "src/query-engine/raptor3/shared/transport-attempt.ts",
];
const specimen = [
  "src/query-engine/raptor3/program/index.ts",
  "src/query-engine/raptor3/program/program.ts",
];
const head = (file) => execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const now = (file) => readFileSync(file, "utf8");

const rows = [];
for (const file of [...core, ...specimen]) {
  const before = measure(file, head(file));
  const after = measure(file, now(file));
  rows.push({ file, set: core.includes(file) ? "candidate core" : "retained specimen", before, after,
    delta: { bytes: after.bytes - before.bytes, physical: after.physical - before.physical, tokenLines: after.tokenLines - before.tokenLines } });
}
const sum = (list, side) => list.reduce((total, row) => ({
  files: total.files + 1, bytes: total.bytes + row[side].bytes,
  physical: total.physical + row[side].physical, tokenLines: total.tokenLines + row[side].tokenLines,
}), { files: 0, bytes: 0, physical: 0, tokenLines: 0 });
const coreRows = rows.filter((row) => row.set === "candidate core");
const allRows = rows;
const report = {
  censusOwner: "scripts/query-engine-structure.mjs countTokenLines (copied verbatim)",
  base: execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(),
  perFile: rows,
  candidateCore: { before: sum(coreRows, "before"), after: sum(coreRows, "after") },
  candidateCorePlusSpecimen: { before: sum(allRows, "before"), after: sum(allRows, "after") },
};
writeFileSync(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
for (const row of rows)
  if (row.delta.bytes || row.delta.physical || row.delta.tokenLines)
    console.log(`${row.file}: ${row.before.bytes}/${row.before.physical}/${row.before.tokenLines} -> ${row.after.bytes}/${row.after.physical}/${row.after.tokenLines}  (${row.delta.bytes >= 0 ? "+" : ""}${row.delta.bytes} B, ${row.delta.physical >= 0 ? "+" : ""}${row.delta.physical} phys, ${row.delta.tokenLines >= 0 ? "+" : ""}${row.delta.tokenLines} token-lines)`);
console.log("candidate core (13 files):", JSON.stringify(report.candidateCore));
console.log("core + retained specimen (15 files):", JSON.stringify(report.candidateCorePlusSpecimen));
