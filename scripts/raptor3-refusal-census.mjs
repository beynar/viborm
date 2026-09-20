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
 * This census makes the three distinctions that one lacked, and it makes each
 * of them BY CONSTRUCTION, never by reading a message:
 *
 *   INVARIANT  the site throws through the engine's invariant owner
 *              (`shared/invariant.ts`: `assertInvariant`, `unreachable`,
 *              `EngineInvariantError`). An invariant names a state the code
 *              cannot be in when it is right; it is not a refusal, and it is
 *              told from one by CLASS. The owner is import-resolved, so a
 *              same-named local helper elsewhere is not mistaken for it.
 *   INTERNAL   the site lies inside a declared private fit — a mechanism no
 *              admitted public payload reaches. Each fit carries the evidence
 *              for its own privacy and the census CHECKS it: if any file
 *              outside the fit's owner names one of its entry symbols, the fit
 *              is contradicted, its sites go back to being refusals, and the
 *              run exits non-zero. A declaration that the tree stopped
 *              supporting fails loudly instead of exempting sites silently.
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
 * Reachability is what this census can establish and no more. An invariant and
 * a verified private fit are foreclosures the tree proves. For a public refusal
 * it says only that nothing forecloses it; which admitted payload reaches that
 * one is the map's per-row ruling, and stays there.
 *
 * Read-only, no network. `--at <rev>` censuses a revision instead of the
 * working tree, which is how a run is compared against its own base. The run
 * exits non-zero when the census could not be produced as described — the
 * corpus unreadable, or a declared private fit the tree contradicts.
 *
 *   node scripts/raptor3-refusal-census.mjs [--out <file>] [--at <rev>] [--shipped-rev <rev>]
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
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
 * The mechanisms no admitted public payload reaches. One entry, D-54's: the
 * recursive read is built, unit-tested and wired to no public verb, so its
 * sentences are internal until a public argument reaches them. `evidence` is
 * what makes that a checked claim rather than an exemption list — the entry
 * symbols that a public caller would have to name, and the only file allowed
 * to name them.
 */
const PRIVATE_FITS = [
  {
    id: "recursive-read",
    decision: "D-54",
    title: "the private recursive-read fit",
    why: "`Queries.recursive`, `decodeRecursive` and the route's recursive cache codec are built and tested, and no public verb, argument or schema option builds a recursive traversal or asks for a `recursive` published shape.",
    files: [`${ENGINE}/shared/query.ts`, `${ENGINE}/route/client-route.ts`],
    declarations: ["recursive", "decodeRecursive"],
    discriminant: "recursive",
    evidence: {
      needles: [".recursive(", 'kind: "recursive"'],
      owners: [`${ENGINE}/shared/query.ts`],
    },
  },
];

const OPTIONS = ["--out", "--shipped-rev", "--at"];
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
  // A named constant (`CURSOR_ORDER_REFUSAL`) is the sentence it is bound to.
  if (ts.isIdentifier(node) && at) {
    const bound = localBinding(at, node.text);
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

const declarationName = (node) => {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isVariableDeclaration(node)) &&
    node.name
  )
    return node.name.getText();
  return null;
};

const selectsDiscriminant = (expression, discriminant) =>
  ts.isBinaryExpression(expression) &&
  expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
  [expression.left, expression.right].some(
    (side) => ts.isStringLiteralLike(side) && side.text === discriminant
  );

/** The fit anchor that covers this site, or null: a declaration, a case clause, a guard. */
const fitAnchor = (node, file, fit) => {
  if (!fit.files.includes(file)) return null;
  let child = node;
  for (
    let current = node.parent;
    current;
    child = current, current = current.parent
  ) {
    const name = declarationName(current);
    if (name !== null && fit.declarations.includes(name))
      return `inside \`${name}\``;
    if (
      ts.isCaseClause(current) &&
      ts.isStringLiteralLike(current.expression) &&
      current.expression.text === fit.discriminant
    )
      return `under \`case "${fit.discriminant}"\``;
    if (
      ts.isIfStatement(current) &&
      child === current.thenStatement &&
      selectsDiscriminant(current.expression, fit.discriminant)
    )
      return `under \`=== "${fit.discriminant}"\``;
  }
  return null;
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

/** The nearest enclosing declaration of `name`: a `const`/`let` or a function. */
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
  return null;
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
// The private fits, checked before they are used.
// ---------------------------------------------------------------------------

const sourcePaths = listSources("src");
const checkFit = (fit) => {
  const contradictions = [];
  for (const path of sourcePaths) {
    if (fit.evidence.owners.includes(path)) continue;
    const text = readSource(path);
    for (const needle of fit.evidence.needles)
      if (text.includes(needle)) contradictions.push({ path, needle });
  }
  return contradictions;
};
const fits = PRIVATE_FITS.map((fit) => ({
  ...fit,
  contradictions: checkFit(fit),
}));

// ---------------------------------------------------------------------------
// Classify.
// ---------------------------------------------------------------------------

const sites = [];
for (const path of listSources(ENGINE))
  sites.push(...collectSites(path, readSource(path)));

for (const site of sites) {
  if (site.invariant) {
    site.outcome = "INVARIANT";
    site.reach = "foreclosed — the engine's invariant owner";
    continue;
  }
  const fit = fits.find(
    (candidate) =>
      candidate.contradictions.length === 0 &&
      fitAnchor(site.node, site.file, candidate) !== null
  );
  if (fit) {
    site.outcome = "INTERNAL";
    site.fit = fit;
    site.anchor = fitAnchor(site.node, site.file, fit);
    site.reach = `foreclosed — ${fit.title} (${fit.decision}), ${site.anchor}`;
    continue;
  }
  site.outcome = "REFUSAL";
  site.public = site.sentences.filter((sentence) => !isRegistered(sentence));
  site.reach =
    site.sentences.length === 0
      ? "no sentence — a rethrow, or a message built where this census cannot read it"
      : site.public.length === 0
        ? "public — the shipped engine registers this sentence"
        : "public — nothing in the tree forecloses it";
}

const invariants = sites.filter((site) => site.outcome === "INVARIANT");
const internals = sites.filter((site) => site.outcome === "INTERNAL");
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
const internalSentences = bySentence(internals);
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
  "Three outcomes, told apart by construction. An **invariant** throws through" +
    " `shared/invariant.ts` and is not a refusal. An **internal** sentence lies" +
    " inside a declared private fit whose privacy this run re-checked. A" +
    " **refusal** is everything else: *registered* when the shipped engine" +
    " already carries the same sentence, *public* when it does not."
);
lines.push("");
if (corpusError !== null)
  lines.push(
    `> **The shipped corpus could not be read** (\`${cell(corpusError)}\`). Every` +
      " refusal below is reported as public; the registered/public split is not" +
      " available in this run.",
    ""
  );
for (const fit of fits)
  if (fit.contradictions.length)
    lines.push(
      `> **The private fit \`${fit.id}\` (${fit.decision}) is contradicted.** ` +
        fit.contradictions
          .map((hit) => `\`${hit.path}\` names \`${cell(hit.needle)}\``)
          .join("; ") +
        ". Its sites are counted as refusals and this run exits non-zero.",
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
  `| internal (private fits) | ${internals.length} | ${internalSentences.length} |`
);
lines.push(
  `| refusal — registered | ${registeredSites.length} | ${registeredSentences.length} |`
);
lines.push(
  `| refusal — public | ${publicSites.length} | ${publicSentences.length} |`
);
lines.push(`| no sentence (rethrow) | ${wordless.length} | — |`);
lines.push(`| **total sites** | **${sites.length}** | |`);
lines.push("");
const delta = publicSentences.length - MAP_SENTENCES;
lines.push(
  `**Public refusals: ${publicSentences.length} distinct sentences** at` +
    ` ${publicSites.length} sites, against the **${MAP_SENTENCES}** the map` +
    ` started from (${delta >= 0 ? "+" : ""}${delta}).`
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
  "## Public refusals",
  "A sentence the candidate spells that the shipped engine does not. Nothing in" +
    " the tree forecloses it; which admitted payload reaches each one is the" +
    " map's per-row ruling (`g4/release/plan/refusals-map.md`), which this" +
    " census does not re-derive.",
  ["sites", "class", "sentence"],
  sentenceRows(publicSentences, (row) => `\`${cell(row.sites[0].class)}\``)
);

section(
  "## Registered refusals",
  `Sentences the shipped engine already carries at \`${shippedRev}\`: inherited` +
    " contracts, reported apart because they were never the census's question.",
  ["sites", "class", "sentence"],
  sentenceRows(registeredSentences, (row) => `\`${cell(row.sites[0].class)}\``)
);

lines.push("## Internal — the private fits", "");
for (const fit of fits)
  section(
    `### \`${fit.id}\` (${fit.decision}) — ${fit.title}`,
    `${fit.why}\n\nPrivacy re-checked this run: ${fit.evidence.needles
      .map((needle) => `\`${cell(needle)}\``)
      .join(", ")} named anywhere in \`src/**\` outside ${fit.evidence.owners
      .map((owner) => `\`${owner}\``)
      .join(", ")} — ` +
      (fit.contradictions.length
        ? `**${fit.contradictions.length} hit(s); the fit is contradicted**.`
        : "no hits; the fit holds."),
    ["sites", "class", "anchor", "sentence"],
    sentenceRows(
      bySentence(internals.filter((site) => site.fit === fit)),
      (row) => `\`${cell(row.sites[0].class)}\` | ${cell(row.sites[0].anchor)}`
    )
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
  "Refusal sites whose sentence this census cannot read: a rethrow of a" +
    " value another owner built (`ctx.failure`, `error`), a property access" +
    " (`this.incompletePreparation`, a control-flow sentinel no caller sees)," +
    " a value assigned after its declaration, or a message computed at the" +
    " site (one built from mapped issues). A sentence built by a local" +
    " factory, a function of the file, a method of the throw's own class, a" +
    " local `const` bound to one of those, or a named constant IS read at the" +
    " throw site. Listed so" +
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
    `${outPath}: ${publicSentences.length} public refusal sentences ` +
      `(${MAP_SENTENCES} at the map), ${internalSentences.length} internal, ` +
      `${invariantSentences.length} invariant, ${registeredSentences.length} registered, ` +
      `${sites.length} sites\n`
  );
}
// A census that could not read the corpus, or whose declared private fit the
// tree contradicts, is not the census this report claims to be. Each failure
// is stated in the report and answered here, so a pipeline sees it too.
if (corpusError !== null || fits.some((fit) => fit.contradictions.length))
  process.exitCode = 1;
