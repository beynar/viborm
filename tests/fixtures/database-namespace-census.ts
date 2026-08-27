import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";

/**
 * The shipped-source census of the one database namespace representation
 * (`docs/architecture/database-namespace-plan.md` §9 Unit G, §10, §12, §13).
 *
 * §9's detector list names invariants that behavior tests cannot enumerate
 * reliably: a behavior test proves what one code path does, while these prove
 * that a SECOND path, a second spelling, or a second owner does not exist
 * anywhere in the shipped estate.
 *
 * ELEVEN detectors own DISJOINT (region, token) pairs of the same file set, so
 * one occurrence is never counted twice and one invariant is never guarded
 * twice:
 *
 *  1. `sessionRouting`      — `SET search_path` / `USE <db>` in executable SQL;
 *  2. `hardcodedPublic`     — a `'public'` SQL literal, and a bare `"public"`
 *                             default outside the PostgresAdapter owner;
 *  3. `ambientMysqlDatabase`— `DATABASE()` as a MySQL catalog target;
 *  4. `rejectedAliasMember` — the §13 alias spellings in member position;
 *  5. `modelScopeNamespace` — `namespace` as model/query-scope state;
 *  6. `configurableSource`  — `namespace` on any option/config type outside the
 *                             seven admitted driver option types;
 *  7. `sqliteAttachment`    — an `ATTACH`/`DETACH` statement, or an attachment
 *                             or namespace member on a SQLite surface;
 *  8. `attestationInference`— the MySQL2 attestation produced from transport or
 *                             class evidence rather than the caller's literal;
 *  9. `attestationCopy`     — the attestation redeclared on an adapter, journal,
 *                             cache, instrumentation, or command-option type;
 * 10. `migrationContextExport` — a re-export of `MigrationContext` or
 *                             `MigrationContextOptions`;
 * 11. `liveMigrationExecutor` — a live migration execution site.
 *
 * SCOPE is `src/**` and only its parseable source files. Documentation, prose,
 * `AGENTS.md`, benchmarks, and tests are deliberately outside every detector,
 * because §9 explicitly allows rejected-alias tests and prose to spell the
 * banned vocabulary. Inside a source file the detectors read AST nodes and
 * STRING/TEMPLATE LITERAL contents only — never a comment — so a comment
 * explaining why `USE` is refused can never make the census red, and a
 * lookalike identifier can never make it green.
 *
 * The estate is enumerated through `git ls-files` rather than a directory walk,
 * so no subtree can be forgotten. Tracked files plus worktree files git does
 * not ignore are censused, minus tracked working-tree deletions: a file already
 * in the worktree is part of the estate a commit is about to publish, while a
 * tracked path deleted from the worktree is leaving it.
 *
 * ASSERTIONS. Ten detectors assert zero: their subject exists nowhere in the
 * shipped estate. The eleventh, `liveMigrationExecutor`, asserts a manifest
 * instead, because live execution sites are not a thing the estate has none of
 * — what it pins is that they are exactly the admitted owners and that no
 * parallel driver path stands beside them (§3.5, §12.13). A manifest is an
 * exact `"<file> <token> <count>"` list, so a NEW occurrence is red immediately
 * while the admitted ones stay visible and countable; moving a site re-pins it
 * deliberately, in the same change.
 */

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

/**
 * §13 "Dialect-native public option names" plus the §144 non-goal list: the
 * spellings that would name the one driver-binding fact a second way. The
 * census owns them in MEMBER position only — a rejected-alias test, a comment,
 * and this list itself spell them as data, which no detector reads.
 */
export const REJECTED_NAMESPACE_ALIASES = [
  "databaseName",
  "databaseNamespace",
  "databaseSchema",
  "keyspace",
  "pgSchema",
  "searchPath",
] as const;

/** The admitted public spelling (plan §1.1). */
export const ADMITTED_NAMESPACE_MEMBER = "namespace";

/** The MySQL2 transport assertion (plan §1.3). */
export const MIGRATION_ATTESTATION_MEMBER = "migrationNamespaceAttestation";

/**
 * §1.1's exact seven option types — the ONLY declarations that may configure a
 * namespace. Every other options/config type that grows the member is a second
 * configurable source, which §13 "Generic `VibORMConfig` namespace options"
 * rejects.
 */
export const ADMITTED_DRIVER_OPTION_TYPES = [
  "BunSQLDriverOptions",
  "MySQL2DriverOptions",
  "NeonHTTPDriverOptions",
  "PGliteDriverOptions",
  "PgDriverOptions",
  "PlanetScaleDriverOptions",
  "PostgresDriverOptions",
] as const;

/**
 * §13's one admitted `USE` site: the pinned MySQL migration-artifact session's
 * private owner, whose "owner, lifetime, lock, target, and cleanup are the same
 * physical session".
 *
 * Unit F landed that owner. The exemption is ONE module path and it is sound
 * only because the statement it spells is unreachable except from a pinned
 * migration session — `MySQL2Driver.pinnedSession` reserves the connection and
 * DESTROYS it afterwards, so the selection cannot leak into pooled traffic. Any
 * other module spelling `USE` is a defect, and the same exemption does not
 * extend to `SET search_path`, which has no admitted producer at all.
 */
export const PINNED_ARTIFACT_SESSION_OWNERS: readonly string[] = [
  "src/migrations/drivers/mysql/pinned-session.ts",
];

/**
 * §1.2's schema-fixed `postgresAdapter` owner: the one module allowed to spell
 * `"public"` as a value, because §1.3 makes it PostgreSQL's default target.
 *
 * TODO(unit-A): the default lands here with `new PostgresAdapter(namespace?)`.
 * Until then the owner spells no `"public"` at all and the token counts zero.
 */
export const POSTGRES_DEFAULT_NAMESPACE_OWNER =
  "src/adapters/databases/postgres/postgres-adapter.ts";

/** §9's "no second live migration executor": the regions a live executor may live in. */
const LIVE_MIGRATION_REGIONS = ["src/migrations/", "src/cli/"] as const;

/** Model state and query-scope state (plan §12.8): no namespace copy reaches here. */
const MODEL_SCOPE_REGIONS = ["src/schema/", "src/query-engine/"] as const;

/** The SQLite surfaces that must expose neither a namespace nor an attachment. */
const SQLITE_REGIONS = [
  "src/adapters/databases/sqlite/",
  "src/drivers/bun-sqlite/",
  "src/drivers/d1/",
  "src/drivers/libsql/",
  "src/drivers/sqlite3/",
] as const;

/** §1.3's "Do not copy this fact into..." regions, minus command options. */
const ATTESTATION_FORBIDDEN_REGIONS = [
  "src/adapters/",
  "src/cache/",
  "src/instrumentation/",
  "src/migrations/storage/",
  "src/migrations/types.ts",
  "src/query-engine/",
  "src/sql/",
] as const;

/** Where a per-command options type lives (§1.3's "per-command options"). */
const COMMAND_OPTION_REGIONS = ["src/cli/", "src/migrations/"] as const;

/** The attachment vocabulary §13 "SQLite attachment alias" rejects. */
const ATTACHMENT_MEMBERS: ReadonlySet<string> = new Set([
  "attach",
  "attachAlias",
  "attached",
  "attachedDatabases",
  "attachment",
  "attachments",
  "detach",
]);

/**
 * §13 "Inferring a direct MySQL backend": the transport evidence a proxy can
 * control or emulate, plus the resolved target itself, none of which may
 * produce the attestation.
 */
const INFERENCE_SOURCES: ReadonlySet<string> = new Set([
  "backend",
  "backendName",
  "connectionString",
  "databaseUrl",
  "driverName",
  "handshake",
  "host",
  "hostname",
  "namespace",
  "port",
  "protocolVersion",
  "serverVersion",
  "socketPath",
  "url",
  "vendor",
  "version",
]);

/** §1.5's internal pair: neither name may reach a public entrypoint. */
const INTERNAL_MIGRATION_CONTEXT_EXPORTS: ReadonlySet<string> = new Set([
  "MigrationContext",
  "MigrationContextOptions",
]);

const ALIAS_SET: ReadonlySet<string> = new Set(REJECTED_NAMESPACE_ALIASES);
const ADMITTED_OPTION_TYPE_SET: ReadonlySet<string> = new Set(
  ADMITTED_DRIVER_OPTION_TYPES
);

/* ------------------------------------------------------------------ *
 * Executable-literal patterns
 * ------------------------------------------------------------------ */

/**
 * `SET search_path`, with or without `LOCAL`/`SESSION`. §12.5 forbids it in
 * generated SQL outright; PostgreSQL routing must be qualification, not session
 * state. A prose mention is a comment and never reaches a literal region.
 */
const SET_SEARCH_PATH_PATTERN =
  /\bset\s+(?:local\s+|session\s+)?search_path\b/i;

/**
 * A `USE` STATEMENT: the verb opening a statement, then EITHER one identifier
 * ending that statement OR nothing at all, because the region ends where the
 * verb does.
 *
 * The second arm is what makes the detector see an INTERPOLATED target. A
 * template `` `USE ${quoteIdentifier(name)}` `` reaches this gate as a head
 * whose text is exactly `"USE "` — the identifier lives in the substitution,
 * which is an expression and not a literal region — so a pattern demanding a
 * spelled identifier reads the one statement in the shipped estate that
 * actually issues `USE` as no statement at all. That hole was found by probing
 * the real owner (`sessionRoutingEntries` returned `[]` for it with AND without
 * the allowlist), and it made the allowlist inert: any module could have
 * emitted `` `USE ${db}` `` unseen.
 *
 * The bias is deliberately fail-closed. A line whose executable text ends on
 * the bare verb is counted whether or not the substitution turns out to name a
 * database, because an absence gate that under-reads is worth nothing. `USE`
 * inside a sentence still never matches — the verb must OPEN the statement — so
 * an error message, a refusal string, or a template like
 * `` `... may not use ${name} here` `` stays green.
 */
const USE_STATEMENT_PATTERN =
  /(?:^|[;\n])\s*use\s+(?:(?:`[^`]+`|"[^"]+"|[A-Za-z_$][\w$]*)\s*;?\s*)?$/im;

/** A `'public'` SQL string operand embedded in generated SQL (§4.1, §4.2). */
const SQL_PUBLIC_LITERAL_PATTERN = /(?<![\w.])'public'(?!\w)/g;

/** MySQL's ambient current-database function (§5.2). */
const MYSQL_DATABASE_FUNCTION_PATTERN = /\bdatabase\s*\(\s*\)/gi;

/** `ATTACH DATABASE` / `DETACH DATABASE`, and `ATTACH` applied to a value. */
const ATTACH_KEYWORD_PATTERN = /\b(?:attach|detach)\s+database\b/i;
const ATTACH_VALUE_PATTERN = /\battach\s+(?:'|"|`|\?|:|\$)/i;

/**
 * A module specifier naming the migration context module, with or without an
 * extension. `export *` from it would launder the internal pair into a barrel.
 */
const CONTEXT_MODULE_SPECIFIER_PATTERN = /(?:^|\/)context(?:\.[cm]?[jt]s)?$/;

/* ------------------------------------------------------------------ *
 * Shared mechanics
 * ------------------------------------------------------------------ */

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
  return regions.some((region) => file.startsWith(region));
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

function walk(source: ts.SourceFile, visit: (node: ts.Node) => void): void {
  const step = (node: ts.Node): void => {
    visit(node);
    ts.forEachChild(node, step);
  };
  ts.forEachChild(source, step);
}

/**
 * The EXECUTABLE text of a source file: string and template-literal contents.
 * Comments and JSDoc are deliberately absent, which is what makes prose,
 * rationale, and refusal explanations permanently safe from the SQL detectors.
 */
function literalRegions(file: string, text: string): string[] {
  const source = parse(file, text);
  const regions: string[] = [];
  walk(source, (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      regions.push(node.text);
    }
  });
  return regions;
}

function countMatches(region: string, pattern: RegExp): number {
  return region.match(pattern)?.length ?? 0;
}

/* ------------------------------------------------------------------ *
 * Member occurrences
 * ------------------------------------------------------------------ */

type MemberRole = "declaration" | "read";

interface MemberOccurrence {
  /** The member's spelling. */
  readonly name: string;
  /**
   * `declaration` covers every position that CREATES a member: a type member,
   * a class property, an object-literal property, a property write, and
   * `Object.defineProperty`. `read` covers a property access, which consumes a
   * fact rather than copying it — §1.3's admission boundary reads the driver
   * attestation directly and must stay green.
   */
  readonly role: MemberRole;
  /** The nearest enclosing interface/type-alias/class name, when there is one. */
  readonly ownerType: string | undefined;
}

function memberNameOf(name: ts.Node): string | undefined {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function enclosingTypeName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeAliasDeclaration(current) ||
      ts.isClassDeclaration(current)
    ) {
      return current.name?.text;
    }
    current = current.parent;
  }
  return undefined;
}

function isDefinePropertyCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === "defineProperty" ||
      callee.name.text === "defineProperties")
  );
}

function isNamedMemberDeclaration(node: ts.Node): node is ts.NamedDeclaration {
  return (
    ts.isPropertySignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isMethodSignature(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isEnumMember(node)
  );
}

function isPropertyWrite(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.left)
  );
}

/**
 * Every member occurrence of a source file, tagged by role and by the type that
 * declares it. One walk serves five detectors, so their regions stay disjoint by
 * (name, region) rather than by re-deriving the same AST facts five times.
 */
function memberOccurrences(
  file: string,
  text: string
): readonly MemberOccurrence[] {
  const source = parse(file, text);
  const found: MemberOccurrence[] = [];
  /**
   * The left-hand side of a property write is reached twice by one traversal:
   * once as the write itself and once as an ordinary access. Suppressing the
   * access keeps a write worth exactly one occurrence, so a count is a count of
   * source positions rather than of visits.
   */
  const writeTargets = new Set<ts.Node>();
  const declare = (node: ts.Node, name: string | undefined): void => {
    if (name === undefined) return;
    found.push({
      name,
      role: "declaration",
      ownerType: enclosingTypeName(node),
    });
  };
  walk(source, (node) => {
    if (isNamedMemberDeclaration(node)) {
      declare(node, node.name ? memberNameOf(node.name) : undefined);
      return;
    }
    if (isPropertyWrite(node)) {
      const target = node.left as ts.PropertyAccessExpression;
      writeTargets.add(target);
      declare(node, target.name.text);
      return;
    }
    if (ts.isCallExpression(node) && isDefinePropertyCall(node)) {
      const key = node.arguments[1];
      if (key && ts.isStringLiteral(key)) declare(node, key.text);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (writeTargets.has(node)) return;
      found.push({
        name: node.name.text,
        role: "read",
        ownerType: enclosingTypeName(node),
      });
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      if (ts.isStringLiteral(key)) {
        found.push({
          name: key.text,
          role: "read",
          ownerType: enclosingTypeName(node),
        });
      }
    }
  });
  return found;
}

function isOptionOrConfigType(ownerType: string | undefined): boolean {
  return (
    ownerType !== undefined &&
    (ownerType.endsWith("Options") || ownerType.endsWith("Config"))
  );
}

/* ------------------------------------------------------------------ *
 * Detector 1 — runtime session routing
 * ------------------------------------------------------------------ */

/**
 * §12.5: "Runtime emits neither `SET search_path` nor `USE`". The one admitted
 * `USE` producer is §13's pinned migration-artifact session, named by path in
 * `owners` so the exemption is a listed module rather than a shape a new site
 * could imitate.
 */
export function sessionRoutingEntries(
  file: string,
  text: string,
  owners: readonly string[] = PINNED_ARTIFACT_SESSION_OWNERS
): string[] {
  const counts = new Map<string, number>();
  const exempt = owners.includes(file);
  for (const region of literalRegions(file, text)) {
    if (SET_SEARCH_PATH_PATTERN.test(region)) add(counts, "setSearchPath", 1);
    if (!exempt && USE_STATEMENT_PATTERN.test(region)) {
      add(counts, "useDatabase", 1);
    }
  }
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Detector 2 — hardcoded PostgreSQL schema
 * ------------------------------------------------------------------ */

/**
 * Two disjoint tokens. `sqlPublicLiteral` is a `'public'` operand inside
 * generated SQL, which §4.2 replaces with the bound namespace and which is
 * never admitted anywhere. `defaultPublicValue` is a bare `"public"` VALUE,
 * which §1.3 admits in exactly one module: the schema-fixed adapter owner.
 */
export function hardcodedPublicEntries(
  file: string,
  text: string,
  owner: string = POSTGRES_DEFAULT_NAMESPACE_OWNER
): string[] {
  const counts = new Map<string, number>();
  const isOwner = file === owner;
  for (const region of literalRegions(file, text)) {
    add(
      counts,
      "sqlPublicLiteral",
      countMatches(region, SQL_PUBLIC_LITERAL_PATTERN)
    );
    if (!isOwner && region === "public") add(counts, "defaultPublicValue", 1);
  }
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Detector 3 — MySQL ambient database
 * ------------------------------------------------------------------ */

/**
 * §5.2: MySQL catalog reads target the resolved namespace, never the
 * connection's ambient current database. The pattern matches the SQL function
 * call, so a column or member spelled `database` is untouched.
 */
export function ambientMysqlDatabaseEntries(
  file: string,
  text: string
): string[] {
  const counts = new Map<string, number>();
  for (const region of literalRegions(file, text)) {
    add(
      counts,
      "databaseFunction",
      countMatches(region, MYSQL_DATABASE_FUNCTION_PATTERN)
    );
  }
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Detector 4 — rejected alias members
 * ------------------------------------------------------------------ */

/**
 * §13 "Dialect-native public option names". The gate owns the ALIAS spellings
 * across the whole shipped estate, in declaration and read position alike: an
 * alias that is only read still proves a second representation exists. The
 * exact spelling `namespace` belongs to detectors 5–7, so the regions stay
 * disjoint by token.
 */
export function rejectedAliasMemberEntries(
  file: string,
  text: string
): string[] {
  const counts = new Map<string, number>();
  for (const member of memberOccurrences(file, text)) {
    if (ALIAS_SET.has(member.name)) add(counts, member.name, 1);
  }
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Detector 5 — model and query-scope state
 * ------------------------------------------------------------------ */

/**
 * §12.8: "Models, relations, query scopes, operation programs, and result types
 * contain no namespace copy", and §13 rejects a query-scope namespace outright.
 * Only DECLARATIONS count: physical rendering may READ `adapter.namespace`
 * inside the query engine, which is the design, not a copy.
 */
export function modelScopeNamespaceEntries(
  file: string,
  text: string
): string[] {
  if (!inRegion(file, MODEL_SCOPE_REGIONS)) return [];
  const counts = new Map<string, number>();
  for (const member of memberOccurrences(file, text)) {
    if (
      member.role === "declaration" &&
      member.name === ADMITTED_NAMESPACE_MEMBER
    ) {
      add(counts, "stateMember", 1);
    }
  }
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Detector 6 — second configurable source
 * ------------------------------------------------------------------ */

/**
 * §13 "Generic `VibORMConfig` namespace options": one configurable source per
 * driver, and only on §1.1's seven option types. Any other declaration whose
 * name ends in `Options` or `Config` that grows a `namespace` member is a
 * second answer to the same question.
 *
 * The model/query-scope regions belong to detector 5 and the SQLite regions to
 * detector 7, so no occurrence is counted twice.
 */
export function configurableSourceEntries(
  file: string,
  text: string
): string[] {
  if (inRegion(file, MODEL_SCOPE_REGIONS) || inRegion(file, SQLITE_REGIONS)) {
    return [];
  }
  const counts = new Map<string, number>();
  for (const member of memberOccurrences(file, text)) {
    if (
      member.role === "declaration" &&
      member.name === ADMITTED_NAMESPACE_MEMBER &&
      isOptionOrConfigType(member.ownerType) &&
      !ADMITTED_OPTION_TYPE_SET.has(member.ownerType ?? "")
    ) {
      add(counts, "optionMember", 1);
    }
  }
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Detector 7 — SQLite attachment surface
 * ------------------------------------------------------------------ */

/**
 * §13 "SQLite attachment alias" and Goal 7. Three tokens: an `ATTACH`/`DETACH`
 * statement anywhere in shipped SQL, an attachment member on a SQLite surface,
 * and a `namespace` member on a SQLite surface — the false equivalent §12.20
 * forbids.
 */
export function sqliteAttachmentEntries(file: string, text: string): string[] {
  const counts = new Map<string, number>();
  for (const region of literalRegions(file, text)) {
    if (
      ATTACH_KEYWORD_PATTERN.test(region) ||
      ATTACH_VALUE_PATTERN.test(region)
    ) {
      add(counts, "attachStatement", 1);
    }
  }
  if (!inRegion(file, SQLITE_REGIONS)) return entries(file, counts);
  for (const member of memberOccurrences(file, text)) {
    if (member.role !== "declaration") continue;
    if (ATTACHMENT_MEMBERS.has(member.name)) add(counts, "attachmentMember", 1);
    if (member.name === ADMITTED_NAMESPACE_MEMBER) {
      add(counts, "sqliteNamespaceMember", 1);
    }
  }
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Detector 8 — attestation inference
 * ------------------------------------------------------------------ */

function attestationProducerValue(node: ts.Node): ts.Node | undefined {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === MIGRATION_ATTESTATION_MEMBER
  ) {
    return node.initializer;
  }
  if (
    ts.isPropertyAssignment(node) &&
    memberNameOf(node.name) === MIGRATION_ATTESTATION_MEMBER
  ) {
    return node.initializer;
  }
  if (
    isPropertyWrite(node) &&
    (node.left as ts.PropertyAccessExpression).name.text ===
      MIGRATION_ATTESTATION_MEMBER
  ) {
    return node.right;
  }
  if (
    ts.isPropertyDeclaration(node) &&
    memberNameOf(node.name) === MIGRATION_ATTESTATION_MEMBER
  ) {
    return node.initializer;
  }
  if (ts.isCallExpression(node) && isDefinePropertyCall(node)) {
    const key = node.arguments[1];
    const descriptor = node.arguments[2];
    if (
      key &&
      ts.isStringLiteral(key) &&
      key.text === MIGRATION_ATTESTATION_MEMBER
    ) {
      return descriptor;
    }
  }
  return undefined;
}

function inferenceTokensOf(value: ts.Node): ReadonlySet<string> {
  const tokens = new Set<string>();
  const inspect = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
    ) {
      tokens.add("classInference");
    }
    if (ts.isIdentifier(node) && INFERENCE_SOURCES.has(node.text)) {
      tokens.add("transportInference");
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      INFERENCE_SOURCES.has(node.name.text)
    ) {
      tokens.add("transportInference");
    }
    ts.forEachChild(node, inspect);
  };
  inspect(value);
  return tokens;
}

/**
 * §13 "Inferring a direct MySQL backend": the attestation is the caller's
 * literal and nothing else. The gate finds every node that PRODUCES the
 * attestation value and inspects that value's subtree for transport evidence or
 * an `instanceof` class test. A pass-through of the caller's own option is
 * green, which is exactly what §1.3's normalizer does.
 */
export function attestationInferenceEntries(
  file: string,
  text: string
): string[] {
  const source = parse(file, text);
  const counts = new Map<string, number>();
  walk(source, (node) => {
    const value = attestationProducerValue(node);
    if (!value) return;
    for (const token of inferenceTokensOf(value)) add(counts, token, 1);
  });
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Detector 9 — attestation copies
 * ------------------------------------------------------------------ */

/**
 * §1.3: "Do not copy this fact into `DatabaseAdapter`, `MigrationTarget`,
 * journals, cache identity, instrumentation, SQL rendering, or per-command
 * options." Only DECLARATIONS count, so the one admission boundary may keep
 * reading `driver.migrationNamespaceAttestation` — a read is the consumption
 * §1.3 requires, and a declaration is the second representation it forbids.
 */
export function attestationCopyEntries(file: string, text: string): string[] {
  const inForbiddenRegion = inRegion(file, ATTESTATION_FORBIDDEN_REGIONS);
  const inCommandRegion = inRegion(file, COMMAND_OPTION_REGIONS);
  if (!(inForbiddenRegion || inCommandRegion)) return [];
  const counts = new Map<string, number>();
  for (const member of memberOccurrences(file, text)) {
    if (
      member.role !== "declaration" ||
      member.name !== MIGRATION_ATTESTATION_MEMBER
    ) {
      continue;
    }
    if (inForbiddenRegion) add(counts, "forbiddenOwner", 1);
    else if (isOptionOrConfigType(member.ownerType)) {
      add(counts, "commandOption", 1);
    }
  }
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Detector 10 — MigrationContext export surface
 * ------------------------------------------------------------------ */

/**
 * §1.5: `MigrationContext` and `MigrationContextOptions` stop being exported
 * from `viborm/migrations`, with "no compatibility export". A module-local
 * `export class MigrationContext` in the context module itself stays legal —
 * internal consumers import it — so the gate counts only the two ways a symbol
 * REACHES a barrel: a named re-export, and an `export *` that launders the
 * context module wholesale.
 */
export function migrationContextExportEntries(
  file: string,
  text: string
): string[] {
  const source = parse(file, text);
  const counts = new Map<string, number>();
  walk(source, (node) => {
    if (!(ts.isExportDeclaration(node) && node.moduleSpecifier)) return;
    const specifier = ts.isStringLiteral(node.moduleSpecifier)
      ? node.moduleSpecifier.text
      : "";
    if (!node.exportClause) {
      if (CONTEXT_MODULE_SPECIFIER_PATTERN.test(specifier)) {
        add(counts, "starReexport", 1);
      }
      return;
    }
    if (!ts.isNamedExports(node.exportClause)) return;
    for (const element of node.exportClause.elements) {
      const exported = (element.propertyName ?? element.name).text;
      if (INTERNAL_MIGRATION_CONTEXT_EXPORTS.has(exported)) {
        add(counts, `reexport:${exported}`, 1);
      }
    }
  });
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Detector 11 — live migration executors
 * ------------------------------------------------------------------ */

/**
 * §12.13 "no mutable or parallel migration driver path exists" and §12.29's one
 * admission owner. A live migration executor is a site that submits SQL to a
 * real driver: `_executeRaw` on any receiver, or a `createQueryExecutor`
 * factory call. Counting the CALL SITES rather than the modules means a new
 * executor inside an already-listed module is red too.
 */
export function liveMigrationExecutorEntries(
  file: string,
  text: string
): string[] {
  if (!inRegion(file, LIVE_MIGRATION_REGIONS)) return [];
  const source = parse(file, text);
  const counts = new Map<string, number>();
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "_executeRaw"
    ) {
      add(counts, "executeRaw", 1);
      return;
    }
    if (ts.isIdentifier(callee) && callee.text === "createQueryExecutor") {
      add(counts, "queryExecutorFactory", 1);
    }
  });
  return entries(file, counts);
}

/* ------------------------------------------------------------------ *
 * Whole-estate collection
 * ------------------------------------------------------------------ */

/**
 * Every existing shipped source file: tracked files plus worktree files git
 * does not ignore, minus tracked working-tree deletions.
 */
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
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  const deletedFiles = new Set(
    deleted.split("\0").filter((file) => file.length > 0)
  );
  const files = new Set(listed.split("\0").filter((file) => file.length > 0));
  return [...files]
    .filter((file) => !deletedFiles.has(file) && isCensusSource(file))
    .sort();
}

export interface DatabaseNamespaceCensus {
  readonly sessionRouting: readonly string[];
  readonly hardcodedPublic: readonly string[];
  readonly ambientMysqlDatabase: readonly string[];
  readonly rejectedAliasMembers: readonly string[];
  readonly modelScopeNamespace: readonly string[];
  readonly configurableSources: readonly string[];
  readonly sqliteAttachment: readonly string[];
  readonly attestationInference: readonly string[];
  readonly attestationCopies: readonly string[];
  readonly migrationContextExports: readonly string[];
  readonly liveMigrationExecutors: readonly string[];
}

export function collectDatabaseNamespaceCensus(
  repositoryRoot: string
): DatabaseNamespaceCensus {
  const sessionRouting: string[] = [];
  const hardcodedPublic: string[] = [];
  const ambientMysqlDatabase: string[] = [];
  const rejectedAliasMembers: string[] = [];
  const modelScopeNamespace: string[] = [];
  const configurableSources: string[] = [];
  const sqliteAttachment: string[] = [];
  const attestationInference: string[] = [];
  const attestationCopies: string[] = [];
  const migrationContextExports: string[] = [];
  const liveMigrationExecutors: string[] = [];
  for (const file of censusFiles(repositoryRoot)) {
    const text = readFileSync(join(repositoryRoot, file), "utf8");
    sessionRouting.push(...sessionRoutingEntries(file, text));
    hardcodedPublic.push(...hardcodedPublicEntries(file, text));
    ambientMysqlDatabase.push(...ambientMysqlDatabaseEntries(file, text));
    rejectedAliasMembers.push(...rejectedAliasMemberEntries(file, text));
    modelScopeNamespace.push(...modelScopeNamespaceEntries(file, text));
    configurableSources.push(...configurableSourceEntries(file, text));
    sqliteAttachment.push(...sqliteAttachmentEntries(file, text));
    attestationInference.push(...attestationInferenceEntries(file, text));
    attestationCopies.push(...attestationCopyEntries(file, text));
    migrationContextExports.push(...migrationContextExportEntries(file, text));
    liveMigrationExecutors.push(...liveMigrationExecutorEntries(file, text));
  }
  return {
    sessionRouting,
    hardcodedPublic,
    ambientMysqlDatabase,
    rejectedAliasMembers,
    modelScopeNamespace,
    configurableSources,
    sqliteAttachment,
    attestationInference,
    attestationCopies,
    migrationContextExports,
    liveMigrationExecutors,
  };
}
