import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const V2 = join(ROOT, "src/query-engine/write-engine");
const ADAPTERS = join(ROOT, "src/adapters");

const EXECUTOR = join(V2, "OperationExecutor.ts");
const FRAGMENT = join(V2, "OperationFragment.ts");

// Operation-kind and relation-kind tokens the executor must never learn. Generic
// words (set, count, exist) are deliberately excluded — they collide with Map.set
// and rowCount and carry no semantic leak on their own.
const OPERATION_KIND_TOKENS =
  /\b(?:create|update|upsert|delete|findUnique|findMany|findFirst|createMany|updateMany|deleteMany|aggregate|groupBy|connect|disconnect|connectOrCreate|oneToMany|manyToOne|manyToMany|oneToOne)\b/i;

const CONCRETE_OPERATION_MODULE = /Operation$/;
const STEP_VOCABULARY =
  /\b(?:StatementStep|GuardStep|OperationStep|OperationFragment)\b/;

// The complete, intentional vocabulary of the fragment module (ATOM §1, §2).
const FRAGMENT_TYPE_NAMES = [
  "Failure",
  "FragmentOutputSource",
  "GuardStep",
  "OperationFragment",
  "OperationStep",
  "OperationValueReference",
  "Postcondition",
  "Probe",
  "StatementOutputSource",
  "StatementStep",
  "TargetConstraintPin",
].sort();

function listTypeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listTypeScriptFiles(path) : [path];
    })
    .filter((path) => path.endsWith(".ts"));
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    basename(path),
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
}

function importSpecifiers(file: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}

function isExported(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    )
  );
}

function normalize(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface ExportedType {
  readonly name: string;
  readonly text: string;
}

function exportedTypeSurface(file: ts.SourceFile): ExportedType[] {
  const entries: ExportedType[] = [];
  for (const statement of file.statements) {
    if (!isExported(statement)) continue;
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    ) {
      entries.push({
        name: statement.name.text,
        text: normalize(statement.getText(file)),
      });
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function stepKindLiterals(file: ts.SourceFile): string[] {
  const literals = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    if (
      !(
        statement.name.text === "StatementStep" ||
        statement.name.text === "GuardStep"
      )
    ) {
      continue;
    }
    for (const member of statement.members) {
      if (
        !(
          ts.isPropertySignature(member) &&
          member.name &&
          ts.isIdentifier(member.name) &&
          member.name.text === "kind" &&
          member.type
        )
      ) {
        continue;
      }
      collectStringLiterals(member.type, literals);
    }
  }
  return [...literals].sort();
}

function collectStringLiterals(node: ts.TypeNode, into: Set<string>): void {
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    into.add(node.literal.text);
    return;
  }
  if (ts.isUnionTypeNode(node)) {
    for (const member of node.types) collectStringLiterals(member, into);
  }
}

describe("query-engine-v2 structural gates (PLAN P0)", () => {
  it("(a) keeps the executor free of operation semantics", () => {
    const source = readFileSync(EXECUTOR, "utf8");
    const match = OPERATION_KIND_TOKENS.exec(source);
    expect(match?.[0] ?? null).toBeNull();

    const concreteOperationImports = importSpecifiers(parse(EXECUTOR)).filter(
      (specifier) => CONCRETE_OPERATION_MODULE.test(basename(specifier))
    );
    expect(concreteOperationImports).toEqual([]);
  });

  it("(b) forbids adapters from constructing a Step", () => {
    const offenders = listTypeScriptFiles(ADAPTERS).filter((path) => {
      const source = readFileSync(path, "utf8");
      const referencesVocabulary = STEP_VOCABULARY.test(source);
      const importsFragment = importSpecifiers(parse(path)).some((specifier) =>
        specifier.includes("query-engine-v2")
      );
      return referencesVocabulary || importsFragment;
    });
    expect(offenders).toEqual([]);
  });

  it("(c) freezes the fragment module's exported type surface", () => {
    const surface = exportedTypeSurface(parse(FRAGMENT))
      .map((entry) => entry.text)
      .join("\n\n");
    // A deliberate vocabulary change updates this snapshot plus a design note;
    // any accidental drift fails the gate mechanically.
    expect(surface).toMatchSnapshot();
  });

  it("(d) keeps the step vocabulary at exactly read/write/guard + census types", () => {
    const file = parse(FRAGMENT);
    expect(stepKindLiterals(file)).toEqual(["guard", "read", "write"]);
    expect(exportedTypeSurface(file).map((entry) => entry.name)).toEqual(
      FRAGMENT_TYPE_NAMES
    );
  });
});
