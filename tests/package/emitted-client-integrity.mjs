// biome-ignore-all lint/suspicious/noMisplacedAssertion: This assertion helper is invoked by standalone package smokes and focused runtime tests.

/** Inspect the materialized chain5 client; never recompute links from models. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function literal(ts, node) {
  if (node && ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal))
    return node.literal.text;
  assert.ok(node && ts.isTypeLiteralNode(node), "Link table must be literal");
  const entries = node.members.map((member) => {
    assert.ok(
      ts.isPropertySignature(member) &&
        !member.questionToken &&
        (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)),
      "Link entries must be required named properties"
    );
    return [member.name.text, literal(ts, member.type)];
  });
  assert.equal(new Set(entries.map(([key]) => key)).size, entries.length);
  return Object.fromEntries(entries);
}

export function assertChain5ClientIntegrity(declaration) {
  const ts = require("typescript");
  const parsed = ts.createSourceFile(
    "producer.d.ts",
    declaration,
    ts.ScriptTarget.Latest,
    true
  );
  assert.equal(parsed.parseDiagnostics.length, 0, "Malformed declaration");
  const aliases = new Map();
  const localValues = new Set();
  const namespaces = new Set();
  for (const statement of parsed.statements) {
    if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
      namespaces.add(statement.name.text);
      localValues.add(statement.name.text);
    }
    if (
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      (ts.isClassDeclaration(statement) && statement.name)
    )
      aliases.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const value of statement.declarationList.declarations)
        if (ts.isIdentifier(value.name)) localValues.add(value.name.text);
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    )
      localValues.add(statement.name.text);
  }
  let client;
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const value of statement.declarationList.declarations) {
      if (ts.isIdentifier(value.name) && value.name.text === "db") {
        assert.equal(client, undefined, "Client declaration must be unique");
        client = value.type;
      }
    }
  }
  assert.ok(client, "Missing emitted db type");
  const refuseElision = (node) => {
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      ts.LanguageVariant.Standard,
      node.getFullText(parsed)
    );
    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      if (
        token === ts.SyntaxKind.MultiLineCommentTrivia ||
        token === ts.SyntaxKind.SingleLineCommentTrivia
      )
        assert.ok(
          !scanner.getTokenText().includes("elided"),
          "Client type was elided"
        );
    }
  };
  refuseElision(client);
  const tables = [];
  const table = (node) => {
    let value = node;
    if (node && ts.isUnionTypeNode(node)) {
      const present = node.types.filter(
        (type) => type.kind !== ts.SyntaxKind.UndefinedKeyword
      );
      assert.equal(present.length, 1, "Link marker cannot contain a union");
      value = present[0];
    }
    tables.push(literal(ts, value));
  };
  const inspectedAliases = new Set();
  const visit = (node) => {
    if (ts.isTypeQueryNode(node)) {
      let name = node.exprName;
      while (ts.isQualifiedName(name)) name = name.left;
      assert.ok(
        !(ts.isIdentifier(name) && localValues.has(name.text)),
        "Local value query hides the client schema"
      );
    }
    // Imported library types stay opaque; producer-local schema aliases must
    // either expose their complete non-generic syntax or fail closed.
    if (ts.isTypeReferenceNode(node) && ts.isQualifiedName(node.typeName)) {
      let name = node.typeName;
      while (ts.isQualifiedName(name)) name = name.left;
      assert.ok(
        !namespaces.has(name.text),
        "Unresolved local client type alias"
      );
    }
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      aliases.has(node.typeName.text)
    ) {
      const alias = aliases.get(node.typeName.text);
      assert.ok(
        ts.isTypeAliasDeclaration(alias) && !alias.typeParameters?.length,
        "Unresolved local client type alias"
      );
      if (!inspectedAliases.has(alias)) {
        inspectedAliases.add(alias);
        refuseElision(alias.type);
        visit(alias.type);
      }
    }
    if (
      (ts.isImportTypeNode(node) &&
        node.qualifier?.getText(parsed) === "Links") ||
      (ts.isTypeReferenceNode(node) &&
        node.typeName.getText(parsed).split(".").at(-1) === "Links")
    ) {
      table(node.typeArguments?.[0]);
      return;
    }
    if (
      (ts.isPropertySignature(node) || ts.isMethodSignature(node)) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    ) {
      if (node.name.text === "getter")
        assert.ok(
          ts.isPropertySignature(node) &&
            node.type?.kind === ts.SyntaxKind.UnknownKeyword,
          "Original callable getter survived client emission"
        );
      if (node.name.text === " vibLinks" && ts.isPropertySignature(node)) {
        table(node.type);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(client);
  assert.ok(tables.length > 0, "Missing literal client link table");
  const expected = {};
  for (let index = 0; index < 5; index++) {
    expected[`m${index}`] = {
      ...(index > 0 ? { parent: `m${index - 1}` } : {}),
      ...(index < 4 ? { children: `m${index + 1}` } : {}),
    };
  }
  for (const actual of tables)
    assert.deepEqual(
      actual,
      expected,
      "Client links differ from the complete chain5 graph"
    );
}
