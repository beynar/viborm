/**
 * The Raptor 3 refusal census (N4, plan §4, D-52).
 *
 * The first census (`g4/root-review-C-receipts/`, four throwaway scripts) could
 * answer one question: does a sentence thrown inside `raptor3/**` also exist in
 * the shipped engine's source? Everything it could not match it called an
 * unmatched refusal — 63 entries, of which the map
 * (`g4/release/plan/refusals-map.md`) kept 55 after dropping the comment
 * fragments a line-regex extractor had mistaken for throws.
 *
 * This census makes the distinctions that one lacked, and it makes each of
 * them BY CONSTRUCTION, never by reading a message. A site has one of two
 * outcomes:
 *
 *   INVARIANT  the site throws through the engine's invariant owner
 *              (`shared/invariant.ts`: `assertInvariant`, `unreachable`,
 *              `EngineInvariantError`). An invariant names a state the code
 *              cannot be in when it is right; it is not a refusal, and it is
 *              told from one by CLASS. The owner is import-resolved, so a
 *              same-named local helper elsewhere is not mistaken for it.
 *   REFUSAL    everything else thrown in `raptor3/**`. A refusal is REGISTERED
 *              when the shipped engine carries the same sentence (an inherited
 *              contract) and PUBLIC when it does not — the candidate's own
 *              sentence, the count the map started 55 of.
 *
 * Matching a sentence against the shipped engine is the receipts' own matching,
 * unchanged: `${…}` becomes a boundary, backticks/quotes/`+` are dropped,
 * whitespace collapses; a sentence is registered when its longest static
 * fragment is found in the corpus, or when every fragment of 12 characters or
 * more is. Only the corpus moved: the shipped engine's own owners were retired
 * at `356254a2d`, so `src/**` outside `raptor3/` no longer contains the
 * sentences the census matched against. The corpus is therefore read from git
 * at {@link SHIPPED_CORPUS_REV} — the revision where the shipped engine and the
 * candidate still coexisted, and the one the receipts' `newness.mjs` already
 * used as its baseline. Replaying the receipts' matching there reproduces the
 * census's 63 raw entries exactly.
 *
 * Extraction is a TypeScript parse, not a line regex: a throw is a
 * `ThrowStatement` and a sentence is its message argument, so a doc comment
 * cannot become a refusal. The eight comment fragments the first census
 * reported (four of which the map had to skip by hand, four more that
 * `unmatched.json` had already lost) cannot be produced here.
 *
 * A sentence the site BUILDS is read at the site even when it leaves through
 * another owner: the engine composes its failures at one place
 * ({@link FAILURE_OWNER}), so `throw ctx.failure(failure, …)` is read as the
 * sentence `failure` was built from — a local `const`, a local factory, a
 * method of the throw's own class — and the owner's own substituted sentences
 * are read once, at the owner. That is one declared owner, not a call graph:
 * a value the site did not build stays unread, and the declaration is checked
 * against the tree on every run.
 *
 * Reachability is what this census can establish and no more. An invariant is
 * a foreclosure the tree proves. For a candidate refusal it says only that
 * nothing forecloses it; which admitted payload reaches that one is the map's
 * per-row ruling, and stays there. And a count
 * of sentences is never a count of capabilities: what this engine supports is
 * the behavioural closure inventory's fact
 * (`g4/release/closure/fc00/inventory.md`), one row per admitted fact.
 *
 * Read-only, no network. `--at <rev>` censuses a revision instead of the
 * working tree, which is how a run is compared against its own base. The run
 * exits non-zero when the census could not be produced as described — the
 * corpus unreadable, or the declared failure owner not where it is read.
 *
 *   node scripts/raptor3-refusal-census.mjs [--out <file>] [--at <rev>] [--shipped-rev <rev>] [--root <dir>]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { posix, relative, resolve } from "node:path";
import ts from "typescript";

const ENGINE = "src/query-engine/raptor3";
const INVARIANT_OWNER = `${ENGINE}/shared/invariant.ts`;

/**
 * The revision the shipped engine's sentences are read from. See the header:
 * the shipped owners no longer exist in the working tree, and this is the
 * revision the first census's newness step already used.
 */
const SHIPPED_CORPUS_REV = "0cc61e61f";

/** The sentences the map (`g4/release/plan/refusals-map.md`) started from. */
const MAP_SENTENCES = 55;

/** The receipts' threshold, unchanged. */
const FRAGMENT_MIN = 12;

/**
 * The failure owner a sentence reaches the outside world THROUGH.
 * `OperationContext.failure` composes a failure — attribution, record-series
 * progress, a provider-result substitution — and answers the value it is
 * given, so `throw ctx.failure(failure, …)` states the sentence the SITE
 * built and handed over. The census follows that one argument with the same
 * resolution it already uses for a direct throw (a local `const`, a local
 * factory, a method of the throw's own class, a named constant, either arm of
 * a conditional); a value the site did NOT build — a catch binding, a
 * parameter, a property of another object — still resolves to nothing,
 * because that sentence is another owner's.
 *
 * `substitutes` is the other half of the same fact: the sentences the owner
 * itself builds for a value it REPLACES. They are the owner's, so they are
 * counted ONCE, at the owner's own construction, and not again at each of the
 * sites that can state them.
 *
 * This is one declared owner, not a call graph: the census follows no other
 * indirection and infers no reachability. The declaration is re-checked
 * against the tree on every run — a census whose owner has moved is not the
 * census this report describes, and it fails loudly instead of silently
 * dropping the sentences that reach the world through it.
 */
const FAILURE_OWNER = {
  file: `${ENGINE}/shared/operation-context.ts`,
  class: "OperationContext",
  method: "failure",
  /** The parameter that carries the value the site built. */
  carries: 0,
  parameter: "error",
  substitutes: true,
};

const OPTIONS = ["--out", "--shipped-rev", "--at", "--root"];
const usage = `Usage: raptor3-refusal-census.mjs [${OPTIONS.map((option) => `${option} <value>`).join("] [")}]`;
const readOption = (argv, name) => {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(usage);
  return value;
};
const argv = process.argv.slice(2);
const outPath = readOption(argv, "--out");
const shippedRev = readOption(argv, "--shipped-rev") ?? SHIPPED_CORPUS_REV;
/** The tree to census: a revision, or the working tree when absent. */
const at = readOption(argv, "--at");
for (let index = 0; index < argv.length; index++) {
  if (OPTIONS.includes(argv[index])) index++;
  else throw new Error(usage);
}
/**
 * The repository this census reads — its sources, its git history and its
 * shipped corpus. It is this repository unless a caller names another one,
 * which is how the harness self-test censuses a fixture tree that spells the
 * shapes instead of censusing the engine to check itself.
 */
const root = resolve(
  readOption(argv, "--root") ?? resolve(import.meta.dirname, "..")
);

const git = (...args) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
const listWorkingTree = (directory, out = []) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) listWorkingTree(path, out);
    else if (entry.name.endsWith(".ts"))
      out.push(relative(root, path).split("\\").join("/"));
  }
  return out;
};
/** Repository-relative `.ts` paths under a prefix, in the censused tree. */
const listSources = (prefix) =>
  (at === undefined
    ? listWorkingTree(resolve(root, prefix))
    : git("ls-tree", "-r", "--name-only", at, "--", prefix)
        .split("\n")
        .filter((path) => path.endsWith(".ts"))
  ).sort();
const readSource = (path) =>
  at === undefined
    ? readFileSync(resolve(root, path), "utf8")
    : git("show", `${at}:${path}`);

// ---------------------------------------------------------------------------
// Sites: a throw statement, or a call to the invariant owner.
// ---------------------------------------------------------------------------

/**
 * The sentences a message expression can spell, with `${…}` kept as the
 * receipts wrote it. A conditional between two whole sentences spells both —
 * one site, two contracts — while a conditional inside a `${…}` stays part of
 * the one sentence around it, exactly as the receipts recorded it.
 */
const renderSentences = (node, at) => {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isParenthesizedExpression(node))
    return renderSentences(node.expression, at);
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans)
      text += `\${${span.expression.getText()}}${span.literal.text}`;
    return [text];
  }
  if (ts.isConditionalExpression(node))
    return [
      ...renderSentences(node.whenTrue, at),
      ...renderSentences(node.whenFalse, at),
    ];
  if (ts.isBinaryExpression(node)) {
    // A `??` fallback spells the sentence the site states when the value it
    // prefers has none; the preferred side renders whatever it can.
    if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      return [
        ...renderSentences(node.left, at),
        ...renderSentences(node.right, at),
      ];
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = renderSentences(node.left, at);
      const right = renderSentences(node.right, at);
      return left.flatMap((head) => right.map((tail) => head + tail));
    }
  }
  // A named constant (`CURSOR_ORDER_REFUSAL`) is the sentence it is bound to,
  // and so is one this file imports (`DISTANCE_NAME_COLLISION`).
  if (ts.isIdentifier(node) && at) {
    const local = localBinding(at, node.text);
    const bound = local === undefined ? importedConstant(at, node.text) : local;
    return bound?.kind === "value"
      ? renderSentences(bound.expression, bound.node)
      : [];
  }
  return [];
};

/**
 * The message among a constructor's arguments. These error classes spell
 * `(kind, reason)` as often as `(message)`, and the census the map is written
 * against recorded the reason. A kind is one word; a sentence is a phrase.
 */
const messageArgument = (args, at) => {
  for (const argument of args) {
    const spelled = renderSentences(argument, at);
    if (spelled.some((text) => text.includes(" "))) return spelled;
  }
  for (const argument of args) {
    const spelled = renderSentences(argument, at);
    if (spelled.length) return spelled;
  }
  return [];
};

/** The local names this file bound to the invariant owner's exports. */
const INVARIANT_MODULE = /(^|\/)invariant(\.js|\.ts)?$/;
const invariantBindings = (sourceFile) => {
  const locals = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    if (!INVARIANT_MODULE.test(specifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!(bindings && ts.isNamedImports(bindings))) continue;
    for (const element of bindings.elements)
      locals.set(
        element.name.text,
        (element.propertyName ?? element.name).text
      );
  }
  return locals;
};

/**
 * The constructions a thrown expression can be — the `new` itself; a call to
 * a local factory, a function of this file or a method of the throw's own
 * class whose body returns constructions; a local `const` bound to one of
 * those; either arm of a conditional. A sentence the throw site reaches that
 * way is the site's own sentence, not a rethrow of another owner's value. A
 * property access (`this.incompletePreparation`, a control-flow sentinel no
 * caller sees), a parameter (`ctx.failure`) and a value assigned after its
 * declaration resolve to nothing and are listed as sentence-less.
 */
const constructionsOf = (expression, at, depth = 0) => {
  if (depth > 6 || !expression) return [];
  const e = ts.isParenthesizedExpression(expression)
    ? expression.expression
    : expression;
  if (ts.isNewExpression(e)) return [e];
  if (ts.isConditionalExpression(e))
    return [
      ...constructionsOf(e.whenTrue, at, depth + 1),
      ...constructionsOf(e.whenFalse, at, depth + 1),
    ];
  if (ts.isIdentifier(e)) {
    const bound = localBinding(at, e.text);
    return bound?.kind === "value"
      ? constructionsOf(bound.expression, bound.node, depth + 1)
      : [];
  }
  if (!ts.isCallExpression(e)) return [];
  const callee = e.expression;
  // The failure owner answers the value it is GIVEN ({@link FAILURE_OWNER}):
  // the sentence a throw through it states is the one the site handed over.
  // The zero-argument `failure()` of a premise or a continuation is a
  // different member and supplies no carried value, so it is not read here.
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === FAILURE_OWNER.method &&
    e.arguments.length > FAILURE_OWNER.carries
  )
    return constructionsOf(e.arguments[FAILURE_OWNER.carries], at, depth + 1);
  if (ts.isIdentifier(callee)) {
    const bound = localBinding(at, callee.text);
    if (bound?.kind === "function")
      return returnedConstructions(bound.body, bound.node, depth + 1);
    if (
      bound?.kind === "value" &&
      (ts.isArrowFunction(bound.expression) ||
        ts.isFunctionExpression(bound.expression))
    )
      return returnedConstructions(
        bound.expression.body,
        bound.node,
        depth + 1
      );
    return [];
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    const method = enclosingMethod(at, callee.name.text);
    return method?.body
      ? returnedConstructions(method.body, method, depth + 1)
      : [];
  }
  return [];
};

/** What a function body returns: an expression body, or its own `return`s. */
const returnedConstructions = (body, at, depth) => {
  if (!ts.isBlock(body)) return constructionsOf(body, at, depth);
  const found = [];
  const walk = (node) => {
    if (ts.isReturnStatement(node))
      found.push(...constructionsOf(node.expression, node, depth));
    else if (!(ts.isFunctionLike(node) || ts.isClassLike(node)))
      ts.forEachChild(node, walk);
  };
  ts.forEachChild(body, walk);
  return found;
};

/**
 * The nearest enclosing declaration of `name`: a `const`/`let` or a function.
 * `null` when a parameter, a catch clause or a declaration without a value
 * binds the name first; `undefined` when nothing in the file declares it.
 */
const localBinding = (at, name) => {
  for (let scope = at.parent; scope; scope = scope.parent) {
    // A parameter or a catch clause binds the name first: what it holds is
    // the caller's, not a sentence this file spells.
    if (
      (ts.isFunctionLike(scope) &&
        scope.parameters?.some(
          (parameter) =>
            ts.isIdentifier(parameter.name) && parameter.name.text === name
        )) ||
      (ts.isCatchClause(scope) &&
        scope.variableDeclaration &&
        ts.isIdentifier(scope.variableDeclaration.name) &&
        scope.variableDeclaration.name.text === name)
    )
      return null;
    if (!(ts.isBlock(scope) || ts.isSourceFile(scope))) continue;
    for (const statement of scope.statements) {
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === name &&
        statement.body
      )
        return { kind: "function", body: statement.body, node: statement };
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name)
          return declaration.initializer
            ? {
                kind: "value",
                expression: declaration.initializer,
                node: declaration,
              }
            : null;
    }
  }
  return undefined;
};

/** The censused tree's path aliases (`tsconfig.json` `paths`), read once. */
let pathAliases;
const aliasesOf = () => {
  if (pathAliases !== undefined) return pathAliases;
  pathAliases = [];
  try {
    const { config } = ts.parseConfigFileTextToJson(
      "tsconfig.json",
      readSource("tsconfig.json")
    );
    pathAliases = Object.entries(config?.compilerOptions?.paths ?? {});
  } catch {
    // A tree without a root `tsconfig.json` resolves relative imports only.
  }
  return pathAliases;
};

/** Repository-relative paths the censused revision tracks, listed once. */
let trackedAtRevision;
const sourceExists = (path) => {
  if (at === undefined) return existsSync(resolve(root, path));
  trackedAtRevision ??= new Set(
    git("ls-tree", "-r", "--name-only", at).split("\n")
  );
  return trackedAtRevision.has(path);
};

/** The module an import specifier names, as a repository-relative `.ts` path. */
const modulePath = (importer, specifier) => {
  const bases = [];
  if (specifier.startsWith(".")) {
    bases.push(posix.join(posix.dirname(importer), specifier));
  } else {
    for (const [pattern, targets] of aliasesOf()) {
      const target = targets?.[0];
      if (typeof target !== "string") continue;
      if (pattern.endsWith("/*") && target.endsWith("/*")) {
        const prefix = pattern.slice(0, -1);
        if (specifier.startsWith(prefix))
          bases.push(
            posix.join(target.slice(0, -1), specifier.slice(prefix.length))
          );
      } else if (pattern === specifier) bases.push(posix.normalize(target));
    }
  }
  for (const base of bases)
    for (const candidate of base.endsWith(".ts")
      ? [base]
      : [`${base}.ts`, `${base}/index.ts`])
      if (sourceExists(candidate)) return candidate;
  return undefined;
};

/** Parsed modules another module's import led to, by path. */
const importedModules = new Map();

/**
 * A constant this file imports, read where it is declared: the named import
 * that binds `name`, followed to the exporting module's top-level
 * `export const`. That is how a sentence one owner states for several files
 * stays read at every throw that spells it. Only a message is resolved this
 * way; a thrown value or a factory stays the site's own
 * ({@link constructionsOf}).
 */
const importedConstant = (at, name) => {
  const importer = at.getSourceFile();
  for (const statement of importer.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    const bindings = statement.importClause?.namedBindings;
    if (
      !(
        ts.isStringLiteral(specifier) &&
        bindings &&
        ts.isNamedImports(bindings)
      )
    )
      continue;
    const element = bindings.elements.find((entry) => entry.name.text === name);
    if (!element) continue;
    const path = modulePath(importer.fileName, specifier.text);
    if (path === undefined) return undefined;
    if (!importedModules.has(path))
      importedModules.set(
        path,
        ts.createSourceFile(
          path,
          readSource(path),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS
        )
      );
    const exported = (element.propertyName ?? element.name).text;
    for (const declared of importedModules.get(path).statements) {
      if (
        !(
          ts.isVariableStatement(declared) &&
          declared.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
          ) &&
          declared.declarationList.getFirstToken()?.kind ===
            ts.SyntaxKind.ConstKeyword
        )
      )
        continue;
      for (const declaration of declared.declarationList.declarations)
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === exported &&
          declaration.initializer
        )
          return {
            kind: "value",
            expression: declaration.initializer,
            node: declaration,
          };
    }
    return undefined;
  }
  return undefined;
};

/** The method `name` of the class the throw is in — a method, never an accessor. */
const enclosingMethod = (at, name) => {
  for (let scope = at.parent; scope; scope = scope.parent)
    if (ts.isClassLike(scope))
      return scope.members.find(
        (member) =>
          ts.isMethodDeclaration(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === name
      );
  return undefined;
};

/**
 * The declared failure owner as THIS tree spells it: the method, or the reason
 * the declaration no longer holds. The shape is what the census depends on —
 * a method of the declared class carrying the site's value at the declared
 * parameter — so each half is checked, not assumed.
 */
const locateFailureOwner = (sourceFile) => {
  const declared = sourceFile.statements.find(
    (statement) =>
      ts.isClassDeclaration(statement) &&
      statement.name?.text === FAILURE_OWNER.class
  );
  if (!declared)
    return {
      error: `\`${FAILURE_OWNER.file}\` declares no class \`${FAILURE_OWNER.class}\``,
    };
  const method = declared.members.find(
    (member) =>
      ts.isMethodDeclaration(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === FAILURE_OWNER.method
  );
  if (!method?.body)
    return {
      error: `\`${FAILURE_OWNER.class}\` declares no \`${FAILURE_OWNER.method}()\` method with a body`,
    };
  const carried = method.parameters[FAILURE_OWNER.carries];
  if (
    !(
      carried &&
      ts.isIdentifier(carried.name) &&
      carried.name.text === FAILURE_OWNER.parameter
    )
  )
    return {
      error: `\`${FAILURE_OWNER.class}.${FAILURE_OWNER.method}()\` no longer carries \`${FAILURE_OWNER.parameter}\` at parameter ${FAILURE_OWNER.carries}`,
    };
  return { method };
};

/**
 * The sentences the failure owner builds ITSELF, for a value it replaces —
 * the owner's own contracts, read at the owner and not at its callers.
 */
const ownerSubstitutions = (method) => {
  const found = [];
  const walk = (node) => {
    if (ts.isNewExpression(node)) found.push(node);
    else if (!(ts.isFunctionLike(node) || ts.isClassLike(node)))
      ts.forEachChild(node, walk);
  };
  ts.forEachChild(method.body, walk);
  return found;
};

/** What the run found where {@link FAILURE_OWNER} is declared. */
let failureOwner;

const collectSites = (path, text) => {
  const sourceFile = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const owner = path === INVARIANT_OWNER;
  const locals = invariantBindings(sourceFile);
  const sites = [];
  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1;
  const visit = (node) => {
    if (ts.isThrowStatement(node) && node.expression) {
      const thrown = node.expression;
      const origins = constructionsOf(thrown, node);
      const construction = origins.length > 0;
      const name = construction
        ? origins[0].expression.getText()
        : thrown.getText().split("(")[0];
      sites.push({
        file: path,
        line: lineOf(node),
        node,
        via: "throw",
        class: name,
        sentences: construction
          ? [
              ...new Set(
                origins.flatMap((origin) =>
                  messageArgument(origin.arguments ?? [], origin)
                )
              ),
            ]
          : renderSentences(thrown, node),
        invariant: owner || locals.has(name),
      });
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const imported = locals.get(node.expression.text);
      if (imported === "assertInvariant" || imported === "unreachable")
        sites.push({
          file: path,
          line: lineOf(node),
          node,
          via: imported,
          class: "EngineInvariantError",
          sentences: messageArgument(node.arguments.slice(1), node),
          invariant: true,
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (path === FAILURE_OWNER.file) {
    failureOwner = locateFailureOwner(sourceFile);
    if (failureOwner.method && FAILURE_OWNER.substitutes)
      for (const origin of ownerSubstitutions(failureOwner.method))
        sites.push({
          file: path,
          line: lineOf(origin),
          node: origin,
          via: `${FAILURE_OWNER.method}()`,
          class: origin.expression.getText(),
          sentences: messageArgument(origin.arguments ?? [], origin),
          invariant: false,
        });
  }
  return sites;
};

// ---------------------------------------------------------------------------
// The receipts' matching against the shipped engine's sentences.
// ---------------------------------------------------------------------------

const SENTINEL = String.fromCharCode(0);
const normalize = (text) =>
  text
    .replace(/\$\{[^}]*\}/g, SENTINEL)
    .replace(/[`"'+]/g, "")
    .replace(/\s+/g, " ");
const fragments = (sentence) =>
  normalize(sentence)
    .split(SENTINEL)
    .map((part) => part.trim())
    .filter((part) => part.length >= FRAGMENT_MIN);
const longestStatic = (sentence) => {
  const segments = sentence
    .split(/\$\{[^}]*\}/g)
    .map((part) => part.trim())
    .sort((a, b) => b.length - a.length);
  return segments[0] && segments[0].length >= FRAGMENT_MIN ? segments[0] : null;
};

let corpus = "";
let corpusError = null;
try {
  corpus = git(
    "grep",
    "-h",
    "",
    shippedRev,
    "--",
    "src/**/*.ts",
    `:!${ENGINE}/**`
  );
} catch (error) {
  corpusError = error instanceof Error ? error.message : String(error);
}
const normalizedCorpus = normalize(corpus);
const isRegistered = (sentence) => {
  if (corpus === "") return false;
  const needle = longestStatic(sentence);
  if (needle !== null && corpus.includes(needle)) return true;
  const parts = fragments(sentence);
  return (
    parts.length > 0 && parts.every((part) => normalizedCorpus.includes(part))
  );
};

// ---------------------------------------------------------------------------
// Classify.
// ---------------------------------------------------------------------------

const sites = [];
for (const path of listSources(ENGINE))
  sites.push(...collectSites(path, readSource(path)));
const failureOwnerError =
  failureOwner === undefined
    ? `\`${FAILURE_OWNER.file}\` is not in the censused tree`
    : (failureOwner.error ?? null);

for (const site of sites) {
  if (site.invariant) {
    site.outcome = "INVARIANT";
    continue;
  }
  site.outcome = "REFUSAL";
  site.public = site.sentences.filter((sentence) => !isRegistered(sentence));
}

const invariants = sites.filter((site) => site.outcome === "INVARIANT");
const refusals = sites.filter((site) => site.outcome === "REFUSAL");
const wordless = refusals.filter((site) => site.sentences.length === 0);
const registeredSites = refusals.filter(
  (site) => site.sentences.length > 0 && site.public.length === 0
);
const publicSites = refusals.filter((site) => site.public.length > 0);

/** One row per distinct sentence, carrying every site that spells it. */
const bySentence = (group, sentencesOf = (site) => site.sentences) => {
  const rows = new Map();
  for (const site of group)
    for (const sentence of sentencesOf(site)) {
      const row = rows.get(sentence);
      if (row) row.sites.push(site);
      else rows.set(sentence, { sentence, sites: [site] });
    }
  return [...rows.values()].sort((a, b) =>
    a.sentence.localeCompare(b.sentence)
  );
};
const publicSentences = bySentence(publicSites, (site) => site.public);
const registeredSentences = bySentence(registeredSites);
const invariantSentences = bySentence(invariants);

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

const head = at ?? git("rev-parse", "--short", "HEAD").trim();
const dirty =
  at === undefined
    ? git("status", "--porcelain", "--", ENGINE)
        .split("\n")
        .filter((line) => line.trim() !== "")
    : [];

const cell = (text) =>
  String(text).split("|").join("\\|").split("\n").join(" ");
const where = (site) =>
  `\`${site.file.slice(ENGINE.length + 1)}:${site.line}\``;
const sentenceRows = (rows, columns) =>
  rows.map(
    (row) =>
      `| ${row.sites.map(where).join("<br>")} | ${columns(row)} | ${cell(row.sentence)} |`
  );

const lines = [];
lines.push("# Raptor 3 refusal census");
lines.push("");
lines.push(
  `Produced by \`scripts/raptor3-refusal-census.mjs\` on \`${head}\`` +
    (dirty.length
      ? ` with ${dirty.length} uncommitted engine file(s)`
      : at === undefined
        ? " (clean engine tree)"
        : "") +
    `. Shipped-sentence corpus: \`${shippedRev}\`.`
);
lines.push("");
lines.push(
  "Two outcomes, told apart by construction. An **invariant** throws through" +
    " `shared/invariant.ts` and is not a refusal. A" +
    " **refusal** is everything else: *inherited* when the sentence is matched" +
    " in the old engine's own corpus at the revision named above, a" +
    " *candidate* sentence when it is not."
);
lines.push("");
lines.push(
  "**These are counts of SENTENCES, not of capabilities.** A candidate" +
    " sentence is one this engine spells and the old one did not; it is not an" +
    " unsupported operation family. The counts include the integrity failures" +
    " (a member that is gone, a captured row another writer replaced) and the" +
    " provider-result failures (a driver that answered a malformed value) that" +
    " a correct engine must state, and they include sentences no admitted" +
    " payload can reach. What this engine does and does not support is the" +
    " behavioural closure inventory's fact, one row per admitted fact:" +
    " `docs/architecture/raptor3-evidence/g4/release/closure/fc00/inventory.md`." +
    " Which admitted payload reaches a given sentence stays the per-row ruling" +
    " of `g4/release/plan/refusals-map.md`."
);
lines.push("");
if (corpusError !== null)
  lines.push(
    `> **The shipped corpus could not be read** (\`${cell(corpusError)}\`). Every` +
      " refusal below is reported as public; the registered/public split is not" +
      " available in this run.",
    ""
  );
if (failureOwnerError !== null)
  lines.push(
    `> **The declared failure owner is not where this census reads it** (${failureOwnerError}).` +
      " A sentence a site builds and throws through it is read there and" +
      " nowhere else, so this run exits non-zero instead of reporting those" +
      " sites as sentence-less.",
    ""
  );

lines.push("## Counts");
lines.push("");
lines.push("| outcome | sites | distinct sentences |");
lines.push("| --- | --- | --- |");
lines.push(
  `| invariant | ${invariants.length} | ${invariantSentences.length} |`
);
lines.push(
  `| refusal — inherited (matched in the old-engine corpus) | ${registeredSites.length} | ${registeredSentences.length} |`
);
lines.push(
  `| refusal — candidate (unmatched) | ${publicSites.length} | ${publicSentences.length} |`
);
lines.push(`| no sentence (rethrow) | ${wordless.length} | — |`);
lines.push(`| **total sites** | **${sites.length}** | |`);
lines.push("");
const delta = publicSentences.length - MAP_SENTENCES;
lines.push(
  "**Candidate sentences unmatched in the old-engine corpus:" +
    ` ${publicSentences.length} distinct sentences** at ${publicSites.length}` +
    ` sites, against the **${MAP_SENTENCES}** the map started from` +
    ` (${delta >= 0 ? "+" : ""}${delta}). Earlier notes call this number` +
    ` "${publicSentences.length} public refusals": it is the same count, of` +
    " sentences, and it is not a count of unavailable operations."
);
lines.push("");

/** A heading, its prose, and a table — or the sentence that there is none. */
const section = (heading, prose, columns, rows) => {
  lines.push(heading, "", prose, "");
  if (rows.length === 0) {
    lines.push("_None._", "");
    return;
  }
  lines.push(
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`
  );
  lines.push(rows.join("\n"));
  lines.push("");
};

section(
  "## Candidate sentences unmatched in the old-engine corpus",
  "A sentence this engine spells that is not matched in the old engine's" +
    " corpus. Nothing in the tree forecloses it; which admitted payload" +
    " reaches each one is the map's per-row ruling" +
    " (`g4/release/plan/refusals-map.md`), which this census does not" +
    " re-derive. Integrity and provider-result sentences are counted here like" +
    " any other: a row in this table is a sentence, never an operation the" +
    " engine cannot perform.",
  ["sites", "class", "sentence"],
  sentenceRows(publicSentences, (row) => `\`${cell(row.sites[0].class)}\``)
);

section(
  "## Inherited sentences",
  `Sentences matched in the old engine's own corpus at \`${shippedRev}\` by the` +
    " receipts' matching (the longest static fragment, or every fragment of" +
    ` ${FRAGMENT_MIN} characters or more): inherited contracts, reported apart` +
    " because they were never the census's question.",
  ["sites", "class", "sentence"],
  sentenceRows(registeredSentences, (row) => `\`${cell(row.sites[0].class)}\``)
);

section(
  "## Invariants",
  "States the code cannot be in when it is right, thrown through the engine's" +
    " one invariant owner. Not refusals, and counted as none.",
  ["sites", "through", "sentence"],
  sentenceRows(invariantSentences, (row) => `\`${row.sites[0].via}\``)
);

section(
  "## Sites without a sentence",
  "Refusal sites whose sentence this census cannot read: a rethrow of a value" +
    " another owner built (a catch binding, a parameter), a property access" +
    " (`this.incompletePreparation`, a control-flow sentinel no caller sees)," +
    " a property of another object (`refusal.error`), a value assigned after" +
    " its declaration, or a message computed at the site (one built from" +
    " mapped issues). A sentence built by a local factory, a function of the" +
    " file, a method of the throw's own class, a local `const` bound to one of" +
    " those, or a named constant IS read at the throw site — including when" +
    " the site hands it to the failure owner" +
    ` (\`${FAILURE_OWNER.method}(…)\`), whose own substituted sentences are` +
    " read once at the owner itself. Listed so" +
    " no refusal site is silently dropped from the total; an invariant site" +
    " whose message is not a literal (the owner's own throw) is counted among" +
    " the invariant sites and has no row.",
  ["site", "thrown"],
  wordless.map((site) => `| ${where(site)} | \`${cell(site.class)}\` |`)
);

const report = `${lines
  .join("\n")
  .replace(/\n{3,}/g, "\n\n")
  .trimEnd()}\n`;
if (outPath === undefined) process.stdout.write(report);
else {
  writeFileSync(resolve(root, outPath), report);
  process.stdout.write(
    `${outPath}: ${publicSentences.length} unmatched candidate sentences ` +
      `(${MAP_SENTENCES} at the map), ${registeredSentences.length} inherited, ` +
      `${invariantSentences.length} invariant, ${sites.length} sites\n`
  );
}
// A census that could not read the corpus, or whose declared failure owner has
// moved, is not the census this report claims to be. Each failure is stated in
// the report and answered here, so a pipeline sees it too.
if (corpusError !== null || failureOwnerError !== null) process.exitCode = 1;
