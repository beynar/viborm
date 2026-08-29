import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";

/**
 * The shipped-source census for the one fixed-decimal language.
 *
 * Six detectors own disjoint structural publication shapes. They do not scan
 * comments, resolve imports, or claim whole-program dataflow: architecture
 * prose may name a rejected concept without recreating it, and a detector is
 * evidence only for the explicit source boundary and AST shapes it admits.
 * Each result is an exact `"<file> <token> <count>"` entry so a new spelling or
 * an additional site is visible rather than collapsed to one Boolean.
 *
 * The estate is every tracked or non-ignored untracked parseable source file in
 * `src/**`, minus tracked working-tree deletions. This is the same publication
 * boundary as the database-namespace census.
 */

export const REJECTED_DECIMAL_MODE_MEMBERS = [
  "fixed",
  "fixedDecimal",
  "decimalMode",
  "native",
  "nativeDecimal",
  "nativeType",
  "unconstrained",
  "unconstrainedDecimal",
] as const;

export const DECIMAL_FLOAT_TRANSPORT_EXEMPTIONS = [
  "src/migrations/decimal.ts readStoredDecimalInteger Number(value)",
  "src/validation/primitives/decimal-codec.ts expandExponentForm Number(exponentText)",
] as const;

export const REJECTED_DECIMAL_FLOAT_TRANSPORT_TOKENS = [
  "Number",
  "Number.parseFloat",
  "numberType",
  "parseFloat",
  "unaryPlus",
] as const;

export const REJECTED_DECIMAL_RESULT_MEMBERS = [
  "decimalDecode",
  "decimalResult",
  "decimalResultMode",
] as const;

export const REJECTED_DECIMAL_WRAPPER_NAMES = [
  "DecimalManager",
  "DecimalValue",
  "DecimalWrapper",
  "VibDecimal",
] as const;

export const DECIMAL_OPERATION_KEYS = [
  "set",
  "increment",
  "decrement",
  "multiply",
  "divide",
  "push",
  "unshift",
] as const;

export const REJECTED_DECIMAL_REFUSAL_NAMES = [
  "assertExactDecimal*",
  "decimal-portability",
  "supportsExactDecimal",
] as const;

const DECIMAL_PUBLIC_ENTRY_OWNERS = [
  "src/index.ts",
  "src/schema/exports.ts",
] as const;
const DECIMAL_PUBLIC_REGIONS = [
  ...DECIMAL_PUBLIC_ENTRY_OWNERS,
  "src/schema/index.ts",
  "src/schema/scalars/index.ts",
  "src/schema/scalars/decimal/",
] as const;
const DECIMAL_DESCRIPTOR_OWNER = "src/validation/primitives/decimal-codec.ts";
const DECIMAL_FACTORY_OWNER = "src/schema/scalars/decimal/scalar.ts";
const DECIMAL_PUBLIC_BUILDER_OWNER = "src/schema/index.ts";
const SCALAR_TYPE_OWNER = "src/schema/scalars/common.ts";
const DECIMAL_OPERATION_SCHEMA_OWNER = "src/validation/scalars/decimal.ts";
const ADMITTED_DECIMAL_EXPORT_OWNER = "src/index.ts";
const DECIMAL_CODEC_MODULE = "@validation/primitives/decimal-codec";
const DECIMAL_SOURCE_PATH = /(?:^|\/)decimal(?:-[^/]*)?\.(?:[cm]?[jt]sx?)$/;
const DECIMAL_IDENTIFIER_TOKEN = /^(?:decimal(?:[A-Z_]|$)|Decimal)/;
const DECIMAL_NAME_TOKEN = /decimal/i;
const DECIMAL_CONFIG_NAME = /(?:Config|Configuration)$/;
const CAPABILITY_NAME = /capabilit/i;

const REJECTED_MODE_SET: ReadonlySet<string> = new Set(
  REJECTED_DECIMAL_MODE_MEMBERS
);
const FLOAT_TRANSPORT_EXEMPTION_SET: ReadonlySet<string> = new Set(
  DECIMAL_FLOAT_TRANSPORT_EXEMPTIONS
);
const REJECTED_RESULT_SET: ReadonlySet<string> = new Set(
  REJECTED_DECIMAL_RESULT_MEMBERS
);
const REJECTED_WRAPPER_SET: ReadonlySet<string> = new Set(
  REJECTED_DECIMAL_WRAPPER_NAMES
);
const OPERATION_KEY_SET: ReadonlySet<string> = new Set(DECIMAL_OPERATION_KEYS);
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

function isCensusSource(file: string): boolean {
  return file.startsWith("src/") && SOURCE_EXTENSIONS.has(extname(file));
}

function inRegion(file: string, regions: readonly string[]): boolean {
  return regions.some((region) => file === region || file.startsWith(region));
}

/**
 * Decimal-owned source is named, not guessed from identifier vocabulary.
 *
 * A new `decimal-*.ts` module or a module below a `decimal/` directory enters
 * the census automatically. Individual detectors may also admit a
 * mixed-purpose module through its direct central-codec import.
 */
function isDecimalSource(file: string): boolean {
  return file.includes("/decimal/") || DECIMAL_SOURCE_PATH.test(file);
}

/**
 * A mixed-purpose module becomes decimal-owned when it imports the central
 * codec, including a type-only `DecimalDescriptor` import. This is a syntactic
 * module boundary, not a claim that the census follows values through the
 * program: it covers the shipped adapter/query/migration owners while leaving
 * unrelated numeric modules outside.
 */
function isDecimalOwnedSource(file: string, source: ts.SourceFile): boolean {
  if (isDecimalSource(file)) return true;
  return source.statements.some(
    (statement) =>
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === DECIMAL_CODEC_MODULE
  );
}

function hasDecimalToken(node: ts.Node): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (
      (ts.isIdentifier(candidate) ||
        ts.isStringLiteral(candidate) ||
        ts.isNoSubstitutionTemplateLiteral(candidate)) &&
      (candidate.text === "decimal" ||
        DECIMAL_IDENTIFIER_TOKEN.test(candidate.text))
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

/**
 * A decimal region is lexical and inspectable: a decimal-named source file, a
 * declaration whose name says decimal, or a control-flow/property arm that
 * says decimal in its own selector. A detector may separately choose the
 * broader structural boundary of a module that directly imports the codec;
 * neither boundary claims value-level dataflow.
 */
function isWithinDecimalRegion(file: string, node: ts.Node): boolean {
  if (isDecimalSource(file)) return true;
  let current: ts.Node | undefined = node;
  while (current !== undefined && !ts.isSourceFile(current)) {
    const declared = declarationName(current);
    if (declared !== undefined && DECIMAL_NAME_TOKEN.test(declared))
      return true;
    if (
      (ts.isMethodDeclaration(current) ||
        ts.isMethodSignature(current) ||
        ts.isPropertyDeclaration(current) ||
        ts.isPropertySignature(current) ||
        ts.isPropertyAssignment(current)) &&
      DECIMAL_NAME_TOKEN.test(memberName(current.name) ?? "")
    ) {
      return true;
    }
    if (ts.isCaseClause(current) && hasDecimalToken(current.expression)) {
      return true;
    }
    if (ts.isIfStatement(current) && hasDecimalToken(current.expression)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

const NON_VALUE_NUMBER_NAMES =
  /^(?:(?:.*(?:count|digits|limit|precision|scale))|end|exponent|index|max(?:imum)?|offset|sum|words)$/i;
const DECIMAL_VALUE_NUMBER_NAMES =
  /(?:amount|canonical|coefficient|decimal|decoded|physical|provider|result|stored|transport|value)/i;
function numberTypedValueName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (
      ts.isParameter(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isPropertySignature(current) ||
      ts.isVariableDeclaration(current)
    ) {
      return memberName(current.name);
    }
    if (
      ts.isTypeAliasDeclaration(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function scriptKindOf(file: string): ts.ScriptKind {
  const extension = extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(file)
  );
}

function walk(source: ts.SourceFile, visit: (node: ts.Node) => void): void {
  const step = (node: ts.Node): void => {
    visit(node);
    ts.forEachChild(node, step);
  };
  ts.forEachChild(source, step);
}

function add(counts: Map<string, number>, token: string, amount = 1): void {
  if (amount === 0) return;
  counts.set(token, (counts.get(token) ?? 0) + amount);
}

function entries(file: string, counts: ReadonlyMap<string, number>): string[] {
  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([token, count]) => `${file} ${token} ${count}`);
}

function memberName(name: ts.Node | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function declarationName(node: ts.Node): string | undefined {
  if (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isFunctionDeclaration(node)
  ) {
    return node.name?.text;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return undefined;
}

function nearestNamedTypeDeclaration(
  node: ts.Node
):
  | ts.ClassDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (
      ts.isClassDeclaration(current) ||
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeAliasDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
  );
}

function isExportedCallable(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node)) {
    return hasModifier(node, ts.SyntaxKind.ExportKeyword);
  }
  if (!ts.isVariableDeclaration(node)) return false;
  const statement = node.parent.parent;
  return (
    ts.isVariableStatement(statement) &&
    hasModifier(statement, ts.SyntaxKind.ExportKeyword)
  );
}

function subtreeContains(
  root: ts.Node,
  predicate: (node: ts.Node) => boolean
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (predicate(node)) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function typeReferencesAny(
  type: ts.TypeNode | undefined,
  names: ReadonlySet<string>
): boolean {
  if (type === undefined) return false;
  return subtreeContains(
    type,
    (node) =>
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      names.has(node.typeName.text)
  );
}

function isDecimalFactory(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node)) return node.name?.text === "decimal";
  return (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "decimal" &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) ||
      ts.isFunctionExpression(node.initializer))
  );
}

function decimalBindingName(
  property: ts.ObjectLiteralElementLike
): string | undefined {
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name.text === "decimal" ? "decimal" : undefined;
  }
  if (
    ts.isPropertyAssignment(property) &&
    ts.isIdentifier(property.initializer) &&
    property.initializer.text === "decimal"
  ) {
    return memberName(property.name);
  }
  return undefined;
}

function addPublicBuilderDecimalBindings(
  source: ts.SourceFile,
  counts: Map<string, number>
): void {
  let publicDecimalBindings = 0;
  walk(source, (node) => {
    if (
      !(ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) ||
      node.name.text !== "s" ||
      node.initializer === undefined ||
      !ts.isObjectLiteralExpression(node.initializer)
    ) {
      return;
    }
    for (const property of node.initializer.properties) {
      const binding = decimalBindingName(property);
      if (binding === undefined) continue;
      if (binding === "decimal") {
        publicDecimalBindings++;
      } else {
        add(counts, `publicBuilder:binding:${binding}`);
      }
    }
  });
  if (publicDecimalBindings !== 1) {
    add(counts, "publicBuilder:decimalBindingCount");
  }
}

function factoryFunction(
  node: ts.Node
):
  | ts.FunctionDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression
  | undefined {
  if (ts.isFunctionDeclaration(node)) return node;
  if (
    ts.isVariableDeclaration(node) &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) ||
      ts.isFunctionExpression(node.initializer))
  ) {
    return node.initializer;
  }
  return undefined;
}

function constructsDecimalScalar(
  factory: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression
): boolean {
  const body = factory.body;
  if (body === undefined) return false;
  return subtreeContains(body, (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "DecimalScalar"
    ) {
      return true;
    }
    return (
      ts.isPropertyAssignment(node) &&
      memberName(node.name) === "scalarType" &&
      ts.isStringLiteral(node.initializer) &&
      node.initializer.text === "decimal"
    );
  });
}

function descriptorMembers(
  node: ts.Node
): readonly ts.TypeElement[] | undefined {
  if (ts.isInterfaceDeclaration(node)) return node.members;
  if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
    return node.type.members;
  }
  return undefined;
}

function hasReadonlyModifier(member: ts.PropertySignature): boolean {
  return (
    member.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword
    ) ?? false
  );
}

function isDescriptorShapedDeclaration(node: ts.Node): boolean {
  const members = descriptorMembers(node);
  if (members === undefined) return false;
  const names = new Set<string>();
  for (const member of members) {
    if (
      !ts.isPropertySignature(member) ||
      member.type?.kind !== ts.SyntaxKind.NumberKeyword
    ) {
      continue;
    }
    const name = memberName(member.name);
    if (name === "precision" || name === "scale") {
      names.add(name);
    }
  }
  return names.has("precision") && names.has("scale");
}

function addDescriptorViolations(
  counts: Map<string, number>,
  members: readonly ts.TypeElement[]
): void {
  const seen = new Set<string>();
  for (const member of members) {
    if (!ts.isPropertySignature(member)) {
      add(counts, "descriptor:nonProperty");
      continue;
    }
    const name = memberName(member.name);
    if (name === undefined || (name !== "precision" && name !== "scale")) {
      add(counts, `descriptor:member:${name ?? "computed"}`);
      continue;
    }
    if (seen.has(name)) add(counts, `descriptor:duplicate:${name}`);
    seen.add(name);
    if (!hasReadonlyModifier(member)) add(counts, `descriptor:mutable:${name}`);
    if (member.questionToken !== undefined) {
      add(counts, `descriptor:optional:${name}`);
    }
    if (member.type?.kind !== ts.SyntaxKind.NumberKeyword) {
      add(counts, `descriptor:type:${name}`);
    }
  }
  for (const required of ["precision", "scale"] as const) {
    if (!seen.has(required)) add(counts, `descriptor:missing:${required}`);
  }
}

function namedTypeReference(type: ts.TypeNode, name: string): boolean {
  return (
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === name
  );
}

function keyofNames(type: ts.TypeNode, name: string): boolean {
  return (
    ts.isTypeOperatorNode(type) &&
    type.operator === ts.SyntaxKind.KeyOfKeyword &&
    namedTypeReference(type.type, name)
  );
}

function isDistributiveKeyAlias(alias: ts.TypeAliasDeclaration): boolean {
  const generic = alias.typeParameters?.[0];
  if (
    alias.typeParameters?.length !== 1 ||
    generic === undefined ||
    !ts.isConditionalTypeNode(alias.type)
  ) {
    return false;
  }
  return (
    namedTypeReference(alias.type.checkType, generic.name.text) &&
    alias.type.extendsType.kind === ts.SyntaxKind.UnknownKeyword &&
    keyofNames(alias.type.trueType, generic.name.text) &&
    alias.type.falseType.kind === ts.SyntaxKind.NeverKeyword
  );
}

function isDistributiveKeySet(
  type: ts.TypeNode,
  genericName: string,
  aliases: ReadonlyMap<string, ts.TypeAliasDeclaration>
): boolean {
  if (
    !(ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) ||
    type.typeArguments?.length !== 1 ||
    type.typeArguments[0] === undefined ||
    !namedTypeReference(type.typeArguments[0], genericName)
  ) {
    return false;
  }
  const alias = aliases.get(type.typeName.text);
  return alias !== undefined && isDistributiveKeyAlias(alias);
}

function isExactKeyRecord(
  type: ts.TypeNode,
  genericName: string,
  aliases: ReadonlyMap<string, ts.TypeAliasDeclaration>
): boolean {
  if (
    !(ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) ||
    type.typeName.text !== "Record" ||
    type.typeArguments?.length !== 2
  ) {
    return false;
  }
  const [keys, value] = type.typeArguments;
  if (
    keys === undefined ||
    value?.kind !== ts.SyntaxKind.NeverKeyword ||
    !ts.isTypeReferenceNode(keys) ||
    !ts.isIdentifier(keys.typeName) ||
    keys.typeName.text !== "Exclude" ||
    keys.typeArguments?.length !== 2
  ) {
    return false;
  }
  const [givenKeys, allowedKeys] = keys.typeArguments;
  return (
    givenKeys !== undefined &&
    allowedKeys !== undefined &&
    isDistributiveKeySet(givenKeys, genericName, aliases) &&
    keyofNames(allowedKeys, "DecimalDescriptor")
  );
}

function isExactKeyAlias(
  alias: ts.TypeAliasDeclaration,
  aliases: ReadonlyMap<string, ts.TypeAliasDeclaration>
): boolean {
  const aliasGeneric = alias.typeParameters?.[0];
  if (
    alias.typeParameters?.length !== 1 ||
    aliasGeneric === undefined ||
    !ts.isIntersectionTypeNode(alias.type) ||
    alias.type.types.length !== 2
  ) {
    return false;
  }
  return (
    alias.type.types.some((type) =>
      namedTypeReference(type, aliasGeneric.name.text)
    ) &&
    alias.type.types.some((type) =>
      isExactKeyRecord(type, aliasGeneric.name.text, aliases)
    )
  );
}

function isExactKeyAliasReference(
  type: ts.TypeNode,
  genericName: string,
  aliases: ReadonlyMap<string, ts.TypeAliasDeclaration>
): boolean {
  if (
    !(ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) ||
    type.typeArguments?.length !== 1 ||
    type.typeArguments[0] === undefined ||
    !namedTypeReference(type.typeArguments[0], genericName)
  ) {
    return false;
  }
  const alias = aliases.get(type.typeName.text);
  return alias !== undefined && isExactKeyAlias(alias, aliases);
}

function isExactFactoryParameterType(
  type: ts.TypeNode,
  genericName: string,
  aliases: ReadonlyMap<string, ts.TypeAliasDeclaration>
): boolean {
  if (!ts.isIntersectionTypeNode(type) || type.types.length !== 2) return false;
  const hasGeneric = type.types.some((member) =>
    namedTypeReference(member, genericName)
  );
  const hasNoInferDomain = type.types.some((member) => {
    if (
      !(ts.isTypeReferenceNode(member) && ts.isIdentifier(member.typeName)) ||
      member.typeName.text !== "NoInfer" ||
      member.typeArguments?.length !== 1
    ) {
      return false;
    }
    const domain = member.typeArguments[0];
    return (
      domain !== undefined &&
      ts.isIntersectionTypeNode(domain) &&
      domain.types.length === 2 &&
      domain.types.some((part) =>
        namedTypeReference(part, "DecimalDescriptor")
      ) &&
      domain.types.some((part) =>
        isExactKeyAliasReference(part, genericName, aliases)
      )
    );
  });
  return hasGeneric && hasNoInferDomain;
}

function hasExactFactorySurface(
  node: ts.Node,
  aliases: ReadonlyMap<string, ts.TypeAliasDeclaration>
): boolean {
  const factory = factoryFunction(node);
  const factoryGeneric = factory?.typeParameters?.[0];
  const parameter = factory?.parameters[0];
  if (
    factory === undefined ||
    factory.typeParameters?.length !== 1 ||
    factoryGeneric === undefined ||
    parameter?.type === undefined ||
    !isExactFactoryParameterType(
      parameter.type,
      factoryGeneric.name.text,
      aliases
    )
  ) {
    return false;
  }
  return true;
}

function isDescriptorFactoryParameter(
  parameter: ts.ParameterDeclaration,
  aliases: ReadonlyMap<string, ts.TypeAliasDeclaration>,
  genericName: string | undefined
): boolean {
  const type = parameter.type;
  if (type === undefined) return false;
  if (
    genericName !== undefined &&
    isExactFactoryParameterType(type, genericName, aliases)
  ) {
    return true;
  }
  if (namedTypeReference(type, "DecimalDescriptor")) return true;
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    const alias = aliases.get(type.typeName.text);
    return alias !== undefined && isExactKeyAlias(alias, aliases);
  }
  if (!ts.isTypeLiteralNode(type) || type.members.length !== 2) return false;
  const names = new Set<string>();
  for (const member of type.members) {
    if (
      !ts.isPropertySignature(member) ||
      member.questionToken !== undefined ||
      member.type?.kind !== ts.SyntaxKind.NumberKeyword
    ) {
      return false;
    }
    const name = memberName(member.name);
    if (name === undefined) return false;
    names.add(name);
  }
  return names.size === 2 && names.has("precision") && names.has("scale");
}

function typeContainsDecimalLiteral(type: ts.TypeNode | undefined): boolean {
  if (type === undefined) return false;
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) {
    return type.literal.text === "decimal";
  }
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.some(typeContainsDecimalLiteral);
  }
  return false;
}

function typeContainsNamedReference(
  type: ts.TypeNode | undefined,
  name: string
): boolean {
  if (type === undefined) return false;
  if (namedTypeReference(type, name)) return true;
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.some((member) =>
      typeContainsNamedReference(member, name)
    );
  }
  return false;
}

function typeAdmitsDecimal(
  type: ts.TypeNode | undefined,
  aliases: ReadonlyMap<string, ts.TypeAliasDeclaration>,
  visited = new Set<string>()
): boolean {
  if (typeContainsDecimalLiteral(type)) return true;
  if (
    type !== undefined &&
    (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type))
  ) {
    return type.types.some((member) =>
      typeAdmitsDecimal(member, aliases, new Set(visited))
    );
  }
  if (
    type === undefined ||
    !ts.isTypeReferenceNode(type) ||
    !ts.isIdentifier(type.typeName)
  ) {
    return false;
  }
  const name = type.typeName.text;
  if (visited.has(name)) return false;
  const alias = aliases.get(name);
  if (alias === undefined) return name === "ScalarType";
  visited.add(name);
  return typeAdmitsDecimal(alias.type, aliases, visited);
}

function hasDescriptorlessDecimalConfig(
  node: ts.Node,
  aliases: ReadonlyMap<string, ts.TypeAliasDeclaration>
): boolean {
  const declared = declarationName(node);
  if (declared === undefined || !DECIMAL_CONFIG_NAME.test(declared)) {
    return false;
  }
  const members = descriptorMembers(node);
  if (members === undefined) return false;
  const hasDecimalDiscriminant = members.some(
    (member) =>
      ts.isPropertySignature(member) &&
      memberName(member.name) === "scalarType" &&
      typeAdmitsDecimal(member.type, aliases)
  );
  if (!hasDecimalDiscriminant) return false;
  return !members.some(
    (member) =>
      ts.isPropertySignature(member) &&
      memberName(member.name) === "decimal" &&
      typeContainsNamedReference(member.type, "DecimalDescriptor")
  );
}

function addSourceWideDecimalDeclarationViolations(
  file: string,
  source: ts.SourceFile,
  aliases: ReadonlyMap<string, ts.TypeAliasDeclaration>,
  counts: Map<string, number>
): void {
  walk(source, (node) => {
    const declared = declarationName(node);
    if (
      file !== SCALAR_TYPE_OWNER &&
      declared === "ScalarType" &&
      ts.isTypeAliasDeclaration(node) &&
      typeContainsDecimalLiteral(node.type)
    ) {
      add(counts, "secondScalarTypeDeclaration");
    }
    if (
      declared !== undefined &&
      hasDescriptorlessDecimalConfig(node, aliases)
    ) {
      add(counts, `descriptorlessDecimalConfig:${declared}`);
    }
  });
}

function isUndefinedOnlyType(type: ts.TypeNode | undefined): boolean {
  return type?.kind === ts.SyntaxKind.UndefinedKeyword;
}

/* ------------------------------------------------------------------ *
 * Detector 1 — a second decimal declaration mode
 * ------------------------------------------------------------------ */

export function secondDecimalModeEntries(file: string, text: string): string[] {
  const scansPublicSurface = inRegion(file, DECIMAL_PUBLIC_REGIONS);
  const isShippedPublicEntry = inRegion(file, DECIMAL_PUBLIC_ENTRY_OWNERS);
  const source = parse(file, text);
  const counts = new Map<string, number>();
  const aliases = new Map(
    source.statements
      .filter(ts.isTypeAliasDeclaration)
      .map((alias) => [alias.name.text, alias] as const)
  );
  if (file === DECIMAL_PUBLIC_BUILDER_OWNER) {
    addPublicBuilderDecimalBindings(source, counts);
  }
  addSourceWideDecimalDeclarationViolations(file, source, aliases, counts);
  if (!(scansPublicSurface || isDecimalOwnedSource(file, source))) {
    return entries(file, counts);
  }
  let descriptorDeclarations = 0;
  let factoryDeclarations = 0;
  walk(source, (node) => {
    const callable = factoryFunction(node);
    const callableName = declarationName(node);
    const callableParameter = callable?.parameters[0];
    if (
      scansPublicSurface &&
      callable !== undefined &&
      callableName !== undefined &&
      callableName !== "decimal" &&
      isExportedCallable(node) &&
      callable.parameters.length === 1 &&
      callableParameter !== undefined &&
      isDescriptorFactoryParameter(
        callableParameter,
        aliases,
        callable.typeParameters?.[0]?.name.text
      ) &&
      constructsDecimalScalar(callable)
    ) {
      add(counts, `secondFactory:${callableName}`);
    }

    if (scansPublicSurface && isDecimalFactory(node)) {
      factoryDeclarations++;
      const factory = factoryFunction(node);
      const parameters = factory?.parameters;
      if (parameters?.length !== 1) add(counts, "factoryArity");
      const parameter = parameters?.[0];
      if (
        parameter !== undefined &&
        !isDescriptorFactoryParameter(
          parameter,
          aliases,
          factory?.typeParameters?.[0]?.name.text
        )
      ) {
        add(counts, "nonDescriptorFactoryParameter");
      }
      if (
        parameter !== undefined &&
        (parameter.questionToken !== undefined ||
          parameter.initializer !== undefined ||
          parameter.dotDotDotToken !== undefined)
      ) {
        add(counts, "factoryOptionality");
      }
      if (
        parameters?.some(
          (candidate) =>
            (ts.isIdentifier(candidate.name) &&
              candidate.name.text === "nativeType") ||
            candidate.type?.getText(source).includes("NativeType")
        )
      ) {
        add(counts, "nativeFactoryParameter");
      }
      if (
        file === DECIMAL_FACTORY_OWNER &&
        !hasExactFactorySurface(node, aliases)
      ) {
        add(counts, "factoryExactKeySurface");
      }
    }

    const declared = declarationName(node);
    if (
      scansPublicSurface &&
      declared !== undefined &&
      REJECTED_MODE_SET.has(declared)
    ) {
      add(counts, `declaration:${declared}`);
    }

    if (scansPublicSurface && ts.isExportSpecifier(node)) {
      const exportDeclaration = node.parent.parent;
      const isTypeOnly =
        node.isTypeOnly ||
        (ts.isExportDeclaration(exportDeclaration) &&
          exportDeclaration.isTypeOnly);
      const exportedName = node.name.text;
      const localName = node.propertyName?.text ?? exportedName;
      const exportsDecimalBinding =
        isShippedPublicEntry &&
        (localName === "decimal" || exportedName === "decimal");
      if (
        !isTypeOnly &&
        (REJECTED_MODE_SET.has(exportedName) || exportsDecimalBinding)
      ) {
        add(counts, `export:${exportedName}`);
      }
    }

    const members = descriptorMembers(node);
    if (declared === "DecimalDescriptor" && members !== undefined) {
      if (file !== DECIMAL_DESCRIPTOR_OWNER) {
        add(counts, "descriptor:wrongOwner");
      } else {
        descriptorDeclarations++;
        addDescriptorViolations(counts, members);
      }
    } else if (declared !== undefined && isDescriptorShapedDeclaration(node)) {
      add(counts, `secondDescriptor:${declared}`);
    }

    const rejectedMember =
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node)
        ? memberName(node.name)
        : undefined;
    if (
      scansPublicSurface &&
      rejectedMember !== undefined &&
      REJECTED_MODE_SET.has(rejectedMember)
    ) {
      add(counts, `member:${rejectedMember}`);
    }

    if (
      scansPublicSurface &&
      (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) &&
      memberName(node.name) === "nativeType" &&
      !isUndefinedOnlyType(node.type)
    ) {
      add(counts, "member:nativeType");
    }

    if (
      scansPublicSurface &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      REJECTED_MODE_SET.has(node.expression.name.text)
    ) {
      add(counts, `call:${node.expression.name.text}`);
    }
    if (
      scansPublicSurface &&
      ts.isCallExpression(node) &&
      ts.isElementAccessExpression(node.expression) &&
      ts.isStringLiteral(node.expression.argumentExpression) &&
      REJECTED_MODE_SET.has(node.expression.argumentExpression.text)
    ) {
      add(counts, `call:${node.expression.argumentExpression.text}`);
    }
  });
  if (file === DECIMAL_DESCRIPTOR_OWNER && descriptorDeclarations !== 1) {
    add(counts, "descriptor:declarationCount");
  }
  if (file === DECIMAL_FACTORY_OWNER && factoryDeclarations !== 1) {
    add(counts, "factoryDeclarationCount");
  }
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Detector 2 — decimal transport through binary floating point
 * ------------------------------------------------------------------ */

export function decimalFloatTransportEntries(
  file: string,
  text: string
): string[] {
  const source = parse(file, text);
  const scansDecimalOwnedSource = isDecimalOwnedSource(file, source);
  const counts = new Map<string, number>();
  const exemptionUses = new Map<string, number>();
  walk(source, (node) => {
    const isLexicalDecimal = isWithinDecimalRegion(file, node);
    if (node.kind === ts.SyntaxKind.NumberKeyword) {
      if (!isLexicalDecimal) return;
      const name = numberTypedValueName(node);
      if (
        name !== undefined &&
        DECIMAL_VALUE_NUMBER_NAMES.test(name) &&
        !NON_VALUE_NUMBER_NAMES.test(name)
      ) {
        add(counts, "numberType");
      }
      return;
    }
    if (!(scansDecimalOwnedSource || isLexicalDecimal)) return;
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.PlusToken
    ) {
      add(counts, "unaryPlus");
    }

    if (!ts.isCallExpression(node)) return;
    if (ts.isIdentifier(node.expression) && node.expression.text === "Number") {
      let parent: ts.Node | undefined = node.parent;
      while (parent !== undefined && !ts.isFunctionDeclaration(parent)) {
        parent = parent.parent;
      }
      const functionName =
        parent !== undefined && ts.isFunctionDeclaration(parent)
          ? (parent.name?.text ?? "")
          : "";
      const exemption = `${file} ${functionName} Number(${node.arguments[0]?.getText(source) ?? ""})`;
      const previousUses = exemptionUses.get(exemption) ?? 0;
      exemptionUses.set(exemption, previousUses + 1);
      if (!FLOAT_TRANSPORT_EXEMPTION_SET.has(exemption) || previousUses > 0) {
        add(counts, "Number");
      }
      return;
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Number" &&
      node.expression.name.text === "parseFloat"
    ) {
      add(counts, "Number.parseFloat");
      return;
    }
    if (
      ts.isIdentifier(node.expression) &&
      node.expression.text === "parseFloat"
    ) {
      add(counts, "parseFloat");
    }
  });
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Detector 3 — a public string/number decimal result mode
 * ------------------------------------------------------------------ */

function typeContainsPublicDecimalResultLiteral(type: ts.TypeNode): boolean {
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) {
    return type.literal.text === "string" || type.literal.text === "number";
  }
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.some(typeContainsPublicDecimalResultLiteral);
  }
  if (ts.isParenthesizedTypeNode(type)) {
    return typeContainsPublicDecimalResultLiteral(type.type);
  }
  return false;
}

export function publicDecimalResultModeEntries(
  file: string,
  text: string
): string[] {
  const source = parse(file, text);
  const counts = new Map<string, number>();
  walk(source, (node) => {
    if (
      (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) &&
      node.type !== undefined &&
      typeContainsPublicDecimalResultLiteral(node.type)
    ) {
      const config = nearestNamedTypeDeclaration(node);
      const configName = config?.name?.text;
      const property = memberName(node.name);
      if (
        configName !== undefined &&
        property !== undefined &&
        DECIMAL_NAME_TOKEN.test(configName) &&
        DECIMAL_CONFIG_NAME.test(configName)
      ) {
        add(counts, `decimalResultConfig:${property}`);
      }
    }
    if (ts.isIdentifier(node) && REJECTED_RESULT_SET.has(node.text)) {
      add(counts, node.text);
    }
    if (
      (ts.isPropertySignature(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertyAssignment(node) ||
        ts.isMethodSignature(node) ||
        ts.isMethodDeclaration(node)) &&
      ts.isStringLiteral(node.name) &&
      REJECTED_RESULT_SET.has(node.name.text)
    ) {
      add(counts, node.name.text);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      REJECTED_RESULT_SET.has(node.argumentExpression.text)
    ) {
      add(counts, node.argumentExpression.text);
    }
    if (
      ts.isPropertyAssignment(node) &&
      memberName(node.name) === "decimal" &&
      ts.isStringLiteral(node.initializer) &&
      (node.initializer.text === "string" || node.initializer.text === "number")
    ) {
      add(counts, `decimalConfig:${node.initializer.text}`);
    }
    if (
      ts.isPropertySignature(node) &&
      memberName(node.name) === "decimal" &&
      node.type !== undefined
    ) {
      const spellings = node.type
        .getText(source)
        .match(/(?:"string"|'string'|"number"|'number')/g);
      add(counts, "decimalConfigType", spellings?.length ?? 0);
    }
  });
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Detector 4 — a second Decimal constructor, class, or wrapper
 * ------------------------------------------------------------------ */

function isParameterProperty(parameter: ts.ParameterDeclaration): boolean {
  return (
    parameter.modifiers?.some((modifier) =>
      [
        ts.SyntaxKind.PrivateKeyword,
        ts.SyntaxKind.ProtectedKeyword,
        ts.SyntaxKind.PublicKeyword,
        ts.SyntaxKind.ReadonlyKeyword,
      ].includes(modifier.kind)
    ) ?? false
  );
}

function classOwnsDecimalValue(
  declaration: ts.ClassDeclaration,
  decimalValueBindings: ReadonlySet<string>
): boolean {
  return declaration.members.some((member) => {
    if (ts.isPropertyDeclaration(member)) {
      return typeReferencesAny(member.type, decimalValueBindings);
    }
    return (
      ts.isConstructorDeclaration(member) &&
      member.parameters.some(
        (parameter) =>
          isParameterProperty(parameter) &&
          typeReferencesAny(parameter.type, decimalValueBindings)
      )
    );
  });
}

export function ormOwnedDecimalWrapperEntries(
  file: string,
  text: string
): string[] {
  const source = parse(file, text);
  const counts = new Map<string, number>();
  const decimalConstructorBindings = new Set<string>();
  const decimalValueBindings = new Set<string>();
  for (const statement of source.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) ||
      statement.moduleSpecifier.text !== "decimal.js"
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (clause?.name !== undefined) {
      decimalValueBindings.add(clause.name.text);
      if (!clause.isTypeOnly) {
        decimalConstructorBindings.add(clause.name.text);
      }
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (importedName === "Decimal" || importedName === "default") {
          decimalValueBindings.add(element.name.text);
          if (!(clause.isTypeOnly || element.isTypeOnly)) {
            decimalConstructorBindings.add(element.name.text);
          }
        }
      }
    }
  }
  let admittedConstructorExports = 0;
  walk(source, (node) => {
    if (
      ts.isCallExpression(node) &&
      ((ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        decimalConstructorBindings.has(node.expression.expression.text) &&
        node.expression.name.text === "clone") ||
        (ts.isElementAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          decimalConstructorBindings.has(node.expression.expression.text) &&
          ts.isStringLiteral(node.expression.argumentExpression) &&
          node.expression.argumentExpression.text === "clone"))
    ) {
      add(counts, "decimalCloneCall");
    }
    if (
      file !== DECIMAL_DESCRIPTOR_OWNER &&
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "decimal.js"
    ) {
      add(counts, "decimalRuntimeImport");
    }
    if (ts.isClassDeclaration(node) && node.name?.text === "Decimal") {
      add(counts, "declaration:Decimal");
    }
    if (
      ts.isClassDeclaration(node) &&
      node.name !== undefined &&
      classOwnsDecimalValue(node, decimalValueBindings)
    ) {
      add(counts, `decimalValueCarrier:${node.name.text}`);
    }
    if (
      (ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node)) &&
      node.name !== undefined &&
      REJECTED_WRAPPER_SET.has(node.name.text)
    ) {
      add(counts, `declaration:${node.name.text}`);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      (node.name.text === "Decimal" || REJECTED_WRAPPER_SET.has(node.name.text))
    ) {
      add(counts, `declaration:${node.name.text}`);
    }
    if (ts.isExportDeclaration(node)) {
      const hasRuntimeNamedExport =
        node.exportClause === undefined ||
        !ts.isNamedExports(node.exportClause) ||
        node.exportClause.elements.some((element) => !element.isTypeOnly);
      const exportsDecimalJs =
        !node.isTypeOnly &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "decimal.js" &&
        hasRuntimeNamedExport;
      const exportsNamedDecimal =
        !node.isTypeOnly &&
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.some(
          (element) =>
            !element.isTypeOnly &&
            (element.name.text === "Decimal" ||
              element.propertyName?.text === "Decimal")
        );
      if (file !== ADMITTED_DECIMAL_EXPORT_OWNER) {
        if (exportsDecimalJs || exportsNamedDecimal) {
          add(counts, "decimalConstructorExport");
        }
      } else if (exportsDecimalJs) {
        admittedConstructorExports++;
        const elements =
          node.exportClause !== undefined &&
          ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements
            : [];
        const element = elements[0];
        if (
          elements.length !== 1 ||
          element === undefined ||
          element.isTypeOnly ||
          element.propertyName?.text !== "default" ||
          element.name.text !== "Decimal"
        ) {
          add(counts, "decimalConstructorExportSpelling");
        }
      } else if (exportsNamedDecimal) {
        add(counts, "decimalConstructorExport");
      }
    }
    if (
      file !== ADMITTED_DECIMAL_EXPORT_OWNER &&
      ts.isExportAssignment(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Decimal"
    ) {
      add(counts, "decimalConstructorExport");
    }
  });
  if (
    file === ADMITTED_DECIMAL_EXPORT_OWNER &&
    admittedConstructorExports !== 1
  ) {
    add(counts, "decimalConstructorExportCount");
  }
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Detector 5 — a partial decimal operation bag
 * ------------------------------------------------------------------ */

function typeContainsOperationLiteral(type: ts.TypeNode | undefined): boolean {
  if (type === undefined) return false;
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) {
    return OPERATION_KEY_SET.has(type.literal.text);
  }
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.some(typeContainsOperationLiteral);
  }
  if (ts.isParenthesizedTypeNode(type)) {
    return typeContainsOperationLiteral(type.type);
  }
  return false;
}

function isOptionalMappedOperationBag(node: ts.MappedTypeNode): boolean {
  return (
    node.questionToken !== undefined &&
    node.questionToken.kind !== ts.SyntaxKind.MinusToken &&
    typeContainsOperationLiteral(node.typeParameter.constraint)
  );
}

function membersContainDecimalOperation(
  members: readonly ts.TypeElement[]
): boolean {
  return members.some(
    (member) =>
      ts.isPropertySignature(member) &&
      OPERATION_KEY_SET.has(memberName(member.name) ?? "")
  );
}

function typeContainsDecimalOperation(
  type: ts.TypeNode,
  declarations: ReadonlyMap<
    string,
    ts.InterfaceDeclaration | ts.TypeAliasDeclaration
  >,
  seen: ReadonlySet<string> = new Set()
): boolean {
  if (ts.isTypeLiteralNode(type)) {
    return membersContainDecimalOperation(type.members);
  }
  if (ts.isMappedTypeNode(type)) {
    return typeContainsOperationLiteral(type.typeParameter.constraint);
  }
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.some((member) =>
      typeContainsDecimalOperation(member, declarations, seen)
    );
  }
  if (ts.isParenthesizedTypeNode(type)) {
    return typeContainsDecimalOperation(type.type, declarations, seen);
  }
  if (!(ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName))) {
    return false;
  }
  const name = type.typeName.text;
  if (seen.has(name)) return false;
  const declaration = declarations.get(name);
  if (declaration === undefined) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(name);
  return ts.isInterfaceDeclaration(declaration)
    ? membersContainDecimalOperation(declaration.members)
    : typeContainsDecimalOperation(declaration.type, declarations, nextSeen);
}

export function partialDecimalOperationBagEntries(
  file: string,
  text: string
): string[] {
  const source = parse(file, text);
  const declarations = new Map<
    string,
    ts.InterfaceDeclaration | ts.TypeAliasDeclaration
  >();
  walk(source, (node) => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      declarations.set(node.name.text, node);
    }
  });
  let hasNamedDecimalOperationDeclaration = false;
  for (const [declared, node] of declarations) {
    if (
      DECIMAL_NAME_TOKEN.test(declared) &&
      ((ts.isInterfaceDeclaration(node) &&
        membersContainDecimalOperation(node.members)) ||
        (ts.isTypeAliasDeclaration(node) &&
          typeContainsDecimalOperation(node.type, declarations)))
    ) {
      hasNamedDecimalOperationDeclaration = true;
    }
  }
  const scansDecimalFile =
    file === DECIMAL_OPERATION_SCHEMA_OWNER ||
    isDecimalOwnedSource(file, source);
  if (!(scansDecimalFile || hasNamedDecimalOperationDeclaration)) {
    return [];
  }
  const counts = new Map<string, number>();
  walk(source, (node) => {
    if (ts.isMappedTypeNode(node) && isOptionalMappedOperationBag(node)) {
      add(counts, "mappedOptionalOperationBag");
    }
    if (ts.isPropertySignature(node) && node.questionToken !== undefined) {
      const name = memberName(node.name);
      let declaration: ts.Node | undefined = node.parent;
      while (
        declaration !== undefined &&
        !ts.isInterfaceDeclaration(declaration) &&
        !ts.isTypeAliasDeclaration(declaration) &&
        !ts.isSourceFile(declaration)
      ) {
        declaration = declaration.parent;
      }
      const operationDeclarationName =
        declaration === undefined ? undefined : declarationName(declaration);
      const isDecimalOperationDeclaration =
        scansDecimalFile ||
        (declaration !== undefined &&
          operationDeclarationName !== undefined &&
          DECIMAL_NAME_TOKEN.test(operationDeclarationName) &&
          ((ts.isInterfaceDeclaration(declaration) &&
            membersContainDecimalOperation(declaration.members)) ||
            (ts.isTypeAliasDeclaration(declaration) &&
              typeContainsDecimalOperation(declaration.type, declarations))));
      if (
        isDecimalOperationDeclaration &&
        name !== undefined &&
        OPERATION_KEY_SET.has(name)
      ) {
        add(counts, `optional:${name}`);
      }
    }
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      node.typeName.text === "Partial" &&
      node.typeArguments?.some((argument) =>
        typeContainsDecimalOperation(argument, declarations)
      )
    ) {
      add(counts, "Partial");
    }
    if (
      scansDecimalFile &&
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) &&
        (node.expression.text === "partial" ||
          node.expression.text === "partialObject")) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          (node.expression.name.text === "partial" ||
            node.expression.name.text === "partialObject")))
    ) {
      const builder = ts.isIdentifier(node.expression)
        ? node.expression.text
        : node.expression.name.text;
      add(counts, `builder:${builder}`);
    }
    if (
      scansDecimalFile &&
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) &&
        node.expression.text === "object") ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "object")) &&
      node.arguments[0] !== undefined &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const operationCount = node.arguments[0].properties.filter((property) =>
        OPERATION_KEY_SET.has(memberName(property.name) ?? "")
      ).length;
      if (operationCount > 1) add(counts, "builder:operationBag");
    }
  });
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Detector 6 — an adapter-wide exact-decimal refusal
 * ------------------------------------------------------------------ */

function decimalCapabilityName(node: ts.Node): string | undefined {
  if (
    !(ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) ||
    node.type?.kind !== ts.SyntaxKind.BooleanKeyword
  ) {
    return undefined;
  }
  const property = memberName(node.name);
  const declaration = nearestNamedTypeDeclaration(node);
  const owner = declaration?.name?.text;
  return property !== undefined &&
    owner !== undefined &&
    DECIMAL_NAME_TOKEN.test(property) &&
    CAPABILITY_NAME.test(owner)
    ? property
    : undefined;
}

export function adapterWideDecimalRefusalEntries(
  file: string,
  text: string
): string[] {
  const source = parse(file, text);
  const counts = new Map<string, number>();
  walk(source, (node) => {
    const capability = decimalCapabilityName(node);
    if (capability !== undefined) {
      add(counts, `decimalCapability:${capability}`);
    }
    if (
      (ts.isPropertySignature(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isMethodSignature(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      memberName(node.name) === "supportsExactDecimal"
    ) {
      add(counts, "supportsExactDecimal");
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "supportsExactDecimal"
    ) {
      add(counts, "supportsExactDecimal");
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "supportsExactDecimal"
    ) {
      add(counts, "supportsExactDecimal");
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        (ts.isIdentifier(callee) &&
          callee.text.startsWith("assertExactDecimal")) ||
        (ts.isPropertyAccessExpression(callee) &&
          callee.name.text.startsWith("assertExactDecimal")) ||
        (ts.isElementAccessExpression(callee) &&
          ts.isStringLiteral(callee.argumentExpression) &&
          callee.argumentExpression.text.startsWith("assertExactDecimal"))
      ) {
        add(counts, "assertExactDecimal*");
      }
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.includes("decimal-portability")
    ) {
      add(counts, "decimal-portability");
    }
  });
  return entries(file, counts);
}

/** Every existing shipped source file. */
export function censusFiles(repositoryRoot: string): string[] {
  const listed = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "src",
    ],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  const deleted = execFileSync(
    "git",
    ["ls-files", "-z", "--deleted", "--", "src"],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  const deletedFiles = new Set(
    deleted.split("\0").filter((file) => file.length > 0)
  );
  return [...new Set(listed.split("\0").filter((file) => file.length > 0))]
    .filter((file) => !deletedFiles.has(file) && isCensusSource(file))
    .sort();
}

export interface DecimalLanguageCensus {
  readonly secondDecimalMode: readonly string[];
  readonly floatTransport: readonly string[];
  readonly publicResultMode: readonly string[];
  readonly ormOwnedWrapper: readonly string[];
  readonly partialOperationBag: readonly string[];
  readonly adapterWideRefusal: readonly string[];
}

export function collectDecimalLanguageCensus(
  repositoryRoot: string
): DecimalLanguageCensus {
  const secondDecimalMode: string[] = [];
  const floatTransport: string[] = [];
  const publicResultMode: string[] = [];
  const ormOwnedWrapper: string[] = [];
  const partialOperationBag: string[] = [];
  const adapterWideRefusal: string[] = [];
  const sourceFiles = censusFiles(repositoryRoot);
  for (const file of sourceFiles) {
    const text = readFileSync(join(repositoryRoot, file), "utf8");
    secondDecimalMode.push(...secondDecimalModeEntries(file, text));
    floatTransport.push(...decimalFloatTransportEntries(file, text));
    publicResultMode.push(...publicDecimalResultModeEntries(file, text));
    ormOwnedWrapper.push(...ormOwnedDecimalWrapperEntries(file, text));
    partialOperationBag.push(...partialDecimalOperationBagEntries(file, text));
    adapterWideRefusal.push(...adapterWideDecimalRefusalEntries(file, text));
  }
  for (const owner of [
    DECIMAL_DESCRIPTOR_OWNER,
    DECIMAL_FACTORY_OWNER,
    DECIMAL_PUBLIC_BUILDER_OWNER,
  ]) {
    if (!sourceFiles.includes(owner)) {
      secondDecimalMode.push(...secondDecimalModeEntries(owner, ""));
    }
  }
  if (!sourceFiles.includes(ADMITTED_DECIMAL_EXPORT_OWNER)) {
    ormOwnedWrapper.push(
      ...ormOwnedDecimalWrapperEntries(ADMITTED_DECIMAL_EXPORT_OWNER, "")
    );
  }
  return {
    secondDecimalMode,
    floatTransport,
    publicResultMode,
    ormOwnedWrapper,
    partialOperationBag,
    adapterWideRefusal,
  };
}
