import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import ts from "typescript";

/**
 * The tracked-source census detectors of the unified relation language
 * (`docs/architecture/global-relation-cardinality-plan.md` §12.4).
 *
 * They own DISJOINT semantic regions of the same file set, so one occurrence is
 * never counted twice and one region is never guarded twice:
 *
 * - the SOURCE gate owns executable TypeScript/JavaScript nodes: identifiers
 *   (imports, declarations, type references, property names) and the retired
 *   capability calls of a relation-factory-rooted chain. It matches AST nodes,
 *   so a retired spelling inside a comment or a string can never make it red,
 *   and a retained lookalike (`PolymorphicToOneStorage`,
 *   `buildManyToManyJoinParts`, `fkOneToOneUnique`) can never make it green;
 * - the RETIRED-DISCRIMINANT gate owns only executable exact `"manyToMany"`
 *   literal-type arms, `kind` constructions/comparisons/cases, and membership
 *   orientation returns. It deliberately ignores prose and behavior names;
 * - the TEXT gate owns everything the source gate cannot parse — Markdown/MDX,
 *   `.astro`, YAML DOM captures, `.prisma`, plain text — plus the comment/JSDoc
 *   and string/template-literal contents INSIDE parseable source. It matches
 *   precise call/import/chain patterns, never a bare word, so Prisma field
 *   names and prose survive it.
 *
 * Both enumerate the estate through `git ls-files` rather than a directory
 * walk, so no subtree can be forgotten. The enumeration deliberately adds
 * `--others --exclude-standard` to the tracked set: a file that is already in
 * the worktree but not yet in the index is part of the estate a commit is about
 * to publish, and including it keeps one manifest valid on both sides of that
 * commit.
 *
 * Package A froze each original detector's exact baseline manifest. Package F
 * retired those manifests: every detector now carries its final zero assertion
 * assertions, and §12.4's sole textual exemption class — a historical
 * architecture plan under its superseded-API banner — lives in this file as
 * `isBanneredHistoricalPlan`.
 */

/** The six retired public relation factories (plan §1). */
const RETIRED_RELATION_FACTORIES = [
  "manyToMany",
  "manyToOne",
  "oneToMany",
  "oneToOne",
  "polymorphicToMany",
  "polymorphicToOne",
] as const;

/**
 * The retired factories whose terminals expose the retired ORDINARY capability
 * spellings. A variant carrier keeps `.optional()` (plan §4.3), so a
 * `polymorphicToOne` chain is not a capability occurrence — only its factory
 * name is retired, and the identifier census already owns that fact.
 */
const ORDINARY_RETIRED_FACTORIES = new Set<string>([
  "manyToMany",
  "manyToOne",
  "oneToMany",
  "oneToOne",
]);

/**
 * Plan §12.4's exact identifier list, ruling D10's additions
 * (`PolymorphicToOneState`, `PolymorphicToManyState`, `getRelationInfo`,
 * `RelationResultKind`, `GetRelationType`, `ManyToManyRelationState`), and
 * ruling D21's three (`IsFieldsLessInverseOneToOne`,
 * `findPairedManyToManyState`, `inverseOneToOneMustBeOptional`), which Packages
 * B and C deleted and which this gate now proves absent.
 */
export const RETIRED_RELATION_SYMBOLS = [
  "AnyPolymorphicRelation",
  "GetRelationType",
  "IsFieldsLessInverseOneToOne",
  "ManyToManyRelation",
  "ManyToManyRelationState",
  "PolymorphicRelationInfo",
  "PolymorphicRelationInfoOf",
  "PolymorphicRelationMap",
  "PolymorphicRelationState",
  "PolymorphicStateOf",
  "PolymorphicToManyRelation",
  "PolymorphicToManyRelationInfo",
  "PolymorphicToManyState",
  "PolymorphicToOneRelation",
  "PolymorphicToOneRelationInfo",
  "PolymorphicToOneState",
  "RelationInfo",
  "RelationResultKind",
  "RelationType",
  "ResolvedPolymorphicEdge",
  "_polymorphicStorage",
  "extractPolymorphicRelationMap",
  "findPairedManyToManyState",
  "getPolymorphicStorage",
  "getRelationInfo",
  "inverseOneToOneMustBeOptional",
  "isPolymorphicToOneRelationInfo",
  "manyToMany",
  "manyToOne",
  "oneToMany",
  "oneToOne",
  "polymorphicMemberCarrier",
  "polymorphicRelations",
  "polymorphicRelationsByModel",
  "polymorphicToMany",
  "polymorphicToOne",
  "setPolymorphicStorage",
  "setSource",
] as const;

/**
 * The census modules whose own pattern table and falsification witnesses spell
 * retired patterns on purpose. The exemption is NOT file-wide: it applies to
 * one comment or one literal node at a time, and only to a node that carries
 * the marker token below. Any other region of these same files is censused
 * normally.
 */
const CENSUS_SELF_EXEMPT_FILES = [
  "tests/contracts/architecture/relation-language-census.test.ts",
  "tests/fixtures/relation-language-census.ts",
] as const;

/** The marker a self-exempt comment or literal node must contain. */
const CENSUS_SELF_EXEMPTION_MARKER = "census-pattern-table";

/**
 * Plan §12.4's sole textual allowlist class: "historical architecture plans
 * with a superseded-API banner". Both halves are required. The directory is the
 * estate's one home for architecture plans, and the banner is the sentence that
 * tells a reader the declarations below are dead — so a live document cannot
 * buy silence by pasting the banner in, and a genuinely historical plan cannot
 * buy it by living in the right directory. The plan itself is under the same
 * directory and carries no banner, so it is censused like any other file.
 *
 * §12.4's other allowlisted class — the plan's own sections that quote retired
 * spellings as their subject — needs no implementation: those sections spell
 * bare factory names, never a call, an import clause, or a side token, so no
 * detector pattern reaches them.
 */
const HISTORICAL_PLAN_DIRECTORY = "docs/architecture/";
const SUPERSEDED_API_BANNER = "**Superseded relation spellings.**";

function isBanneredHistoricalPlan(file: string, text: string): boolean {
  return (
    file.startsWith(HISTORICAL_PLAN_DIRECTORY) &&
    text.includes(SUPERSEDED_API_BANNER)
  );
}

const RETIRED_SYMBOL_SET: ReadonlySet<string> = new Set(
  RETIRED_RELATION_SYMBOLS
);
const RETIRED_FACTORY_SET: ReadonlySet<string> = new Set(
  RETIRED_RELATION_FACTORIES
);

/**
 * The retired terminal capabilities a relation-factory-rooted chain must stop
 * exposing (plan §12.4): the junction side tokens `.A()`/`.B()`, ordinary
 * `.optional()`, and relation `.unique()`. The zero-argument `.fields()`
 * compatibility stage is censused beside them under the token `fields()`,
 * because only the zero-argument call is retired — `.fields("authorId")`
 * survives.
 */
const CAPABILITY_SET: ReadonlySet<string> = new Set([
  "A",
  "B",
  "optional",
  "unique",
]);
const SELF_EXEMPT_SET: ReadonlySet<string> = new Set(CENSUS_SELF_EXEMPT_FILES);

const AST_EXTENSIONS: ReadonlySet<string> = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".woff",
  ".woff2",
]);

const BINARY_BASENAMES: ReadonlySet<string> = new Set([".DS_Store"]);

/** Which detector owns a file: the parseable source gate, the text gate, or neither. */
type CensusRegion = "source" | "text" | "binary";

function censusRegion(file: string): CensusRegion {
  if (BINARY_BASENAMES.has(basename(file))) return "binary";
  const extension = extname(file);
  if (BINARY_EXTENSIONS.has(extension)) return "binary";
  return AST_EXTENSIONS.has(extension) ? "source" : "text";
}

/**
 * Every file the estate is about to publish: tracked files plus worktree files
 * git does not ignore. `git ls-files` is the enumerator so no directory can be
 * missed and no gate has to keep its own directory list.
 */
function censusFiles(repositoryRoot: string): string[] {
  const listed = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  const files = new Set(listed.split("\0").filter((file) => file.length > 0));
  return [...files].sort();
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

/** Adds `amount` occurrences of `token`; an absent token never becomes a zero entry. */
function add(counts: Map<string, number>, token: string, amount: number): void {
  if (amount === 0) return;
  counts.set(token, (counts.get(token) ?? 0) + amount);
}

/** `"<file> <token> <count>"`, one line per token, tokens sorted. */
function entries(file: string, counts: ReadonlyMap<string, number>): string[] {
  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([token, count]) => `${file} ${token} ${count}`);
}

/* ------------------------------------------------------------------ *
 * Detector 1 — source AST gate
 * ------------------------------------------------------------------ */

/**
 * Retired identifiers occurring as executable AST identifiers. JSDoc is not
 * visited (`ts.forEachChild` skips it) and neither are string literals, so this
 * region stays disjoint from the text gate's.
 */
export function sourceIdentifierEntries(file: string, text: string): string[] {
  const source = parse(file, text);
  const counts = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && RETIRED_SYMBOL_SET.has(node.text)) {
      add(counts, node.text, 1);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return entries(file, counts);
}

function isOrdinaryFactoryCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    return ORDINARY_RETIRED_FACTORIES.has(callee.name.text);
  }
  return ts.isIdentifier(callee) && ORDINARY_RETIRED_FACTORIES.has(callee.text);
}

/**
 * Whether an expression's receiver chain bottoms out in an ordinary retired
 * factory call, directly or through a same-file `const` bound to one. The
 * binding hop exists because the estate's own modifier probe spells the chain
 * that way (`const configured = base.through(...).A(...)`).
 */
function rootedInOrdinaryFactory(
  expression: ts.Expression,
  factoryBindings: ReadonlySet<string>
): boolean {
  let current: ts.Expression = expression;
  for (;;) {
    if (ts.isCallExpression(current)) {
      if (isOrdinaryFactoryCall(current)) return true;
      current = current.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (ts.isIdentifier(current)) return factoryBindings.has(current.text);
    return false;
  }
}

function collectFactoryBindings(source: ts.SourceFile): ReadonlySet<string> {
  const bindings = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      rootedInOrdinaryFactory(node.initializer, bindings)
    ) {
      bindings.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return bindings;
}

/**
 * Retired capability calls on an ordinary-relation-factory-rooted chain:
 * `.A(...)`, `.B(...)`, `.optional()`, `.unique()`, and the zero-argument
 * `.fields()` stage. Unrelated methods with the same spelling are untouched,
 * because the receiver must root in a retired factory.
 */
export function sourceChainEntries(file: string, text: string): string[] {
  const source = parse(file, text);
  const factoryBindings = collectFactoryBindings(source);
  const counts = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      const zeroArgumentFields =
        method === "fields" && node.arguments.length === 0;
      if (
        (CAPABILITY_SET.has(method) || zeroArgumentFields) &&
        rootedInOrdinaryFactory(node.expression.expression, factoryBindings)
      ) {
        add(counts, zeroArgumentFields ? "fields()" : method, 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Detector 2 — retired runtime discriminants
 * ------------------------------------------------------------------ */

function isManyToManyLiteral(node: ts.Node): node is ts.StringLiteral {
  return ts.isStringLiteral(node) && node.text === "manyToMany";
}

function isKindAccess(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === "kind";
}

function isEqualityOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
  );
}

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

/**
 * Retired executable runtime vocabulary. This deliberately ignores bare
 * strings, names, prose, and contract inventories: only the five AST roles
 * that can recreate the old membership discriminants are counted.
 */
export function sourceRetiredDiscriminantEntries(
  file: string,
  text: string
): string[] {
  const source = parse(file, text);
  const counts = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isLiteralTypeNode(node) && isManyToManyLiteral(node.literal)) {
      add(counts, "literalType", 1);
    } else if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === "kind") ||
        (ts.isStringLiteral(node.name) && node.name.text === "kind")) &&
      isManyToManyLiteral(node.initializer)
    ) {
      add(counts, "kindConstruction", 1);
    } else if (
      ts.isBinaryExpression(node) &&
      isEqualityOperator(node.operatorToken.kind) &&
      ((isKindAccess(node.left) && isManyToManyLiteral(node.right)) ||
        (isManyToManyLiteral(node.left) && isKindAccess(node.right)))
    ) {
      add(counts, "kindComparison", 1);
    } else if (
      ts.isCaseClause(node) &&
      isManyToManyLiteral(node.expression) &&
      ts.isSwitchStatement(node.parent.parent) &&
      isKindAccess(node.parent.parent.expression)
    ) {
      add(counts, "kindCase", 1);
    } else if (
      ts.isReturnStatement(node) &&
      node.expression &&
      isManyToManyLiteral(node.expression)
    ) {
      const owner = enclosingFunction(node);
      if (owner?.type?.getText(source).includes("MembershipReadOrientation")) {
        add(counts, "membershipOrientationReturn", 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Detector 3 — tracked-text gate
 * ------------------------------------------------------------------ */

/**
 * A retired factory spelled as a call: a dot, the factory name, an open paren.
 * A bare word never matches, so `manyToOneId String` in `prisma/schema.prisma`
 * and a rendered word in a DOM capture stay green while a real
 * `s.manyToOne(...)` example does not. (census-pattern-table: this comment is
 * the pattern's own specification, so this one node is exempt from the text
 * census — no other region of this file is.)
 */
const FACTORY_CALL_PATTERN =
  /\.\s*(?:manyToMany|manyToOne|oneToMany|oneToOne|polymorphicToMany|polymorphicToOne)\s*\(/g;

/** A named import/export clause; its specifiers are checked whole-word. */
const IMPORT_CLAUSE_PATTERN = /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}/g;

const SPECIFIER_PATTERN = /[A-Za-z_$][\w$]*/g;

/**
 * The retired junction side tokens as a call with a quoted argument:
 * `.A("post_id")`. A single-letter method name plus a quote keeps `.Assert(` and
 * ordinary prose out. (census-pattern-table: same one-node exemption as above.)
 */
const JUNCTION_SIDE_PATTERN = /\.\s*[AB]\s*\(\s*["'`]/g;

function countTextPatterns(region: string, counts: Map<string, number>): void {
  add(counts, "factoryCall", region.match(FACTORY_CALL_PATTERN)?.length ?? 0);
  add(
    counts,
    "junctionSideCall",
    region.match(JUNCTION_SIDE_PATTERN)?.length ?? 0
  );
  for (const clause of region.matchAll(IMPORT_CLAUSE_PATTERN)) {
    const specifiers = clause[1] ?? "";
    for (const specifier of specifiers.matchAll(SPECIFIER_PATTERN)) {
      if (RETIRED_FACTORY_SET.has(specifier[0])) {
        add(counts, "namedImport", 1);
      }
    }
  }
}

/**
 * The text regions of a parseable source file: comment and JSDoc ranges plus
 * string and template-literal contents. Executable identifiers are the source
 * gate's region and are never returned here.
 */
function sourceTextRegions(file: string, text: string): string[] {
  const source = parse(file, text);
  const regions: string[] = [];
  const seenComments = new Set<number>();
  const addComments = (
    ranges: readonly ts.CommentRange[] | undefined
  ): void => {
    for (const range of ranges ?? []) {
      if (seenComments.has(range.pos)) continue;
      seenComments.add(range.pos);
      regions.push(text.slice(range.pos, range.end));
    }
  };
  const visit = (node: ts.Node): void => {
    addComments(ts.getLeadingCommentRanges(text, node.pos));
    addComments(ts.getTrailingCommentRanges(text, node.end));
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      regions.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return regions;
}

/**
 * Text-region occurrences for one file. A census module's own marked pattern
 * table or falsification witness is exempt one node at a time; every other
 * region of those same files is censused. A bannered historical architecture
 * plan is §12.4's one file-wide exemption.
 */
export function trackedTextEntries(file: string, text: string): string[] {
  if (isBanneredHistoricalPlan(file, text)) return [];
  const counts = new Map<string, number>();
  const selfExempt = SELF_EXEMPT_SET.has(file);
  const regions =
    censusRegion(file) === "source" ? sourceTextRegions(file, text) : [text];
  for (const region of regions) {
    if (selfExempt && region.includes(CENSUS_SELF_EXEMPTION_MARKER)) continue;
    countTextPatterns(region, counts);
  }
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Whole-estate collection
 * ------------------------------------------------------------------ */

export interface RelationLanguageCensus {
  /** Retired identifiers, `"<file> <symbol> <count>"`. */
  readonly identifiers: readonly string[];
  /** Retired chain capabilities, `"<file> <capability> <count>"`. */
  readonly chains: readonly string[];
  /** Retired executable membership discriminants. */
  readonly retiredDiscriminants: readonly string[];
  /** Retired text patterns, `"<file> <patternId> <count>"`. */
  readonly text: readonly string[];
}

export function collectRelationLanguageCensus(
  repositoryRoot: string
): RelationLanguageCensus {
  const identifiers: string[] = [];
  const chains: string[] = [];
  const retiredDiscriminants: string[] = [];
  const text: string[] = [];
  for (const file of censusFiles(repositoryRoot)) {
    const region = censusRegion(file);
    if (region === "binary") continue;
    const contents = readFileSync(join(repositoryRoot, file), "utf8");
    if (region === "source") {
      identifiers.push(...sourceIdentifierEntries(file, contents));
      chains.push(...sourceChainEntries(file, contents));
      retiredDiscriminants.push(
        ...sourceRetiredDiscriminantEntries(file, contents)
      );
    }
    text.push(...trackedTextEntries(file, contents));
  }
  return { identifiers, chains, retiredDiscriminants, text };
}
