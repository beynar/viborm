#!/usr/bin/env node
/**
 * The extension codemod: rewrites extension definitions written in the
 * contract of 1.14 into the contract of the extension rewrite
 * (`extension-contract-spec.md`, section 8: "old member → new part", as
 * corrected by section 11, version 1: six primitives, `order` and `data`
 * written with `defaults`, `statement(u)` for a statement unit).
 *
 *   defineExtension({ name: "audit", controls: {…}, rows: {…}, data: {…} })
 *   → extension("audit", args({…}), rule({…}), defaults({…}))
 *
 * It finds a definition wherever one is written: an object literal passed to
 * `$extends`, to `defineExtension(…)`, `defineExtension<S>()(…)`, a binder
 * `const define = defineExtension<S>()`, or `defineHooks(…)`; a literal held
 * by a `const` (or a property of a `const` object literal) that one of those
 * receives; a literal returned by a local function whose result one of those
 * receives. `as const`, `satisfies …` and casts to an extension type around it
 * are dropped. It also folds the two-step application of an official
 * extension (`.$extends(x.rows)…$extends(x.methods)`) into one
 * `$extends(x)` (owner rule D11), writes `defaultOmit<S>()(config)` as
 * `defaultOmit(config)`, and deletes `enableExtensions()`.
 *
 * Every definition is converted whole, or left untouched and reported with
 * its member and the reason: the codemod never guesses. A conversion whose
 * meaning a person must check is made and flagged twice: in the report, and
 * by a `// FIXME(extension-codemod): …` line before the part.
 *
 * The spelling of the output lives in `./extension-codemod-print.mjs` and
 * only there: a change decided by the type spike is a change of that module.
 * This file reads the old code and decides WHAT to print, never how.
 *
 * Usage:
 *   node scripts/extension-codemod.mjs [--dry | --write] [--report file.md]
 *     [--out dir] [--examples path:line,…] [--no-format] [paths or globs…]
 *
 *   --dry       (default) convert in memory and report
 *   --write     write converted files, then `biome format --write` them
 *   --report    write the markdown report there (stdout otherwise)
 *   --out       also write each converted file (and each converted fenced
 *               block of a .md/.mdx file) under this folder and format the
 *               copies, to check they parse and format
 *   --examples  show these definitions before and after in the report
 *   paths       files, folders or globs; default `tests docs`
 *
 * Files read: .ts, .mts, .tsx, and the fenced `ts`/`typescript`/`tsx` blocks
 * of .md and .mdx files (a block that does not parse is skipped and counted).
 */

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  globSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  PARAMETERS,
  printers,
  printKey,
  printObject,
  printString,
  WORDS,
} from "./extension-codemod-print.mjs";

const S = ts.SyntaxKind;

const TSX = /\.tsx$/;
const NAMES_AN_EXTENSION = /Extension/;
const OPENING_BRACE = /^\{/;
const FIRST_LETTER = /^./;
const TRAILING_COMMA = /,\s*$/;
const ENABLE_CALL = /enableExtensions\(\)/;
const BIOME_ERROR = /error|×|answer/;

// =============================================================================
// PARSING
// =============================================================================

const COMPILER_OPTIONS = {
  noLib: true,
  noResolve: true,
  types: [],
  target: ts.ScriptTarget.Latest,
  jsx: ts.JsxEmit.Preserve,
  allowJs: true,
};

/**
 * One file parsed, with a checker that resolves its local bindings (no
 * library, no import is read: only what the file itself declares).
 */
export function parse(text, fileName = "file.ts") {
  const name = `/virtual/${fileName.replace(/[^\w.-]/g, "_")}`;
  const kind = TSX.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind
  );
  const host = {
    getSourceFile: (requested) => (requested === name ? sf : undefined),
    getDefaultLibFileName: () => "/virtual/lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/virtual",
    getCanonicalFileName: (file) => file,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (requested) => requested === name,
    readFile: () => undefined,
  };
  const program = ts.createProgram({
    rootNames: [name],
    options: COMPILER_OPTIONS,
    host,
  });
  return {
    sf,
    checker: program.getTypeChecker(),
    syntaxErrors: program.getSyntacticDiagnostics(sf),
  };
}

/** A definition the codemod does not convert: the member and why. */
class Untouched extends Error {
  constructor(member, reason) {
    super(reason);
    this.member = member;
    this.reason = reason;
  }
}
const refuse = (member, reason) => {
  throw new Untouched(member, reason);
};

/** `node`'s text with each node `rewrite` answers for replaced, trivia kept. */
function render(sf, node, rewrite) {
  const replaced = rewrite?.(node);
  if (replaced !== undefined) return replaced;
  let text = "";
  let cursor = node.getStart(sf);
  for (const child of node.getChildren(sf)) {
    // JSDoc children end before the node starts; empty lists have no text.
    if (child.getEnd() <= cursor || child.kind === S.EndOfFileToken) continue;
    const start = child.getStart(sf);
    if (start >= child.getEnd()) continue;
    text += sf.text.slice(cursor, start) + render(sf, child, rewrite);
    cursor = child.getEnd();
  }
  return text + sf.text.slice(cursor, node.getEnd());
}

/** Visit every node under `root` (not `root`), skipping what `skip` refuses. */
function walk(root, visit, skip) {
  const go = (node) => {
    visit(node);
    if (!skip?.(node)) ts.forEachChild(node, go);
  };
  ts.forEachChild(root, go);
}

const isFunctionNode = (node) =>
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isClassLike(node);

/** The return statements of `fn` itself, not of a function nested in it. */
function ownReturns(fn) {
  const found = [];
  if (!(fn.body && ts.isBlock(fn.body))) return found;
  walk(
    fn.body,
    (node) => {
      if (ts.isReturnStatement(node)) found.push(node);
    },
    isFunctionNode
  );
  return found;
}

/** Whether `fn` (not an arrow) reads `this`, `super` or `arguments`. */
function readsReceiver(fn) {
  if (ts.isArrowFunction(fn) || !fn.body) return false;
  let reads = false;
  walk(
    fn.body,
    (node) => {
      if (
        node.kind === S.ThisKeyword ||
        node.kind === S.SuperKeyword ||
        (ts.isIdentifier(node) && node.text === "arguments")
      )
        reads = true;
    },
    (node) => isFunctionNode(node) && !ts.isArrowFunction(node)
  );
  return reads;
}

const isAsync = (fn) =>
  fn.modifiers?.some((modifier) => modifier.kind === S.AsyncKeyword) === true;

/** A property name's text, `undefined` for a computed one. */
function nameOf(name) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

const isStringLike = (node) =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

function skipParens(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

const isConstAssertion = (node) =>
  ts.isAsExpression(node) &&
  ts.isTypeReferenceNode(node.type) &&
  ts.isIdentifier(node.type.typeName) &&
  node.type.typeName.text === "const";

/**
 * The expression inside the wrappers a definition sheds (parentheses,
 * `as const`, `satisfies …`, a cast to an extension type), and the node the
 * conversion replaces: the outermost of those, or the inside of a cast it
 * keeps (`as any`).
 */
function unwrap(node) {
  let inner = node;
  let replace = node;
  for (;;) {
    if (ts.isParenthesizedExpression(inner) || ts.isSatisfiesExpression(inner))
      inner = inner.expression;
    else if (
      ts.isAsExpression(inner) &&
      (isConstAssertion(inner) || NAMES_AN_EXTENSION.test(inner.type.getText()))
    )
      inner = inner.expression;
    else if (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) {
      inner = inner.expression;
      replace = inner;
    } else return { inner, replace };
  }
}

/** Every identifier text that names a binding or a reference in `root`. */
function identifierNames(root) {
  const names = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const { parent } = node;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isGetAccessor(parent) ||
          ts.isSetAccessor(parent)) &&
          parent.name === node) ||
        (ts.isBindingElement(parent) && parent.propertyName === node);
      if (!isPropertyName) names.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return names;
}

// =============================================================================
// FINDING DEFINITIONS
// =============================================================================

const DEFINERS = new Set(["defineExtension", "defineHooks"]);

/** Whether a variable is declared `const`. */
function isConst(declaration) {
  // biome-ignore lint/suspicious/noBitwiseOperators: TypeScript's node flags are a bit set.
  return (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
}

/** The local `const` declaration an identifier names, if any. */
function constDeclaration(checker, identifier) {
  const symbol = checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    isConst(declaration) &&
    ts.isIdentifier(declaration.name)
  )
    return declaration;
  return undefined;
}

/** A property's value node: a shorthand `{ rows }` is the `const` it names, when it names one. */
function valueNodeOf(checker, property) {
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (ts.isShorthandPropertyAssignment(property)) {
    const symbol = checker.getShorthandAssignmentValueSymbol(property);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      isConst(declaration)
    )
      return declaration.initializer;
    return property.name;
  }
  return undefined;
}

/**
 * The expression a value is written as in this file: through a local
 * `const`, or a property of a `const` object literal. Data a definition
 * shares this way (`softRows`, `modes`) is read where it is written.
 */
function literalOf(checker, node, depth = 0) {
  const { inner } = unwrap(node);
  if (depth > 6) return inner;
  if (ts.isIdentifier(inner)) {
    const declaration = constDeclaration(checker, inner);
    return declaration
      ? literalOf(checker, declaration.initializer, depth + 1)
      : inner;
  }
  if (ts.isPropertyAccessExpression(inner)) {
    const holder = literalOf(checker, inner.expression, depth + 1);
    if (ts.isObjectLiteralExpression(holder)) {
      const property = holder.properties.find(
        (p) => nameOf(p.name) === inner.name.text
      );
      const value = property && valueNodeOf(checker, property);
      if (value) return literalOf(checker, value, depth + 1);
    }
  }
  return inner;
}

/** The local function an identifier names: its returned expressions. */
function localFunctionReturns(checker, identifier) {
  const symbol = checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  let fn;
  if (declaration && ts.isFunctionDeclaration(declaration)) fn = declaration;
  else if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer
  ) {
    const init = skipParens(declaration.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) fn = init;
  }
  if (!fn?.body) return undefined;
  if (!ts.isBlock(fn.body)) return [fn.body];
  return ownReturns(fn).map((statement) => statement.expression);
}

/**
 * The definitions a file writes. Each site: the literal, the node its
 * conversion replaces, the schema type a `defineExtension<S>()` named, and
 * the edits that go with it (a `defineExtension(x)` around a held literal
 * becomes `x`; a variable's extension type annotation goes).
 */
function findSites(sf, checker) {
  const sites = new Map();
  const unresolved = [];
  const binders = new Map();
  const lineOf = (node) =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  walk(sf, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.name) &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "defineExtension" &&
      node.initializer.arguments.length === 0
    )
      binders.set(checker.getSymbolAtLocation(node.name), {
        schemaType: node.initializer.typeArguments?.[0]?.getText(sf),
      });
  });

  const add = (literal, replace, origin, schemaType, edits = []) => {
    if (sites.has(literal)) return;
    sites.set(literal, { literal, replace, origin, schemaType, edits });
  };

  /** Follow `expr` to the literals it is built from. */
  const follow = (expr, origin, schemaType, depth, edits) => {
    const { inner, replace } = unwrap(expr);
    if (depth > 4) return;
    if (ts.isObjectLiteralExpression(inner)) {
      add(inner, replace, origin, schemaType, edits);
      return;
    }
    if (ts.isIdentifier(inner)) {
      const declaration = constDeclaration(checker, inner);
      if (!declaration) {
        unresolved.push({
          line: lineOf(inner),
          text: inner.text,
          why: "not a local const",
        });
        return;
      }
      const typeEdits =
        declaration.type &&
        NAMES_AN_EXTENSION.test(declaration.type.getText(sf))
          ? [
              {
                start: declaration.name.getEnd(),
                end: declaration.type.getEnd(),
                text: "",
              },
            ]
          : [];
      follow(
        declaration.initializer,
        `${origin} via const ${inner.text}`,
        schemaType,
        depth + 1,
        [...edits, ...typeEdits]
      );
      return;
    }
    if (
      ts.isPropertyAccessExpression(inner) &&
      ts.isIdentifier(inner.expression)
    ) {
      const declaration = constDeclaration(checker, inner.expression);
      const holder = declaration && unwrap(declaration.initializer).inner;
      const property =
        holder &&
        ts.isObjectLiteralExpression(holder) &&
        holder.properties.find(
          (p) =>
            ts.isPropertyAssignment(p) && nameOf(p.name) === inner.name.text
        );
      if (property) {
        follow(
          property.initializer,
          `${origin} via ${inner.getText(sf)}`,
          schemaType,
          depth + 1,
          edits
        );
        return;
      }
      unresolved.push({
        line: lineOf(inner),
        text: inner.getText(sf),
        why: "property of a value the file does not write",
      });
      return;
    }
    if (ts.isConditionalExpression(inner)) {
      follow(inner.whenTrue, origin, schemaType, depth + 1, edits);
      follow(inner.whenFalse, origin, schemaType, depth + 1, edits);
      return;
    }
    if (ts.isCallExpression(inner)) {
      const callee = inner.expression;
      // Its own site, found where it is written.
      if (
        (ts.isIdentifier(callee) &&
          (DEFINERS.has(callee.text) ||
            binders.has(checker.getSymbolAtLocation(callee)))) ||
        (ts.isCallExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "defineExtension")
      )
        return;
      if (ts.isIdentifier(callee)) {
        const returns = localFunctionReturns(checker, callee);
        if (returns) {
          for (const returned of returns)
            if (returned)
              follow(
                returned,
                `${origin} via ${callee.text}()`,
                schemaType,
                depth + 1,
                edits
              );
          return;
        }
      }
      unresolved.push({
        line: lineOf(inner),
        // The callee's name, without its type arguments.
        text: callee.getText(sf).split("<")[0].slice(0, 40),
        why: "call",
      });
      return;
    }
    unresolved.push({
      line: lineOf(inner),
      text: S[inner.kind],
      why: "expression",
    });
  };

  walk(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const [first] = node.arguments;
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "$extends"
    ) {
      if (first) follow(first, "$extends", undefined, 0, []);
      return;
    }
    let schemaType;
    let origin;
    if (ts.isIdentifier(callee) && DEFINERS.has(callee.text) && first)
      origin = callee.text;
    else if (
      ts.isCallExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "defineExtension" &&
      callee.arguments.length === 0 &&
      first
    ) {
      origin = "defineExtension<S>()";
      schemaType = callee.typeArguments?.[0]?.getText(sf);
    } else if (ts.isIdentifier(callee) && first) {
      const binder = binders.get(checker.getSymbolAtLocation(callee));
      if (binder) {
        origin = `binder ${callee.text}`;
        schemaType = binder.schemaType;
      }
    }
    if (!origin) return;
    const { inner } = unwrap(first);
    if (ts.isObjectLiteralExpression(inner))
      add(inner, node, origin, schemaType);
    // `defineExtension(x)`: `x` is converted where it is written, the call
    // around it becomes `x`.
    else
      follow(first, origin, schemaType, 0, [
        { start: node.getStart(sf), end: first.getStart(sf), text: "" },
        { start: first.getEnd(), end: node.getEnd(), text: "" },
      ]);
  });

  return { sites: [...sites.values()], unresolved };
}

// =============================================================================
// THE CONTEXT OF ONE CONVERSION
// =============================================================================

/** The words a file imports, aliased where the file already uses a name. */
const PLACEHOLDER = /__word_(\w+)__/g;

/**
 * The words a file uses. A printer gets a placeholder; each word's local
 * name is chosen once the file is converted (`resolve`), from the names the
 * converted text still uses: a handler parameter named `statement` that the
 * conversion removed does not make the word `statement` an alias.
 */
function wordTable() {
  const local = new Map();
  const used = new Set();
  const w = (word) => {
    used.add(word);
    return `__word_${word}__`;
  };
  /** Pick each word's name and write it in place of its placeholders. */
  const resolve = (text, fileName, specifier) => {
    const { sf } = parse(text, fileName);
    const taken = identifierNames(sf);
    // A word the file already imports from the same module under its own
    // name is that import, not a clash.
    const own = new Set();
    for (const statement of sf.statements)
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === specifier &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
      )
        for (const element of statement.importClause.namedBindings.elements)
          if (!element.propertyName) own.add(element.name.text);
    for (const word of used) {
      if (local.has(word)) continue;
      let name = word;
      if (taken.has(name) && !own.has(name)) {
        const base = `ext${word[0].toUpperCase()}${word.slice(1)}`;
        name = base;
        for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
      }
      taken.add(name);
      local.set(word, name);
    }
    return text.replace(PLACEHOLDER, (_, word) => local.get(word));
  };
  return { w, local, used, resolve };
}

/** Names fresh for a handler: none of them appears in `node`. */
function freshNames(node, extra = []) {
  const taken = new Set([...identifierNames(node), ...extra]);
  const fresh = (base) => {
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
    taken.add(name);
    return name;
  };
  return fresh;
}

// =============================================================================
// HANDLERS: rewriting a function's context into the new parameters
// =============================================================================

/** The function a member holds, or why it is not one the codemod reads. */
function functionOf(ctx, member, property) {
  if (ts.isMethodDeclaration(property)) return { fn: property };
  const value = valueNodeOf(ctx.checker, property);
  if (!value) refuse(member, "an accessor");
  const inner = literalOf(ctx.checker, value);
  if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner))
    return { fn: inner };
  return { held: unwrap(value).inner };
}

/** Every reference to `symbol` under `root`: identifiers and shorthand properties. */
function referencesTo(checker, root, symbol) {
  const found = [];
  // The root is read too: a concise body may be the reference itself.
  const visitAll = (node, visit) => {
    visit(node);
    walk(node, visit);
  };
  visitAll(root, (node) => {
    if (ts.isShorthandPropertyAssignment(node)) {
      if (checker.getShorthandAssignmentValueSymbol(node) === symbol)
        found.push(node);
      return;
    }
    if (
      ts.isIdentifier(node) &&
      !(
        ts.isShorthandPropertyAssignment(node.parent) &&
        node.parent.name === node
      ) &&
      checker.getSymbolAtLocation(node) === symbol
    )
      found.push(node);
  });
  return found;
}

function isWritten(reference) {
  const { parent } = reference;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === reference &&
    parent.operatorToken.kind >= S.FirstAssignment &&
    parent.operatorToken.kind <= S.LastAssignment
  )
    return true;
  return (
    (ts.isPrefixUnaryExpression(parent) ||
      ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === S.PlusPlusToken ||
      parent.operator === S.MinusMinusToken)
  );
}

/**
 * The context object's members as the new parameters print them, for a
 * handler that receives the context whole: `{ proceed: run, input: run.input }`.
 */
function contextObject(props, names) {
  return printObject(
    names.map((name) => [name, props[name].text()]).filter(([, text]) => text)
  );
}

/**
 * Bind a handler's context parameter to the new parameters. `props` maps
 * each old member to `{ text: () => printed, moment, special? }`. Answers the
 * substitutions in the body, the statements to put first (when the context
 * cannot be rewritten in place), and the calls of a special member.
 */
function bindContext(ctx, member, fn, parameter, props) {
  const substitutions = new Map();
  const prelude = [];
  const specialCalls = [];
  const proceedReferences = new Set();
  const flags = [];
  if (!parameter)
    return { substitutions, prelude, specialCalls, proceedReferences, flags };
  const { checker, sf } = ctx;
  const known = Object.keys(props);
  const body = fn.body;
  const fallback = (bindingText, names) => {
    for (const name of names)
      if (props[name].special)
        flags.push(
          `the context is read whole here: \`${name}\` has no first-moment spelling inside it`
        );
    prelude.push(`const ${bindingText} = ${contextObject(props, names)};`);
    return {
      substitutions: new Map(),
      prelude,
      specialCalls: [],
      proceedReferences,
      flags,
    };
  };

  if (ts.isIdentifier(parameter.name)) {
    const symbol = checker.getSymbolAtLocation(parameter.name);
    const references = referencesTo(checker, body, symbol);
    const safe = references.every((reference) => {
      const { parent } = reference;
      if (
        !(
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === reference
        )
      )
        return false;
      const prop = props[parent.name.text];
      if (!prop || isWritten(parent)) return false;
      if (prop.special)
        return (
          ts.isCallExpression(parent.parent) &&
          parent.parent.expression === parent
        );
      return true;
    });
    if (!safe) return fallback(parameter.name.text, known);
    for (const reference of references) {
      const access = reference.parent;
      const prop = props[access.name.text];
      if (prop.special)
        specialCalls.push({ call: access.parent, prop: access.name.text });
      else {
        substitutions.set(access, { text: prop.text, moment: prop.moment });
        if (access.name.text === "proceed") proceedReferences.add(access);
      }
    }
    return { substitutions, prelude, specialCalls, proceedReferences, flags };
  }

  if (!ts.isObjectBindingPattern(parameter.name))
    refuse(member, "its handler's context parameter is an array pattern");
  const elements = parameter.name.elements;
  const nameIn = (element) =>
    element.propertyName ? nameOf(element.propertyName) : element.name.text;
  for (const element of elements)
    if (!element.dotDotDotToken) {
      const name = element.propertyName
        ? nameOf(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : undefined;
      if (name === undefined || !props[name])
        refuse(
          member,
          `its handler reads \`${name ?? element.getText(sf)}\`, which the old context has no member for`
        );
    }
  const simple = elements.every(
    (element) =>
      !(element.dotDotDotToken || element.initializer) &&
      ts.isIdentifier(element.name)
  );
  const pattern = parameter.name.getText(sf);
  if (!simple) {
    const rest = elements.some((element) => element.dotDotDotToken);
    return fallback(
      pattern,
      rest ? known : elements.filter((e) => !e.dotDotDotToken).map(nameIn)
    );
  }
  const plan = [];
  for (const element of elements) {
    const name = nameIn(element);
    const symbol = checker.getSymbolAtLocation(element.name);
    const references = referencesTo(checker, body, symbol);
    if (references.some(isWritten))
      return fallback(pattern, elements.map(nameIn));
    if (props[name].special) {
      const calls = references.every(
        (reference) =>
          ts.isIdentifier(reference) &&
          ts.isCallExpression(reference.parent) &&
          reference.parent.expression === reference
      );
      if (!calls) return fallback(pattern, elements.map(nameIn));
    }
    plan.push({ name, references });
  }
  for (const { name, references } of plan)
    for (const reference of references) {
      if (props[name].special)
        specialCalls.push({ call: reference.parent, prop: name });
      else if (ts.isShorthandPropertyAssignment(reference))
        substitutions.set(reference, {
          text: () => `${reference.name.text}: ${props[name].text()}`,
          moment: props[name].moment,
        });
      else {
        substitutions.set(reference, {
          text: props[name].text,
          moment: props[name].moment,
        });
        if (name === "proceed") proceedReferences.add(reference);
      }
    }
  return { substitutions, prelude, specialCalls, proceedReferences, flags };
}

/** A renderer that applies `substitutions` (node → { text } or () => string). */
function renderer(ctx, substitutions) {
  const self = (node) =>
    render(ctx.sf, node, (candidate) => {
      const found = substitutions.get(candidate);
      if (found === undefined) return undefined;
      return typeof found === "function" ? found(self) : found.text();
    });
  return self;
}

/** A body's text with statements put first: a block keeps its braces. */
function bodyWith(rendered, isBlock, prelude, expressionTail) {
  if (isBlock)
    return prelude.length
      ? rendered.replace(OPENING_BRACE, `{ ${prelude.join(" ")}`)
      : rendered;
  if (!(prelude.length || expressionTail)) return rendered;
  return `{ ${prelude.join(" ")} ${expressionTail ? expressionTail(rendered) : `return ${rendered};`} }`;
}

/** Rewrite each own `return X` of `fn` with `wrap`. */
function rewriteReturns(fn, substitutions, wrap) {
  const statements = ts.isBlock(fn.body) ? fn.body.statements : [];
  const last = statements.at(-1);
  for (const statement of ownReturns(fn)) {
    if (!statement.expression) continue;
    substitutions.set(statement, (self) =>
      wrap(self(statement.expression), statement === last)
    );
  }
}

/** The props of `query`'s context. */
function queryProps(P, names) {
  return {
    proceed: { text: () => names.run(), moment: 2 },
    input: { text: () => P.printRunInput(names.run()), moment: 2 },
    mode: { text: () => P.printRunMode(names.run()), moment: 2 },
    kind: { text: () => P.printCallKind(names.c()), moment: 1 },
    model: { text: () => P.printCallModel(names.c()), moment: 1 },
    operation: { text: () => P.printCallOperation(names.c()), moment: 1 },
    controls: { text: () => P.printCallValues(names.c()), moment: 1 },
    onWriteOutcome: {
      text: () => `(listener) => ${P.printSettled(names.c(), "listener")}`,
      moment: 2,
      special: true,
    },
  };
}

function requestProps(P, names) {
  return {
    input: { text: () => P.printCallArgs(names.c()), moment: 1 },
    controls: { text: () => P.printCallValues(names.c()), moment: 1 },
    model: { text: () => P.printCallModel(names.c()), moment: 1 },
    operation: { text: () => P.printCallOperation(names.c()), moment: 1 },
  };
}

/** Handler parameter names, fresh in `node`; `used.c` says whether `c` was printed. */
function handlerNames(node, ctx) {
  const fresh = freshNames(node, [...ctx.words.local.values()]);
  const chosen = {};
  const used = {};
  const name = (key) => () => {
    chosen[key] ??= fresh(PARAMETERS[key]);
    used[key] = true;
    return chosen[key];
  };
  return {
    c: name("call"),
    run: name("run"),
    u: name("unit"),
    next: name("next"),
    fresh,
    used,
  };
}

/** `query` (one handler) → a `call` part with a second moment. */
function convertQueryHandler(ctx, member, fn, on) {
  const { P, sf, checker } = ctx;
  const names = handlerNames(fn, ctx);
  const props = queryProps(P, names);
  if (fn.asteriskToken) refuse(member, "a generator handler");
  if (readsReceiver(fn)) refuse(member, "its handler reads this or arguments");
  const bound = bindContext(ctx, member, fn, fn.parameters[0], props);
  if (fn.parameters.length > 1)
    refuse(member, "its handler takes more than the context");
  const flags = [...bound.flags];
  const substitutions = new Map(bound.substitutions);
  const hoisted = [];
  const self = renderer(ctx, substitutions);
  for (const { call } of bound.specialCalls) {
    const statement = call.parent;
    const top =
      ts.isBlock(fn.body) &&
      ts.isExpressionStatement(statement) &&
      statement.parent === fn.body;
    let hoistable = top && call.arguments.length === 1;
    if (hoistable) {
      const index = fn.body.statements.indexOf(statement);
      for (const before of fn.body.statements.slice(0, index)) {
        walk(
          before,
          (node) => {
            if (ts.isReturnStatement(node) || bound.proceedReferences.has(node))
              hoistable = false;
          },
          isFunctionNode
        );
        if (ts.isReturnStatement(before) || bound.proceedReferences.has(before))
          hoistable = false;
      }
      // The listener may read only what the first moment has.
      const listener = call.arguments[0];
      walk(listener, (node) => {
        const substitution = bound.substitutions.get(node);
        if (substitution && substitution.moment !== 1) hoistable = false;
        if (substitution || !ts.isIdentifier(node)) return;
        const symbol = checker.getSymbolAtLocation(node);
        const declaration = symbol?.declarations?.[0];
        if (
          declaration &&
          declaration.getStart(sf) >= fn.getStart(sf) &&
          declaration.getEnd() <= fn.getEnd() &&
          !(
            declaration.getStart(sf) >= listener.getStart(sf) &&
            declaration.getEnd() <= listener.getEnd()
          )
        )
          hoistable = false;
      });
      if (
        ts.isIdentifier(listener) ||
        ts.isArrowFunction(listener) ||
        ts.isFunctionExpression(listener)
      ) {
        // read above
      }
    }
    if (hoistable) {
      substitutions.set(statement, { text: () => "" });
      hoisted.push(() => P.printSettled(names.c(), self(call.arguments[0])));
    } else {
      flags.push(
        "`onWriteOutcome` is not called unconditionally before `proceed()`: `settled` must move to the first moment by hand"
      );
      substitutions.set(call, (render_) =>
        P.printSettled(
          names.c(),
          call.arguments.map((argument) => render_(argument)).join(", ")
        )
      );
    }
  }
  const body = self(fn.body);
  const second = P.printAround(
    isAsync(fn),
    names.run(),
    bodyWith(body, ts.isBlock(fn.body), bound.prelude)
  );
  const settledTexts = hoisted.map((print) => `${print()};`);
  const first = settledTexts.length
    ? `{ ${settledTexts.join(" ")} return ${second}; }`
    : second;
  const readsCall = names.used.call === true;
  const handler = P.printHandler(readsCall ? names.c() : "", first, readsCall);
  return { text: P.printCallAround(handler, on), flags };
}

/** `request` (one handler) → a `call` part, first moment only. */
function convertRequestHandler(ctx, member, fn, on) {
  const { P } = ctx;
  const names = handlerNames(fn, ctx);
  if (isAsync(fn) || fn.asteriskToken)
    refuse(member, "an async request handler has no first-moment spelling");
  if (readsReceiver(fn)) refuse(member, "its handler reads this or arguments");
  if (fn.parameters.length > 1)
    refuse(member, "its handler takes more than the context");
  const bound = bindContext(
    ctx,
    member,
    fn,
    fn.parameters[0],
    requestProps(P, names)
  );
  const substitutions = new Map(bound.substitutions);
  const self = renderer(ctx, substitutions);
  const set = (patch) => P.printSet(names.c(), patch);
  let body;
  if (ts.isBlock(fn.body)) {
    rewriteReturns(fn, substitutions, (patch, last) =>
      last ? `${set(patch)};` : `{ ${set(patch)}; return; }`
    );
    body = bodyWith(self(fn.body), true, bound.prelude);
  } else
    body = `{ ${bound.prelude.join(" ")} ${set(self(skipParens(fn.body)))}; }`;
  names.c();
  return {
    text: P.printCall(P.printHandler(names.c(), body, true), on),
    flags: bound.flags,
  };
}

/** A handler held in a variable: called with the old context rebuilt. */
function convertHeldHandler(ctx, member, held, on) {
  const { P, sf } = ctx;
  const names = handlerNames(held, ctx);
  const callee = held.getText(sf);
  if (member === "request") {
    const props = requestProps(P, names);
    const context = contextObject(props, Object.keys(props));
    return {
      text: P.printCall(
        P.printHandler(
          names.c(),
          `{ ${P.printSet(names.c(), `${callee}(${context})`)}; }`,
          true
        ),
        on
      ),
      flags: [
        `the handler is \`${callee}\`, called with the old context rebuilt: rewrite it in the new parameters`,
      ],
    };
  }
  const props = queryProps(P, names);
  const context = contextObject(props, Object.keys(props));
  return {
    text: P.printCallAround(
      P.printHandler(
        names.c(),
        P.printAround(false, names.run(), `${callee}(${context})`),
        true
      ),
      on
    ),
    flags: [
      `the handler is \`${callee}\`, called with the old context rebuilt (its onWriteOutcome runs at the second moment): rewrite it in the new parameters`,
    ],
  };
}

/** `request` or `query`: one handler, or a `{ model: { operation: handler } }` map. */
function convertHandlerMember(ctx, member, property) {
  const convertOne = (handlerProperty, on) => {
    const { fn, held } = functionOf(ctx, member, handlerProperty);
    if (held) return convertHeldHandler(ctx, member, held, on);
    return member === "query"
      ? convertQueryHandler(ctx, member, fn, on)
      : convertRequestHandler(ctx, member, fn, on);
  };
  const value =
    !ts.isMethodDeclaration(property) && valueNodeOf(ctx.checker, property);
  if (value) {
    const inner = literalOf(ctx.checker, value);
    if (ts.isObjectLiteralExpression(inner)) {
      const parts = [];
      for (const modelProperty of inner.properties) {
        const model = nameOf(modelProperty.name);
        const modelValue = valueNodeOf(ctx.checker, modelProperty);
        if (!modelValue || model === undefined)
          refuse(
            member,
            "its model map holds a spread, a computed key or a method"
          );
        const operations = literalOf(ctx.checker, modelValue);
        if (!ts.isObjectLiteralExpression(operations))
          refuse(
            member,
            `its operations of \`${model}\` are not an object literal`
          );
        for (const operationProperty of operations.properties) {
          const operation = nameOf(operationProperty.name);
          if (
            operation === undefined ||
            ts.isSpreadAssignment(operationProperty)
          )
            refuse(
              member,
              `its operations of \`${model}\` hold a spread or a computed key`
            );
          parts.push(
            convertOne(
              operationProperty,
              ctx.P.printOnOperation(model, operation)
            )
          );
        }
      }
      return parts;
    }
  }
  return [convertOne(property, undefined)];
}

/** `written` → `call((c) => { watch(c, …); settled(c, …) }, on(writes))`. */
function convertWritten(ctx, property) {
  const member = "written";
  const { P, sf } = ctx;
  const { fn, held: heldValue } = functionOf(ctx, member, property);
  // A handler that does not end by returning its watcher literal is called
  // as it is, with the old call rebuilt.
  const literalForm =
    fn && !isAsync(fn) && !readsReceiver(fn) && writtenWatcher(fn);
  const held = heldValue ?? (literalForm ? undefined : fn);
  if (held) {
    if (ts.isObjectLiteralExpression(held))
      refuse(member, "its handler is an object, not a function");
    const names = handlerNames(held, ctx);
    const c = names.c();
    const watcher = names.fresh("watcher");
    const outcome = names.fresh("outcome");
    const context = printObject([
      ["model", P.printCallModel(c)],
      ["operation", P.printCallOperation(c)],
      ["args", P.printCallArgs(c)],
      ["controls", P.printCallValues(c)],
    ]);
    const heldText =
      held === fn ? functionText(ctx, member, property) : held.getText(sf);
    const body = `{ const ${watcher} = (${heldText})(${context}); if (${watcher} === undefined) return; ${P.printWatch(c, watcher)}; ${P.printSettled(c, `(${outcome}) => ${watcher}.settled(${outcome})`)}; }`;
    return [
      {
        text: P.printCall(
          P.printHandler(c, body, true),
          P.printOnFamily("writes")
        ),
        flags: [
          held === fn
            ? "the handler does not return its watcher as one literal: it is called with the old call rebuilt; rewrite it with watch and settled"
            : `the handler is \`${held.getText(sf).slice(0, 40)}\`, called with the old call rebuilt: rewrite it with watch and settled`,
        ],
      },
    ];
  }
  if (isAsync(fn) || readsReceiver(fn))
    refuse(member, "an async handler, or one that reads this");
  const names = handlerNames(fn, ctx);
  const props = {
    model: { text: () => P.printCallModel(names.c()), moment: 1 },
    operation: { text: () => P.printCallOperation(names.c()), moment: 1 },
    args: { text: () => P.printCallArgs(names.c()), moment: 1 },
    controls: { text: () => P.printCallValues(names.c()), moment: 1 },
  };
  const bound = bindContext(ctx, member, fn, fn.parameters[0], props);
  const substitutions = new Map(bound.substitutions);
  const self = renderer(ctx, substitutions);
  let watcher;
  const statements = [];
  if (ts.isBlock(fn.body)) {
    const list = fn.body.statements;
    const last = list.at(-1);
    const returned =
      last &&
      ts.isReturnStatement(last) &&
      last.expression &&
      unwrap(last.expression).inner;
    if (!(returned && ts.isObjectLiteralExpression(returned)))
      refuse(member, "its handler does not end by returning an object literal");
    watcher = returned;
    for (const statement of ownReturns(fn))
      if (statement !== last) {
        const expression =
          statement.expression && skipParens(statement.expression);
        if (
          expression &&
          !(ts.isIdentifier(expression) && expression.text === "undefined")
        )
          refuse(
            member,
            "its handler returns a watcher from more than one place"
          );
        substitutions.set(statement, { text: () => "return;" });
      }
    for (const statement of list.slice(0, -1)) statements.push(self(statement));
  } else {
    watcher = unwrap(fn.body).inner;
    if (!ts.isObjectLiteralExpression(watcher))
      refuse(member, "its handler does not return an object literal");
  }
  const watched = [];
  let settledText;
  for (const entry of watcher.properties) {
    const key = nameOf(entry.name);
    if (key === "wants" || key === "rows") watched.push(self(entry));
    else if (key === "settled") {
      if (ts.isMethodDeclaration(entry)) {
        if (readsReceiver(entry)) refuse(member, "its settled reads this");
        settledText = `${isAsync(entry) ? "async " : ""}(${entry.parameters.map((p) => self(p)).join(", ")}) => ${self(entry.body)}`;
      } else if (ts.isPropertyAssignment(entry))
        settledText = self(entry.initializer);
      else if (ts.isShorthandPropertyAssignment(entry))
        settledText = self(entry.name);
      else refuse(member, "its settled is an accessor");
    } else
      refuse(
        member,
        `its watcher has a member \`${key ?? "?"}\` the contract does not read`
      );
  }
  if (watched.length)
    statements.push(`${P.printWatch(names.c(), `{ ${watched.join(", ")} }`)};`);
  if (settledText)
    statements.push(`${P.printSettled(names.c(), settledText)};`);
  const body = `{ ${[...bound.prelude, ...statements].join("\n")} }`;
  return [
    {
      text: P.printCall(
        P.printHandler(names.c(), body, true),
        P.printOnFamily("writes")
      ),
      flags: bound.flags,
    },
  ];
}

/** Whether `written`'s handler returns its watcher as one object literal at its end. */
function writtenWatcher(fn) {
  if (!ts.isBlock(fn.body))
    return ts.isObjectLiteralExpression(unwrap(fn.body).inner);
  const list = fn.body.statements;
  const last = list.at(-1);
  if (
    !(
      last &&
      ts.isReturnStatement(last) &&
      last.expression &&
      ts.isObjectLiteralExpression(unwrap(last.expression).inner)
    )
  )
    return false;
  return ownReturns(fn).every((statement) => {
    if (statement === last || !statement.expression) return true;
    const expression = skipParens(statement.expression);
    return ts.isIdentifier(expression) && expression.text === "undefined";
  });
}

/** A member's function as an expression: a method becomes an arrow. */
function functionText(ctx, member, property) {
  const { sf } = ctx;
  const { fn, held } = functionOf(ctx, member, property);
  if (held) return held.getText(sf);
  if (ts.isMethodDeclaration(fn)) {
    if (readsReceiver(fn) || fn.asteriskToken)
      refuse(member, "its method reads this, or is a generator");
    const typeParameters = fn.typeParameters
      ? `<${fn.typeParameters.map((t) => t.getText(sf)).join(", ")}>`
      : "";
    const type = fn.type ? `: ${fn.type.getText(sf)}` : "";
    return `${isAsync(fn) ? "async " : ""}${typeParameters}(${fn.parameters.map((p) => p.getText(sf)).join(", ")})${type} => ${fn.body.getText(sf)}`;
  }
  return fn.getText(sf);
}

function convertRetry(ctx, property) {
  const { P } = ctx;
  const value = functionText(ctx, "retry", property);
  const names = handlerNames(property, ctx);
  // The loop's names are declared inside the second moment, apart from the
  // old handler's closure: only the const that holds it must be fresh.
  const retry = names.fresh("retry");
  const attempt = "attempt";
  const error = "error";
  const run = names.run();
  const c = names.c();
  const around = P.printAround(
    true,
    run,
    `{ for (let ${attempt} = 1; ; ${attempt}++) { try { return await ${run}(); } catch (${error}) { if (!(${P.printAgain(run)} && (await ${retry}(${error}, ${attempt}, { model: ${P.printCallModel(c)}, operation: ${P.printCallOperation(c)} })))) throw ${error}; } } }`
  );
  return [
    {
      text: P.printCallAround(
        P.printHandler(
          c,
          `{ const ${retry} = ${value}; return ${around}; }`,
          true
        )
      ),
      flags: [],
    },
  ];
}

function convertRoute(ctx, property) {
  const { P } = ctx;
  const value = functionText(ctx, "route", property);
  const names = handlerNames(property, ctx);
  const route = names.fresh("route");
  const driver = "driver";
  const run = names.run();
  const c = names.c();
  const around = P.printAround(
    false,
    run,
    `{ const ${driver} = ${route}({ model: ${P.printCallModel(c)}, operation: ${P.printCallOperation(c)}, args: ${P.printRunInput(run)} }); return ${driver} === undefined ? ${run}() : ${P.printVia(run, driver)}; }`
  );
  return [
    {
      text: P.printCallAround(
        P.printHandler(
          c,
          `{ const ${route} = ${value}; return ${around}; }`,
          true
        ),
        P.printOnFamily("reads")
      ),
      flags: [
        "`route` was asked only for a read outside a transaction; the part now runs on every read: check the test counts no extra call",
      ],
    },
  ];
}

function convertTransaction(ctx, property) {
  const { P } = ctx;
  const value = functionText(ctx, "transaction", property);
  const names = handlerNames(property, ctx);
  const open = names.fresh("open");
  // Not `statement`: that is a word a file may import.
  const statement = "query";
  const u = names.u();
  const next = names.next();
  const handler = P.printUnitHandler(
    true,
    u,
    next,
    `{ const ${open} = ${value}; await ${open}((${statement}) => ${P.printRunInUnit(u, statement)}); return ${P.printNext(next)}; }`
  );
  return [{ text: P.printUnit(handler, ["transaction"]), flags: [] }];
}

function convertStatement(ctx, property) {
  const member = "statement";
  const { P, sf } = ctx;
  const { fn, held } = functionOf(ctx, member, property);
  if (held)
    refuse(member, `its handler is \`${held.getText(sf)}\`, written elsewhere`);
  if (readsReceiver(fn)) refuse(member, "its handler reads this");
  const names = handlerNames(fn, ctx);
  const props = {
    statement: { text: () => P.printStatement(names.u()), moment: 1 },
    model: { text: () => P.printUnitModel(names.u()), moment: 1 },
    operation: { text: () => P.printUnitOperation(names.u()), moment: 1 },
  };
  const bound = bindContext(ctx, member, fn, fn.parameters[0], props);
  const substitutions = new Map(bound.substitutions);
  const self = renderer(ctx, substitutions);
  let body;
  if (ts.isBlock(fn.body)) {
    rewriteReturns(
      fn,
      substitutions,
      (statement) => `return ${P.printNext(names.next(), statement)};`
    );
    body = bodyWith(self(fn.body), true, bound.prelude);
  } else
    body = bodyWith(
      self(fn.body),
      false,
      bound.prelude,
      (text) => `return ${P.printNext(names.next(), text)};`
    );
  if (!(ts.isBlock(fn.body) || bound.prelude.length))
    body = P.printNext(names.next(), self(fn.body));
  const handler = P.printUnitHandler(
    isAsync(fn),
    names.u(),
    names.next(),
    body
  );
  return [
    {
      text: P.printUnit(handler, ["statement"], { rewrites: "true" }),
      flags: bound.flags,
    },
  ];
}

function convertObserve(ctx, property, observes) {
  const member = "observe";
  const { P, sf, checker } = ctx;
  const { fn, held } = functionOf(ctx, member, property);
  if (held)
    refuse(
      member,
      `its observer is \`${held.getText(sf)}\`, written elsewhere`
    );
  if (readsReceiver(fn)) refuse(member, "its observer reads this");
  const names = handlerNames(fn, ctx);
  const [unitParameter, proceedParameter, factsParameter] = fn.parameters;
  if (factsParameter) {
    const facts = ts.isIdentifier(factsParameter.name)
      ? referencesTo(
          checker,
          fn.body,
          checker.getSymbolAtLocation(factsParameter.name)
        )
      : [factsParameter];
    if (facts.length)
      refuse(
        member,
        "it reads the facts `observes` produces: rewrite them with sql(u), parameters(u), driver(u), failure(u) by hand"
      );
  }
  const substitutions = new Map();
  const prelude = [];
  const bindPositional = (parameter, text) => {
    if (!parameter) return;
    if (!ts.isIdentifier(parameter.name)) {
      prelude.push(`const ${parameter.name.getText(sf)} = ${text()};`);
      return;
    }
    const references = referencesTo(
      checker,
      fn.body,
      checker.getSymbolAtLocation(parameter.name)
    );
    if (references.some(isWritten)) {
      prelude.push(`let ${parameter.name.text} = ${text()};`);
      return;
    }
    for (const reference of references)
      substitutions.set(reference, {
        text: ts.isShorthandPropertyAssignment(reference)
          ? () => `${reference.name.text}: ${text()}`
          : text,
      });
  };
  bindPositional(unitParameter, names.u);
  bindPositional(proceedParameter, names.next);
  const self = renderer(ctx, substitutions);
  const body = bodyWith(self(fn.body), ts.isBlock(fn.body), prelude);
  const flags = observes ? [] : [];
  return [
    {
      text: P.printUnit(
        P.printUnitHandler(isAsync(fn), names.u(), names.next(), body)
      ),
      flags,
    },
  ];
}

// =============================================================================
// FILTERS AND DATA: markers in value positions become words
// =============================================================================

/** Keys whose value is itself a filter, never a value (create.mdx). */
const FILTER_KEYS = new Set([
  "AND",
  "OR",
  "NOT",
  "some",
  "every",
  "none",
  "is",
  "isNot",
]);
const TESTS = new Set(["exists", "equals", "in", "has", "hasSome"]);

/** Whether a literal holds an old marker anywhere. */
function holdsMarker(node) {
  let found = false;
  const visit = (current) => {
    if (ts.isObjectLiteralExpression(current))
      for (const property of current.properties) {
        const key = nameOf(property.name);
        if (key === "$if" || key === "$exists" || key === "$row") found = true;
        if (
          key === "control" &&
          ts.isPropertyAssignment(property) &&
          isStringLike(property.initializer)
        )
          found = true;
        if (
          key === "now" &&
          ts.isPropertyAssignment(property) &&
          property.initializer.kind === S.TrueKeyword
        )
          found = true;
      }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/** A filter or value the codemod does not read: refused if it holds a marker. */
function opaque(ctx, member, node, inFilter, flags) {
  const { checker, sf } = ctx;
  const inner = unwrap(node).inner;
  if (ts.isIdentifier(inner) || ts.isPropertyAccessExpression(inner)) {
    const held = literalOf(checker, inner);
    if (held !== inner) {
      // A shared filter that names call values is written out where it is
      // used: its markers become words there.
      if (holdsMarker(held))
        return inFilter
          ? filterText(ctx, member, held, flags)
          : valueText(ctx, member, held, flags);
      return node.getText(sf);
    }
  }
  if (ts.isIdentifier(inner)) {
    if (inFilter && inner.text !== "undefined")
      flags.push(
        `the filter \`${inner.text}\` comes from outside the file or a parameter: check it names no call value`
      );
    return node.getText(sf);
  }
  if (holdsMarker(inner))
    refuse(
      member,
      `a filter holds a marker inside an expression the codemod does not read (\`${inner.getText(sf).slice(0, 40)}\`)`
    );
  if (
    inFilter &&
    !ts.isObjectLiteralExpression(inner) &&
    !ts.isArrayLiteralExpression(inner) &&
    inner.kind !== S.TrueKeyword
  )
    flags.push(
      `the filter \`${inner.getText(sf).slice(0, 40)}\` is computed: check it names no call value`
    );
  return node.getText(sf);
}

/** The object literal `{ control, path? }` as `arg(…)`, when it is one. */
function markerOf(ctx, node) {
  const { P, sf } = ctx;
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  const props = new Map();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) return undefined;
    props.set(nameOf(property.name), property.initializer);
  }
  const keys = [...props.keys()];
  const control = props.get("control");
  if (
    control &&
    keys.every((key) => key === "control" || key === "path") &&
    !ts.isObjectLiteralExpression(skipParens(control)) &&
    !ts.isArrayLiteralExpression(skipParens(control))
  )
    return P.printArg(control.getText(sf), props.get("path")?.getText(sf));
  if (keys.length === 1 && props.get("now")?.kind === S.TrueKeyword)
    return P.printNow();
  if (keys.length === 2 && props.has("$row") && props.has("up"))
    return P.printRow(
      props.get("$row").getText(sf),
      props.get("up").getText(sf)
    );
  return undefined;
}

/** A value position: a marker becomes its word; an operator object recurses. */
function valueText(ctx, member, node, flags) {
  const inner = skipParens(node);
  if (ts.isObjectLiteralExpression(inner)) {
    const marker = markerOf(ctx, inner);
    if (marker) return marker;
    const keys = inner.properties.map((p) => nameOf(p.name));
    if (keys.includes("$if") || keys.includes("$exists"))
      return filterText(ctx, member, inner, flags);
    return objectText(ctx, member, inner, flags, (key) =>
      FILTER_KEYS.has(key) ? "filter" : "value"
    );
  }
  if (ts.isArrayLiteralExpression(inner))
    return `[${inner.elements.map((element) => valueText(ctx, member, element, flags)).join(", ")}]`;
  if (ts.isConditionalExpression(inner))
    return `${inner.condition.getText(ctx.sf)} ? ${valueText(ctx, member, inner.whenTrue, flags)} : ${valueText(ctx, member, inner.whenFalse, flags)}`;
  return opaque(ctx, member, node, false, flags);
}

/** An object literal re-rendered, each property's value in the mode `modeOf` gives. */
function objectText(ctx, member, node, flags, modeOf) {
  const substitutions = new Map();
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property)) {
      const key = nameOf(property.name);
      const mode = key === undefined ? "value" : modeOf(key);
      substitutions.set(property.initializer, () =>
        mode === "filter"
          ? filterText(ctx, member, property.initializer, flags)
          : mode === "data"
            ? valueText(ctx, member, property.initializer, flags)
            : valueText(ctx, member, property.initializer, flags)
      );
    } else if (ts.isSpreadAssignment(property))
      substitutions.set(property.expression, () =>
        opaque(ctx, member, property.expression, true, flags)
      );
    else if (ts.isShorthandPropertyAssignment(property))
      substitutions.set(property, () => {
        opaque(ctx, member, property.name, false, flags);
        return property.getText(ctx.sf);
      });
    else refuse(member, "a filter holds a method or an accessor");
  }
  return render(ctx.sf, node, (candidate) => substitutions.get(candidate)?.());
}

/** A filter position: never a reference itself; `$if` and `$exists` become words. */
function filterText(ctx, member, node, flags) {
  const { P, sf } = ctx;
  const inner = skipParens(node);
  if (ts.isArrayLiteralExpression(inner))
    return `[${inner.elements.map((element) => filterText(ctx, member, element, flags)).join(", ")}]`;
  if (ts.isConditionalExpression(inner))
    return `${inner.condition.getText(sf)} ? ${filterText(ctx, member, inner.whenTrue, flags)} : ${filterText(ctx, member, inner.whenFalse, flags)}`;
  if (!ts.isObjectLiteralExpression(inner))
    return opaque(ctx, member, node, true, flags);
  const condition = inner.properties.find((p) => nameOf(p.name) === "$if");
  const existence = inner.properties.find((p) => nameOf(p.name) === "$exists");
  const modeOf = (key) =>
    key === "AND" || key === "OR" || key === "NOT" ? "filter" : "value";
  if (!(condition || existence))
    return objectText(ctx, member, inner, flags, modeOf);
  const rest = inner.properties.filter(
    (p) => p !== condition && p !== existence
  );
  let restText;
  if (rest.length) {
    const parts = rest.map((property) => {
      if (ts.isPropertyAssignment(property)) {
        const key = nameOf(property.name);
        const value =
          modeOf(key ?? "") === "filter"
            ? filterText(ctx, member, property.initializer, flags)
            : valueText(ctx, member, property.initializer, flags);
        return `${property.name.getText(sf)}: ${value}`;
      }
      if (ts.isSpreadAssignment(property))
        return `...${opaque(ctx, member, property.expression, true, flags)}`;
      return property.getText(sf);
    });
    restText = `{ ${parts.join(", ")} }`;
  }
  let existsText;
  if (existence) {
    if (!ts.isPropertyAssignment(existence))
      refuse(member, "`$exists` is not a property");
    const spec = literalOf(ctx.checker, existence.initializer);
    if (!ts.isObjectLiteralExpression(spec))
      refuse(member, "`$exists` is not an object literal the file writes");
    existsText = P.printExists(
      objectText(ctx, member, spec, flags, () => "filter")
    );
  }
  let filter;
  if (restText && existsText) filter = P.printAll([restText, existsText]);
  else filter = restText ?? existsText ?? "{}";
  if (!condition) return filter;
  if (!ts.isPropertyAssignment(condition))
    refuse(member, "`$if` is not a property");
  const spec = skipParens(condition.initializer);
  if (!ts.isObjectLiteralExpression(spec))
    refuse(member, "`$if` is not an object literal");
  const fieldsOf = new Map(spec.properties.map((p) => [nameOf(p.name), p]));
  const control = fieldsOf.get("control");
  const path = fieldsOf.get("path");
  const tests = [...fieldsOf.keys()].filter(
    (key) => key !== "control" && key !== "path"
  );
  if (
    !(control && ts.isPropertyAssignment(control)) ||
    tests.length !== 1 ||
    !TESTS.has(tests[0])
  )
    refuse(member, "`$if` is not `{ control, path?, <one test> }`");
  const test = fieldsOf.get(tests[0]);
  if (!ts.isPropertyAssignment(test))
    refuse(member, "`$if`'s test is not a property");
  // `$if` holds only where its test holds: `provided` (spec §12.1).
  return P.printProvided(
    P.printArg(
      control.initializer.getText(sf),
      path && ts.isPropertyAssignment(path)
        ? path.initializer.getText(sf)
        : undefined
    ),
    P.printTest(tests[0], test.initializer.getText(sf)),
    filter
  );
}

/** A data object (`data`'s create/update, `deletion`'s assign): each field a value. */
function dataText(ctx, member, node, flags) {
  const inner = skipParens(unwrap(node).inner);
  if (!ts.isObjectLiteralExpression(inner))
    return opaque(ctx, member, node, true, flags);
  return objectText(ctx, member, inner, flags, () => "value");
}

// =============================================================================
// RULES: the members that name models, merged per model
// =============================================================================

/**
 * A member's `{ model: entry }` map: an object literal of models, or a call
 * `f(list, (m?) => ({ …entry }))` that builds one per model of `list` (the
 * recipes' `perModel`). Each target is a static model or such a group.
 */
function modelEntries(ctx, member, node) {
  const { sf, checker } = ctx;
  const inner = literalOf(checker, node);
  if (ts.isObjectLiteralExpression(inner))
    return inner.properties.map((property) => {
      const model = nameOf(property.name);
      const value = valueNodeOf(checker, property);
      if (!value || model === undefined)
        refuse(
          member,
          "its model map holds a spread, a computed key or a method"
        );
      return { target: { model }, entry: value };
    });
  const group = perModelCall(sf, inner);
  if (group) return [group];
  refuse(
    member,
    `its model map \`${inner.getText(sf).slice(0, 50)}\` is not an object literal or a per-model call`
  );
}

const ENTRY = "\u0000entry\u0000";

/**
 * A call that builds one entry per model: `f(list, (m?) => entry)`,
 * `f(() => entry)` (its list is not written here), or
 * `Object.fromEntries(list.map((m) => [m, entry]))`. The group keeps the call
 * as a template around the entry, so entries of two members built by the
 * same call merge.
 */
function perModelCall(sf, call) {
  if (!ts.isCallExpression(call)) return undefined;
  let build;
  let list;
  let pair = false;
  if (
    call.expression.getText(sf) === "Object.fromEntries" &&
    call.arguments.length === 1
  ) {
    const mapped = skipParens(call.arguments[0]);
    if (
      !(
        ts.isCallExpression(mapped) &&
        ts.isPropertyAccessExpression(mapped.expression) &&
        mapped.expression.name.text === "map" &&
        mapped.arguments.length === 1
      )
    )
      return undefined;
    list = mapped.expression.expression.getText(sf);
    build = skipParens(mapped.arguments[0]);
    pair = true;
  } else if (call.arguments.length === 2) {
    list = call.arguments[0].getText(sf);
    build = skipParens(call.arguments[1]);
  } else if (call.arguments.length === 1) build = skipParens(call.arguments[0]);
  else return undefined;
  if (
    !(ts.isArrowFunction(build) || ts.isFunctionExpression(build)) ||
    build.parameters.length > 1
  )
    return undefined;
  let returned;
  if (!ts.isBlock(build.body)) returned = build.body;
  else if (
    build.body.statements.length === 1 &&
    ts.isReturnStatement(build.body.statements[0])
  )
    returned = build.body.statements[0].expression;
  if (!returned) return undefined;
  // The template replaces the entry with its parentheses, so two members
  // whose entries differ only by them (`() => ({…})`, `() => […]`) share it.
  let slot = returned;
  if (pair) {
    const array = skipParens(returned);
    if (!ts.isArrayLiteralExpression(array) || array.elements.length !== 2)
      return undefined;
    slot = array.elements[1];
  }
  const entry = skipParens(slot);
  const template = render(sf, call, (node) =>
    node === slot ? ENTRY : undefined
  );
  return { target: { group: template, template, list }, entry };
}

const targetKey = (target) =>
  target.model !== undefined ? `m:${target.model}` : `g:${target.group}`;
const camel = (text) =>
  text
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
    .replace(FIRST_LETTER, (c) => c.toLowerCase());

/** The rule entries of one definition, merged per model. */
class Rules {
  /**
   * `kind` is the part the entries print as: `rule` (what binds the caller)
   * or `defaults` (what holds when the caller says nothing, D13).
   */
  constructor(kind = "rule") {
    this.kind = kind;
    this.targets = new Map();
  }
  target(target) {
    const key = targetKey(target);
    if (!this.targets.has(key))
      this.targets.set(key, {
        target,
        tree: new Map(),
        prelude: [],
        lazy: undefined,
      });
    return this.targets.get(key);
  }
  /** Put a leaf at `path`; `combine` leaves gather several values. */
  set(member, target, path, value, combine) {
    let node = this.target(target).tree;
    for (const key of path.slice(0, -1)) {
      if (!node.has(key)) node.set(key, new Map());
      node = node.get(key);
      if (!(node instanceof Map))
        refuse(member, `two members write rule.${path.join(".")}`);
    }
    const leaf = path.at(-1);
    if (combine) {
      if (!node.has(leaf)) node.set(leaf, { combine, values: [] });
      node.get(leaf).values.push(value);
    } else if (node.has(leaf))
      refuse(member, `two members write rule.${path.join(".")} for one model`);
    else node.set(leaf, { value });
  }
  /** Every static model and every group this definition names. */
  models() {
    const names = [];
    const lists = [];
    for (const { target } of this.targets.values())
      if (target.model !== undefined) names.push(target.model);
      else if (!lists.includes(target.list)) lists.push(target.list);
    return { names, lists };
  }
  print(P, flags) {
    const printTree = (tree) =>
      printObject(
        [...tree.entries()].map(([key, leaf]) => {
          if (leaf instanceof Map) return [key, printTree(leaf)];
          if (leaf.combine === "conditions")
            return [key, P.printConditions(leaf.values)];
          if (leaf.combine === "checks")
            return [key, P.printCheck(P.printAll(leaf.values))];
          return [key, leaf.value];
        })
      );
    const ORDER =
      this.kind === "rule"
        ? [
            "read",
            "root",
            "related",
            "create",
            "update",
            "delete",
            "acyclic",
            "confine",
          ]
        : ["orderBy", "create", "update", "fields"];
    const printPart = (models) =>
      this.kind === "rule" ? P.printRule(models) : P.printDefaults(models);
    const sortedTree = (tree) =>
      printTree(
        new Map(
          [...tree.entries()].sort(
            ([a], [b]) => ORDER.indexOf(a) - ORDER.indexOf(b)
          )
        )
      );
    const entryText = (state) => {
      const entry = sortedTree(state.tree);
      if (state.lazy)
        return P.printLazyEntry(
          state.lazy.parameters,
          [...state.lazy.prelude, ...state.prelude],
          entry
        );
      return entry;
    };
    const statics = [];
    const groups = [];
    for (const state of this.targets.values())
      if (state.target.model !== undefined)
        statics.push([state.target.model, entryText(state)]);
      else
        groups.push(
          // Parenthesized: the entry may be an arrow's concise body.
          state.target.template.replace(ENTRY, `(${sortedTree(state.tree)})`)
        );
    if (!(statics.length || groups.length)) return [];
    if (statics.length && groups.length) {
      flags.push(
        `models named one by one and models built per list cannot be merged: two ${this.kind} parts, check no model is in both`
      );
      return [printPart(printObject(statics)), ...groups.map(printPart)];
    }
    if (groups.length > 1)
      flags.push(
        `several per-model lists: one ${this.kind} part each, check no model is in two`
      );
    return statics.length
      ? [printPart(printObject(statics))]
      : groups.map(printPart);
  }
}

/** `rows` → the mode argument, and `root`/`related`/verbs/confine rule entries. */
function convertRows(ctx, property, rules, argEntries, flags, consts) {
  const member = "rows";
  const { P, sf } = ctx;
  const keys = membersOf(ctx, member, property, [
    "control",
    "default",
    "models",
    "verbs",
    "confine",
  ]);
  if (!keys.has("control")) refuse(member, "no `control`");
  if (!keys.has("default")) refuse(member, "no `default`");
  const controlNode = literalOf(ctx.checker, keys.get("control"));
  // The control's name as an `args` key and as `arg(…)` reads it.
  const control = isStringLike(controlNode)
    ? { key: controlNode.text, text: printString(controlNode.text) }
    : {
        key: `[${keys.get("control").getText(sf)}]`,
        text: keys.get("control").getText(sf),
      };
  const fallback = keys.get("default");

  // Verbs first: their predicates are what modes name.
  const verbs = new Map();
  if (keys.has("verbs"))
    for (const { target, entry } of modelEntries(
      ctx,
      "rows.verbs",
      keys.get("verbs")
    )) {
      let literal = literalOf(ctx.checker, entry);
      let lazy;
      if (ts.isArrowFunction(literal) || ts.isFunctionExpression(literal)) {
        if (target.model === undefined)
          refuse("rows.verbs", "a lazy entry inside a per-model list");
        const fn = literal;
        const prelude = [];
        if (ts.isBlock(fn.body)) {
          const list = fn.body.statements;
          const last = list.at(-1);
          if (
            !(last && ts.isReturnStatement(last) && last.expression) ||
            ownReturns(fn).length !== 1
          )
            refuse(
              "rows.verbs",
              `the lazy entry of \`${target.model}\` does not end in its one return`
            );
          for (const statement of list.slice(0, -1))
            prelude.push(statement.getText(sf));
          literal = unwrap(last.expression).inner;
        } else literal = unwrap(fn.body).inner;
        lazy = {
          parameters: fn.parameters.map((p) => p.getText(sf)).join(", "),
          prelude,
        };
      }
      if (!ts.isObjectLiteralExpression(literal))
        refuse(
          "rows.verbs",
          `the entry of \`${target.model ?? target.list}\` is not an object literal`
        );
      const members = new Map();
      for (const p of literal.properties) {
        const key = nameOf(p.name);
        const value = valueNodeOf(ctx.checker, p);
        if (!value || key === undefined)
          refuse("rows.verbs", "a spread, a method or a computed key");
        members.set(key, value);
      }
      verbs.set(targetKey(target), {
        target,
        members,
        lazy,
        uses: new Map(),
        texts: new Map(),
      });
    }

  const predicateOf = (target, nameNode, place) => {
    if (!isStringLike(nameNode)) return undefined;
    const state = verbs.get(targetKey(target));
    const predicates =
      state?.members.get("predicates") &&
      literalOf(ctx.checker, state.members.get("predicates"));
    const found =
      predicates && ts.isObjectLiteralExpression(predicates)
        ? predicates.properties.find((p) => nameOf(p.name) === nameNode.text)
        : undefined;
    const node = found && valueNodeOf(ctx.checker, found);
    if (!node)
      refuse(
        member,
        `${place} names a predicate \`${nameNode.text}\` its model's verbs do not declare`
      );
    return { state, name: nameNode.text, node };
  };
  // Count each predicate's uses, to inline those used once.
  const countUse = (target, nameNode, place) => {
    const found = predicateOf(target, nameNode, place);
    if (found)
      found.state.uses.set(
        found.name,
        (found.state.uses.get(found.name) ?? 0) + 1
      );
  };
  const modeTargets = keys.has("models")
    ? modelEntries(ctx, "rows.models", keys.get("models"))
    : [];
  const modeObjects = modeTargets.map(({ target, entry }) => {
    const modes = literalOf(ctx.checker, entry);
    if (!ts.isObjectLiteralExpression(modes))
      refuse(
        member,
        `the modes of \`${target.model ?? target.list}\` are not an object literal`
      );
    return { target, modes };
  });
  for (const { target, modes } of modeObjects)
    for (const mode of modes.properties) {
      const modeValue = valueNodeOf(ctx.checker, mode);
      const filters = modeValue && literalOf(ctx.checker, modeValue);
      if (!(filters && ts.isObjectLiteralExpression(filters)))
        refuse(member, "a mode is not an object literal");
      for (const p of filters.properties) {
        const key = nameOf(p.name);
        const value = valueNodeOf(ctx.checker, p);
        if (!value || (key !== "root" && key !== "related"))
          refuse(
            member,
            `a mode holds \`${key ?? p.getText(sf).slice(0, 30)}\`, not root or related`
          );
        countUse(target, value, `mode ${nameOf(mode.name)}.${key}`);
      }
    }
  const VERB_REFS = ["read", "update", "delete", "place"];
  const FIELD_REFS = ["writes", "moves", "reads"];
  for (const state of verbs.values()) {
    // `update` and `writes` are read twice: as `where` and as the re-judgement `check`.
    for (const key of VERB_REFS)
      if (state.members.has(key))
        for (let i = key === "update" ? 2 : 1; i > 0; i--)
          countUse(state.target, state.members.get(key), `verbs.${key}`);
    for (const key of FIELD_REFS) {
      const map =
        state.members.get(key) &&
        literalOf(ctx.checker, state.members.get(key));
      if (map && ts.isObjectLiteralExpression(map))
        for (const p of map.properties)
          if (valueNodeOf(ctx.checker, p))
            for (let i = key === "writes" ? 2 : 1; i > 0; i--)
              countUse(
                state.target,
                valueNodeOf(ctx.checker, p),
                `verbs.${key}`
              );
    }
    const evidence =
      state.members.get("evidence") &&
      skipParens(state.members.get("evidence"));
    if (evidence && ts.isObjectLiteralExpression(evidence)) {
      const names = evidence.properties.find((p) => nameOf(p.name) === "names");
      if (
        names &&
        ts.isPropertyAssignment(names) &&
        ts.isArrayLiteralExpression(unwrap(names.initializer).inner)
      )
        for (const element of unwrap(names.initializer).inner.elements)
          countUse(state.target, element, "verbs.evidence");
    }
  }

  /** A predicate's text where it is used: inlined, or its shared const. */
  const predicate = (target, nameNode, place) => {
    if (!isStringLike(nameNode))
      return filterText(ctx, member, nameNode, flags);
    const { state, name, node } = predicateOf(target, nameNode, place);
    if (!state.texts.has(name)) {
      const text = filterText(ctx, member, node, flags);
      // Inside a per-model call there is no place to declare one: inlined.
      if (
        (state.uses.get(name) ?? 0) < 2 ||
        target.model === undefined ||
        !(state.lazy || consts.canHoist(node))
      )
        state.texts.set(name, text);
      else {
        const constName = consts.fresh(
          target.model !== undefined
            ? camel(`${target.model} ${name}`)
            : camel(name)
        );
        const declaration = P.printConst(constName, text);
        if (state.lazy) rules.target(target).prelude.push(declaration);
        else consts.declare(declaration, node);
        state.texts.set(name, constName);
      }
    }
    return state.texts.get(name);
  };

  // The mode argument.
  const modeNames = modeObjects.length
    ? modeObjects[0].modes.properties.map((p) => nameOf(p.name))
    : [
        isStringLike(literalOf(ctx.checker, fallback))
          ? literalOf(ctx.checker, fallback).text
          : refuse(member, "no model and a `default` the file does not write"),
      ];
  for (const { modes } of modeObjects) {
    const names = modes.properties.map((p) => nameOf(p.name));
    if (names.join() !== modeNames.join())
      flags.push(
        "models declare different modes: the argument takes the first model's"
      );
  }
  argEntries.push([
    control.key,
    P.printArgDeclaration({
      base: { oneOf: modeNames.map(printString) },
      fallback: fallback.getText(sf),
    }),
  ]);

  for (const { target, modes } of modeObjects) {
    rules.target(target);
    for (const mode of modes.properties) {
      const filters = literalOf(ctx.checker, valueNodeOf(ctx.checker, mode));
      for (const p of filters.properties) {
        const key = nameOf(p.name);
        const where = predicate(
          target,
          valueNodeOf(ctx.checker, p),
          `mode ${nameOf(mode.name)}.${key}`
        );
        rules.set(
          member,
          target,
          [key],
          P.printWhen(
            P.printArg(control.text),
            printString(nameOf(mode.name)),
            where
          ),
          "conditions"
        );
      }
    }
  }

  for (const state of verbs.values()) {
    const { target, members } = state;
    const entry = rules.target(target);
    if (state.lazy) entry.lazy = state.lazy;
    const refOf = (key) => predicate(target, members.get(key), `verbs.${key}`);
    const fieldMap = (key) => {
      const map = literalOf(ctx.checker, members.get(key));
      if (!ts.isObjectLiteralExpression(map))
        refuse("rows.verbs", `\`${key}\` is not an object literal`);
      return map.properties.map((p) => {
        const value = valueNodeOf(ctx.checker, p);
        if (!value || nameOf(p.name) === undefined)
          refuse("rows.verbs", `\`${key}\` holds a spread or a computed key`);
        return [nameOf(p.name), predicate(target, value, `verbs.${key}`)];
      });
    };
    for (const key of members.keys())
      if (
        ![
          "predicates",
          ...VERB_REFS,
          ...FIELD_REFS,
          "acyclic",
          "evidence",
        ].includes(key)
      )
        refuse("rows.verbs", `\`${key}\` is not a verb the codemod reads`);
    // A verb a 1.14 entry left out matched nothing; a rule key left out adds
    // no restriction (spec §13.4): the conversion writes `nothing` for it.
    rules.set(
      member,
      target,
      ["read", "where"],
      members.has("read") ? refOf("read") : P.printNothing()
    );
    if (members.has("update")) {
      const where = refOf("update");
      rules.set(member, target, ["update", "where"], P.printOnly(where));
      rules.set(member, target, ["update", "check"], where, "checks");
    } else if (!members.has("writes"))
      rules.set(
        member,
        target,
        ["update", "where"],
        P.printOnly(P.printNothing())
      );
    rules.set(
      member,
      target,
      ["delete", "where"],
      P.printOnly(members.has("delete") ? refOf("delete") : P.printNothing())
    );
    if (members.has("place"))
      rules.set(member, target, ["create", "check"], refOf("place"), "checks");
    if (members.has("writes"))
      for (const [field, where] of fieldMap("writes")) {
        rules.set(
          member,
          target,
          ["update", "fields", field, "where"],
          P.printOnly(where)
        );
        rules.set(
          member,
          target,
          ["update", "fields", field, "check"],
          where,
          "checks"
        );
      }
    if (members.has("moves"))
      for (const [field, where] of fieldMap("moves"))
        rules.set(
          member,
          target,
          ["update", "fields", field, "check"],
          where,
          "checks"
        );
    if (members.has("reads"))
      for (const [field, where] of fieldMap("reads"))
        rules.set(
          member,
          target,
          ["read", "fields", field],
          P.printGate(where)
        );
    if (members.has("acyclic"))
      rules.set(
        member,
        target,
        ["acyclic"],
        members.get("acyclic").getText(sf)
      );
    if (members.has("evidence")) {
      const evidence = skipParens(members.get("evidence"));
      if (!ts.isObjectLiteralExpression(evidence))
        refuse("rows.verbs", "`evidence` is not an object literal");
      const fieldsOf = new Map(
        evidence.properties.map((p) => [nameOf(p.name), p])
      );
      const as = fieldsOf.get("as");
      const names = fieldsOf.get("names");
      const ordered = fieldsOf.get("ordered");
      const namesList =
        names && ts.isPropertyAssignment(names)
          ? unwrap(names.initializer).inner
          : undefined;
      if (
        !(
          as &&
          ts.isPropertyAssignment(as) &&
          isStringLike(as.initializer) &&
          namesList &&
          ts.isArrayLiteralExpression(namesList)
        )
      )
        refuse("rows.verbs", "`evidence` has no literal `as` and `names`");
      const isOrdered =
        ordered &&
        ts.isPropertyAssignment(ordered) &&
        ordered.initializer.kind === S.TrueKeyword;
      if (isOrdered)
        flags.push(
          "`evidence.ordered` has no spelling in spec v0: written as facts(…, { ordered: true })"
        );
      rules.set(
        member,
        target,
        ["read", "select", as.initializer.text],
        P.printFacts(
          namesList.elements.map((element) => [
            element.text,
            predicate(target, element, "verbs.evidence"),
          ]),
          isOrdered
        )
      );
    }
    if (members.has("update") || members.has("writes"))
      flags.push(
        "an updated row was judged again by the predicates that took it: written as update.check / fields[f].check, check whether `read` belongs in it"
      );
  }

  if (keys.has("confine"))
    for (const { target, entry } of modelEntries(
      ctx,
      "rows.confine",
      keys.get("confine")
    ))
      rules.set(
        member,
        target,
        ["confine"],
        filterText(ctx, member, entry, flags)
      );

  const named = [...modeTargets, ...[...verbs.values()]].map(
    ({ target }) => target
  );
  return named;
}

function convertData(ctx, property, rules, flags) {
  const member = "data";
  const models = membersOf(ctx, member, property, ["models"]).get("models");
  if (!models) refuse(member, "no `models`");
  const named = [];
  for (const { target, entry } of modelEntries(ctx, member, models)) {
    const stamps = literalOf(ctx.checker, entry);
    if (!ts.isObjectLiteralExpression(stamps))
      refuse(member, "an entry is not an object literal");
    for (const p of stamps.properties) {
      const key = nameOf(p.name);
      const value = valueNodeOf(ctx.checker, p);
      if (!value || (key !== "create" && key !== "update"))
        refuse(member, `\`${key ?? "…"}\` is not create or update`);
      rules.set(member, target, [key], dataText(ctx, member, value, flags));
    }
    rules.target(target);
    named.push(target);
  }
  return named;
}

function convertDeletion(ctx, property, rules, flags) {
  const member = "deletion";
  const { P, sf } = ctx;
  const keys = membersOf(ctx, member, property, ["removeWhen", "models"]);
  let removeWhen;
  if (keys.has("removeWhen")) {
    const condition = literalOf(ctx.checker, keys.get("removeWhen"));
    if (
      !ts.isObjectLiteralExpression(condition) ||
      condition.properties.length !== 1 ||
      !ts.isPropertyAssignment(condition.properties[0])
    )
      refuse(member, "`removeWhen` does not name exactly one control");
    const [entry] = condition.properties;
    removeWhen = {
      control: nameOf(entry.name),
      value: P.printArg(printString(nameOf(entry.name))),
      test: entry.initializer.getText(sf),
    };
  }
  if (!keys.has("models")) refuse(member, "no `models`");
  const named = [];
  for (const { target, entry } of modelEntries(
    ctx,
    member,
    keys.get("models")
  )) {
    const spec = literalOf(ctx.checker, entry);
    if (!ts.isObjectLiteralExpression(spec))
      refuse(member, "an entry is not an object literal");
    const parts = [];
    for (const p of spec.properties) {
      const key = nameOf(p.name);
      const value = valueNodeOf(ctx.checker, p);
      if (!value) refuse(member, "an entry holds a spread or a method");
      if (key === "at") {
        const at = literalOf(ctx.checker, value);
        if (!isStringLike(at))
          refuse(member, "`at` is not a string the file writes");
        parts.push(`${printKey(at.text)}: ${P.printNow()}`);
      } else if (key === "assign") {
        const assign = literalOf(ctx.checker, value);
        if (ts.isObjectLiteralExpression(assign)) {
          const text = dataText(ctx, member, assign, flags).trim();
          const inside = text.slice(1, -1).trim();
          if (inside) parts.push(inside.replace(TRAILING_COMMA, ""));
        } else parts.push(`...${opaque(ctx, member, value, true, flags)}`);
      } else refuse(member, `\`${key}\` is not at or assign`);
    }
    rules.set(
      member,
      target,
      ["delete", "instead"],
      P.printDeleteInstead(`{ ${parts.join(", ")} }`, removeWhen)
    );
    named.push(target);
  }
  return { named, removeWhen };
}

function convertOrder(ctx, property, rules) {
  const member = "order";
  const models = membersOf(ctx, member, property, ["models"]).get("models");
  if (!models) refuse(member, "no `models`");
  for (const { target, entry } of modelEntries(ctx, member, models))
    rules.set(member, target, ["orderBy"], entry.getText(ctx.sf));
}

/** A member whose value is an object literal: its properties by name. */
function membersOf(ctx, member, property, allowed) {
  const value = valueNodeOf(ctx.checker, property);
  if (!value) refuse(member, "a method or an accessor");
  const literal = literalOf(ctx.checker, value);
  if (!ts.isObjectLiteralExpression(literal))
    refuse(
      member,
      `\`${literal.getText(ctx.sf).slice(0, 40)}\` is not an object literal`
    );
  const found = new Map();
  for (const p of literal.properties) {
    const key = nameOf(p.name);
    const inner = valueNodeOf(ctx.checker, p);
    if (!(inner && allowed.includes(key)))
      refuse(
        member,
        `\`${key ?? p.getText(ctx.sf).slice(0, 30)}\` is not a ${member} key the codemod reads`
      );
    found.set(key, inner);
  }
  return found;
}

/** `controls` → `args` entries, with what `deletion` and the models named add. */
function convertControls(ctx, property, removeWhen, requiredModels) {
  const member = "controls";
  const { P, sf } = ctx;
  const value = valueNodeOf(ctx.checker, property);
  const literal = value && literalOf(ctx.checker, value);
  if (!(literal && ts.isObjectLiteralExpression(literal)))
    refuse(member, "not an object literal the file writes");
  const entries = [];
  const flags = [];
  for (const p of literal.properties) {
    const name = nameOf(p.name);
    const held = valueNodeOf(ctx.checker, p);
    if (!held || name === undefined)
      refuse(member, "a spread, a method or a computed key");
    const declaration = literalOf(ctx.checker, held);
    if (!ts.isObjectLiteralExpression(declaration))
      refuse(member, `\`${name}\` is not an object literal`);
    const spec = {};
    for (const q of declaration.properties) {
      const key = nameOf(q.name);
      if (!ts.isPropertyAssignment(q))
        refuse(member, `\`${name}\` holds a spread or a method`);
      const value = q.initializer;
      const flag = () => {
        if (value.kind === S.TrueKeyword) return true;
        if (value.kind === S.FalseKeyword) return false;
        refuse(member, `\`${name}.${key}\` is not true or false`);
      };
      if (key === "oneOf") {
        const list = literalOf(ctx.checker, value);
        spec.base = ts.isArrayLiteralExpression(list)
          ? { oneOf: list.elements.map((element) => element.getText(sf)) }
          : { oneOfSpread: value.getText(sf) };
      } else if (key === "schema") spec.base = { schema: value.getText(sf) };
      else if (key === "on") {
        if (isStringLike(value)) {
          if (value.text === "reads" || value.text === "writes")
            spec.on = P.printPlacement(value.text);
          else if (value.text !== "all")
            refuse(member, `\`${name}.on\` is "${value.text}"`);
        } else spec.on = value.getText(sf);
      } else if (key === "required") spec.required = flag();
      else if (key === "bound") spec.bound = flag();
      else if (key === "uncacheable") spec.volatile = flag();
      else refuse(member, `\`${name}.${key}\` is not a control key`);
    }
    if (!spec.base) refuse(member, `\`${name}\` has neither oneOf nor schema`);
    if (removeWhen?.control === name) {
      spec.on = P.printPlacement("deletes");
      spec.models = requiredModels.deleted;
    }
    if (spec.required) {
      spec.required = requiredModels.all ?? true;
      if (requiredModels.unknown)
        flags.push(
          `\`${name}\` is required on models a call builds from a list not written here: .required() now asks for it on every model`
        );
    }
    entries.push([name, P.printArgDeclaration(spec)]);
  }
  return { entries, flags };
}

// =============================================================================
// ONE DEFINITION
// =============================================================================

const MEMBERS = new Set([
  "name",
  "request",
  "query",
  "statement",
  "observe",
  "observes",
  "written",
  "retry",
  "route",
  "transaction",
  "controls",
  "rows",
  "deletion",
  "data",
  "order",
  "result",
  "client",
  "model",
]);

/**
 * Convert one definition literal. Answers the replacement text, the shared
 * predicates to declare above it, and the flags; throws `Untouched`.
 */
function convertDefinition(ctx, site) {
  const { P, sf } = ctx;
  const members = new Map();
  // A spread of a definition the file writes is read member by member; a
  // later member replaces an earlier one, as the spread did.
  const collect = (literal, depth) => {
    for (const property of literal.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = literalOf(ctx.checker, property.expression);
        if (!ts.isObjectLiteralExpression(spread) || depth > 4)
          refuse(
            "...",
            `spreads \`${property.expression.getText(sf).slice(0, 40)}\` into the definition`
          );
        collect(spread, depth + 1);
        continue;
      }
      const key = nameOf(property.name);
      if (key === undefined) refuse("?", "a computed member name");
      if (!MEMBERS.has(key)) refuse(key, "not a member of the 1.14 contract");
      if (ts.isGetAccessor(property) || ts.isSetAccessor(property))
        refuse(key, "an accessor");
      members.delete(key);
      members.set(key, property);
    }
  };
  collect(site.literal, 0);
  const nameProperty = members.get("name");
  if (!nameProperty) refuse("name", "the definition has no name");
  const nameText = ts.isShorthandPropertyAssignment(nameProperty)
    ? nameProperty.name.text
    : ts.isPropertyAssignment(nameProperty)
      ? nameProperty.initializer.getText(sf)
      : refuse("name", "not a property");

  const flags = [];
  const parts = [];
  const add = (results) => {
    for (const { text, flags: partFlags } of results) {
      flags.push(...partFlags);
      parts.push(partFlags.map(P.printFlag).join("") + text);
    }
  };
  const declared = [];
  const consts = {
    fresh: (base) => {
      let name = base;
      for (let i = 2; ctx.taken.has(name); i++) name = `${base}${i}`;
      ctx.taken.add(name);
      return name;
    },
    declare: (text, node) => declared.push({ text, node }),
    /**
     * A shared predicate goes above the statement that holds the definition:
     * not when it reads a binding declared inside that statement (a
     * parameter of the helper that builds the definition). It is inlined then.
     */
    canHoist: (node) => {
      const statement = enclosingStatement(site.replace);
      let free = true;
      const visit = (n) => {
        if (ts.isIdentifier(n)) {
          const declaration =
            ctx.checker.getSymbolAtLocation(n)?.declarations?.[0];
          if (
            declaration &&
            declaration.getStart(sf) >= statement.getStart(sf) &&
            declaration.getEnd() <= statement.getEnd() &&
            !(
              declaration.getStart(sf) >= node.getStart(sf) &&
              declaration.getEnd() <= node.getEnd()
            )
          )
            free = false;
        }
        ts.forEachChild(n, visit);
      };
      visit(node);
      return free;
    },
  };
  const rules = new Rules();
  // `data` and `order` hold when the caller says nothing: a `defaults` part (D13).
  const defaults = new Rules("defaults");
  const argEntries = [];
  const argFlags = [];
  const ruleFlags = [];
  const named = [];
  let deletion;
  if (members.has("rows"))
    named.push(
      ...convertRows(
        ctx,
        members.get("rows"),
        rules,
        argEntries,
        ruleFlags,
        consts
      )
    );
  if (members.has("data"))
    named.push(...convertData(ctx, members.get("data"), defaults, ruleFlags));
  if (members.has("deletion")) {
    deletion = convertDeletion(ctx, members.get("deletion"), rules, ruleFlags);
    named.push(...deletion.named);
  }
  if (members.has("order")) convertOrder(ctx, members.get("order"), defaults);
  const listOf = (targets) => {
    const names = [
      ...new Set(
        targets.filter((t) => t.model !== undefined).map((t) => t.model)
      ),
    ];
    const groups = targets.filter((t) => t.model === undefined);
    if (groups.some((t) => t.list === undefined)) return undefined;
    const lists = [...new Set(groups.map((t) => t.list))];
    return names.length || lists.length
      ? P.printModelList(names, lists)
      : undefined;
  };

  if (members.has("controls")) {
    const controls = convertControls(
      ctx,
      members.get("controls"),
      deletion?.removeWhen,
      {
        all: listOf(named),
        unknown: named.some(
          (t) => t.model === undefined && t.list === undefined
        ),
        deleted: deletion && listOf(deletion.named),
      }
    );
    argEntries.unshift(...controls.entries);
    if (controls.flags.length) {
      flags.push(...controls.flags);
      argFlags.push(...controls.flags);
    }
  } else if (deletion?.removeWhen)
    refuse(
      "deletion",
      "`removeWhen` names a control this definition does not declare"
    );
  if (argEntries.length)
    parts.push(argFlags.map(P.printFlag).join("") + P.printArgs(argEntries));
  if (members.has("request"))
    add(convertHandlerMember(ctx, "request", members.get("request")));
  if (members.has("query"))
    add(convertHandlerMember(ctx, "query", members.get("query")));
  if (members.has("written")) add(convertWritten(ctx, members.get("written")));
  if (members.has("retry")) add(convertRetry(ctx, members.get("retry")));
  if (members.has("route")) add(convertRoute(ctx, members.get("route")));
  if (members.has("transaction"))
    add(convertTransaction(ctx, members.get("transaction")));
  if (members.has("statement"))
    add(convertStatement(ctx, members.get("statement")));
  if (members.has("observe"))
    add(convertObserve(ctx, members.get("observe"), members.has("observes")));
  else if (members.has("observes"))
    refuse("observes", "`observes` without an observer");
  const rulePrintFlags = [];
  const ruleParts = [
    ...rules.print(P, rulePrintFlags),
    ...defaults.print(P, rulePrintFlags),
  ];
  const allRuleFlags = [...new Set([...ruleFlags, ...rulePrintFlags])];
  ruleParts.forEach((part, index) => {
    parts.push(
      (index === 0 ? allRuleFlags.map(P.printFlag).join("") : "") + part
    );
  });
  flags.push(...allRuleFlags);
  const methodMembers = [];
  if (members.has("client")) {
    const client = members.get("client");
    if (
      ts.isMethodDeclaration(client) ||
      ts.isShorthandPropertyAssignment(client)
    )
      methodMembers.push(client.getText(sf));
    else if (ts.isPropertyAssignment(client))
      methodMembers.push(`client: ${client.initializer.getText(sf)}`);
    else refuse("client", "an accessor");
  }
  if (members.has("model")) {
    const model = members.get("model");
    if (ts.isShorthandPropertyAssignment(model))
      methodMembers.push("models: model");
    else if (ts.isPropertyAssignment(model))
      methodMembers.push(`models: ${model.initializer.getText(sf)}`);
    else refuse("model", "a method or an accessor");
  }
  if (methodMembers.length) parts.push(P.printMethods(methodMembers));
  if (members.has("result")) {
    const result = members.get("result");
    if (
      !(
        ts.isPropertyAssignment(result) ||
        ts.isShorthandPropertyAssignment(result)
      )
    )
      refuse("result", "a method or an accessor");
    parts.push(
      P.printFields(
        ts.isPropertyAssignment(result)
          ? result.initializer.getText(sf)
          : result.name.text
      )
    );
  }
  return {
    text: P.printExtension(nameText, parts, site.schemaType),
    declared,
    flags: [...new Set(flags)],
  };
}

// =============================================================================
// OFFICIAL EXTENSIONS IN ONE STEP (D11, spec §11)
// =============================================================================

const OFFICIAL_STEPPED = new Set(["softDelete", "permissions", "ordering"]);
const STEPS = new Set(["rows", "methods", "keys"]);
/** The modules of `src/extensions` the old definers were imported from. */
const INTERNAL_DEFINER = /(^@extensions\/|\/extensions\/)(define|index)?/;

/** The official extensions 1.14 applied as a function of the client. */
const APPLIED = new Set(["softDelete", "permissions", "ordering", "on"]);

/** The official call a value is, directly or through a local const. */
function officialOrigin(checker, node) {
  let inner = unwrap(node).inner;
  if (ts.isIdentifier(inner)) {
    const declaration = constDeclaration(checker, inner);
    if (!declaration) return undefined;
    inner = unwrap(declaration.initializer).inner;
  }
  if (
    ts.isCallExpression(inner) &&
    ts.isIdentifier(inner.expression) &&
    OFFICIAL_STEPPED.has(inner.expression.text)
  )
    return inner.expression.text;
  return undefined;
}

/** Same value: one symbol, or the same direct call text. */
function sameValue(checker, sf, a, b) {
  if (ts.isIdentifier(a) && ts.isIdentifier(b))
    return checker.getSymbolAtLocation(a) === checker.getSymbolAtLocation(b);
  return a.getText(sf) === b.getText(sf);
}

/**
 * `.$extends(x.rows)…$extends(x.methods)` in one chain → `.$extends(x)` at
 * the `rows` step. Steps applied alone, in two statements, or as functions
 * (`x.rows(base)`) are reported, not changed.
 */
function foldSteps(sf, checker) {
  const edits = [];
  const folded = [];
  const reported = [];
  const lineOf = (node) =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const stepOf = (call) => {
    if (
      !(
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression)
      ) ||
      call.expression.name.text !== "$extends"
    )
      return undefined;
    const [argument] = call.arguments;
    const inner = argument && skipParens(argument);
    if (
      !(
        inner &&
        ts.isPropertyAccessExpression(inner) &&
        STEPS.has(inner.name.text)
      )
    )
      return undefined;
    const official = officialOrigin(checker, inner.expression);
    if (!official) return undefined;
    return {
      call,
      argument: inner,
      value: inner.expression,
      step: inner.name.text,
      official,
    };
  };
  const used = new Set();
  walk(sf, (node) => {
    const later = stepOf(node);
    if (!later || later.step === "rows") return;
    // Walk down the receiver chain for the `rows` step of the same value.
    let receiver = skipParens(node.expression.expression);
    while (
      ts.isCallExpression(receiver) &&
      ts.isPropertyAccessExpression(receiver.expression) &&
      receiver.expression.name.text === "$extends"
    ) {
      const earlier = stepOf(receiver);
      if (
        earlier?.step === "rows" &&
        sameValue(checker, sf, earlier.value, later.value)
      ) {
        edits.push({
          start: earlier.argument.getStart(sf),
          end: earlier.argument.getEnd(),
          text: earlier.value.getText(sf),
        });
        edits.push({
          start: node.expression.expression.getEnd(),
          end: node.getEnd(),
          text: "",
        });
        used.add(earlier.call);
        used.add(node);
        folded.push({
          line: lineOf(node),
          official: later.official,
          value: later.value.getText(sf),
        });
        return;
      }
      receiver = skipParens(receiver.expression.expression);
    }
  });
  walk(sf, (node) => {
    const step = stepOf(node);
    if (step && !used.has(node))
      reported.push({
        line: lineOf(node),
        official: step.official,
        why: `\`$extends(${step.argument.getText(sf)})\` has no matching ${step.step === "rows" ? "methods" : "rows"} step in its chain`,
      });
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      STEPS.has(node.expression.name.text) &&
      node.arguments.length === 1
    ) {
      const official = officialOrigin(checker, node.expression.expression);
      if (official)
        reported.push({
          line: lineOf(node),
          official,
          why: `\`${node.expression.getText(sf)}(…)\` applies a step as a function`,
        });
    }
  });
  // `defaultOmit<S>()(config)` → `defaultOmit(config)`: one call (spec §11).
  walk(sf, (node) => {
    if (
      !(
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "defaultOmit" &&
        node.arguments.length === 0
      )
    )
      return;
    const { parent } = node;
    if (ts.isCallExpression(parent) && parent.expression === node) {
      edits.push({
        start: node.getStart(sf),
        end: node.getEnd(),
        text: "defaultOmit",
      });
      folded.push({
        line: lineOf(node),
        official: "defaultOmit",
        value: "defaultOmit<S>()(…) → defaultOmit(…)",
      });
    } else
      reported.push({
        line: lineOf(node),
        official: "defaultOmit",
        why: "`defaultOmit<S>()` is held before it is called: write `defaultOmit(config)` where it is called",
      });
  });
  // An official extension applied as a function of the client
  // (`softDelete(config)(base)`, `policy(base)`) → `base.$extends(…)`; nested
  // applications are rewritten from the inside out, as one edit.
  const appliedOf = (node) => {
    if (!(ts.isCallExpression(node) && node.arguments.length === 1))
      return undefined;
    const callee = skipParens(node.expression);
    if (ts.isPropertyAccessExpression(callee)) return undefined;
    const direct =
      ts.isCallExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      APPLIED.has(callee.expression.text)
        ? callee.expression.text
        : undefined;
    const official =
      direct ??
      (ts.isIdentifier(callee) ? officialOrigin(checker, callee) : undefined);
    return official === undefined ? undefined : { callee, official };
  };
  const rewrite = (node) => {
    const applied = appliedOf(node);
    if (applied === undefined) return node.getText(sf);
    const argument = skipParens(node.arguments[0]);
    const receiver = rewrite(argument);
    const simple =
      ts.isIdentifier(argument) ||
      ts.isCallExpression(argument) ||
      ts.isPropertyAccessExpression(argument);
    return `${simple ? receiver : `(${receiver})`}.$extends(${applied.callee.getText(sf)})`;
  };
  const inside = new Set();
  walk(sf, (node) => {
    const applied = appliedOf(node);
    if (applied === undefined || inside.has(node)) return;
    let inner = skipParens(node.arguments[0]);
    while (appliedOf(inner)) {
      inside.add(inner);
      inner = skipParens(inner.arguments[0]);
    }
    edits.push({
      start: node.getStart(sf),
      end: node.getEnd(),
      text: rewrite(node),
    });
    folded.push({
      line: lineOf(node),
      official: applied.official,
      value: `${applied.callee.getText(sf).slice(0, 40)}(client) → client.$extends(…)`,
    });
  });
  return { edits, folded, reported };
}

// =============================================================================
// ONE FILE
// =============================================================================

function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  let floor = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.end > floor) continue;
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    floor = edit.start;
  }
  return out;
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

/** Where each `tracked` edit's new text lies once every edit is applied. */
function rangesAfter(edits, tracked) {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  return tracked.map((edit) => {
    let shift = 0;
    for (const other of sorted) {
      if (other.start >= edit.start) break;
      shift += other.text.length - (other.end - other.start);
    }
    return {
      start: edit.start + shift,
      end: edit.start + shift + edit.text.length,
    };
  });
}

/** The statement a definition sits in: where its shared predicates go. */
function enclosingStatement(node) {
  let current = node;
  while (
    current.parent &&
    !(
      ts.isBlock(current.parent) ||
      ts.isSourceFile(current.parent) ||
      ts.isModuleBlock(current.parent) ||
      ts.isCaseClause(current.parent) ||
      ts.isDefaultClause(current.parent)
    )
  )
    current = current.parent;
  return current;
}

const ROOT_SPECIFIER = /^(viborm|@src|@src\/index|(\.\.?\/)+(src(\/index)?)?)$/;
const REMOVABLE = [
  "defineExtension",
  "defineHooks",
  "enableExtensions",
  "ClientExtension",
];

/** Where a file's new words come from. */
function wordSpecifier(sf, fallback) {
  let root;
  for (const statement of sf.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      )
    )
      continue;
    const specifier = statement.moduleSpecifier.text;
    const named = statement.importClause?.namedBindings;
    if (
      named &&
      ts.isNamedImports(named) &&
      named.elements.some(
        (e) =>
          DEFINERS.has((e.propertyName ?? e.name).text) ||
          (e.propertyName ?? e.name).text === "enableExtensions"
      ) &&
      // The builders are public names: an internal module that held the old
      // definers does not export them.
      !INTERNAL_DEFINER.test(specifier)
    )
      return specifier;
    if (!root && ROOT_SPECIFIER.test(specifier)) root = specifier;
  }
  return root ?? fallback;
}

/**
 * Convert one TypeScript text. `area` picks the default specifier
 * (`viborm` for docs, `@src/index` elsewhere); `importsOnlyIfAny` adds no
 * import to a text that has none (a documentation snippet).
 */
export function convertSource(
  text,
  {
    fileName = "file.ts",
    area = "tests",
    importsOnlyIfAny = false,
    lineOffset = 0,
  } = {}
) {
  const first = parse(text, fileName);
  const taken = identifierNames(first.sf);
  const words = wordTable();
  const P = printers(words.w);
  const specifier = wordSpecifier(
    first.sf,
    area === "docs" ? "viborm" : "@src/index"
  );
  const definitions = [];
  const lineOf = (sf, node) =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 + lineOffset;

  // D11 first: one-step official extensions.
  const steps = foldSteps(first.sf, first.checker);
  let current = applyEdits(text, steps.edits);
  let unresolved = [];
  // A later pass reads only the text an earlier one wrote: the definitions
  // nested in a converted one.
  let scope;
  for (let pass = 1; pass <= 4; pass++) {
    const { sf, checker } = parse(current, fileName);
    const found = findSites(sf, checker);
    if (pass === 1)
      unresolved = found.unresolved.map((u) => ({
        ...u,
        line: u.line + lineOffset,
      }));
    const ctx = { sf, checker, P, words, taken };
    const edits = [];
    const inserts = new Map();
    let converted = 0;
    const sites = found.sites.sort(
      (a, b) => a.replace.getStart(sf) - b.replace.getStart(sf)
    );
    const claimed = [];
    const written = [];
    for (const site of sites) {
      const range = {
        start: site.replace.getStart(sf),
        end: site.replace.getEnd(),
      };
      if (
        scope &&
        !scope.some(
          (outer) => range.start >= outer.start && range.end <= outer.end
        )
      )
        continue;
      if (claimed.some((other) => overlaps(other, range))) continue;
      const record = {
        line: lineOf(sf, site.literal),
        pass,
        origin: site.origin,
        before: sf.text.slice(range.start, range.end),
      };
      try {
        const result = convertDefinition(ctx, site);
        const siteEdits = [{ ...range, text: result.text }, ...site.edits];
        if (
          siteEdits.some((edit) => edits.some((other) => overlaps(other, edit)))
        )
          continue;
        edits.push(...siteEdits);
        written.push(siteEdits[0]);
        claimed.push(range);
        if (result.declared.length) {
          const statement = enclosingStatement(site.replace);
          const [comment] =
            ts.getLeadingCommentRanges(sf.text, statement.getFullStart()) ?? [];
          const at = comment ? comment.pos : statement.getStart(sf);
          inserts.set(at, [
            ...(inserts.get(at) ?? []),
            ...result.declared.map((d) => d.text),
          ]);
        }
        converted++;
        definitions.push({
          ...record,
          status: result.flags.length ? "flagged" : "converted",
          flags: result.flags,
          after: result.text,
          declared: result.declared.map((d) => d.text),
        });
      } catch (error) {
        if (!(error instanceof Untouched)) throw error;
        claimed.push(range);
        definitions.push({
          ...record,
          status: "untouched",
          member: error.member,
          reason: error.reason,
        });
      }
    }
    for (const [at, texts] of inserts)
      edits.push({ start: at, end: at, text: `${texts.join("\n")}\n` });
    scope = rangesAfter(edits, written);
    current = applyEdits(current, edits);
    if (converted === 0) break;
  }

  const changed = current !== text;
  if (changed) {
    current = words.resolve(current, fileName, specifier);
    const named = (snippet) =>
      snippet.replace(PLACEHOLDER, (_, word) => words.local.get(word));
    for (const definition of definitions) {
      if (definition.after) definition.after = named(definition.after);
      if (definition.declared)
        definition.declared = definition.declared.map(named);
    }
  }
  if (changed || ENABLE_CALL.test(current))
    current = fixImports(current, fileName, words, specifier, importsOnlyIfAny);
  return {
    text: current,
    changed: current !== text,
    definitions,
    unresolved,
    steps: {
      folded: steps.folded.map((s) => ({ ...s, line: s.line + lineOffset })),
      reported: steps.reported.map((s) => ({
        ...s,
        line: s.line + lineOffset,
      })),
    },
    syntaxErrors: parse(current, fileName).syntaxErrors.length,
  };
}

/** Remove what the old contract imported and no longer used; import the words. */
function fixImports(source, fileName, words, specifier, importsOnlyIfAny) {
  let { sf } = parse(source, fileName);
  const edits = [];
  // enableExtensions() calls go.
  walk(sf, (node) => {
    if (
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "enableExtensions"
    )
      edits.push({ start: node.getFullStart(), end: node.getEnd(), text: "" });
  });
  // A binder nothing calls any more goes.
  const references = new Map();
  walk(sf, (node) => {
    if (
      ts.isIdentifier(node) &&
      !ts.isImportSpecifier(node.parent) &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
    )
      references.set(node.text, (references.get(node.text) ?? 0) + 1);
  });
  for (const statement of sf.statements)
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.length === 1
    ) {
      const [declaration] = statement.declarationList.declarations;
      const init = declaration.initializer;
      if (
        init &&
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === "defineExtension" &&
        init.arguments.length === 0 &&
        ts.isIdentifier(declaration.name) &&
        !references.has(declaration.name.text)
      ) {
        edits.push({
          start: statement.getFullStart(),
          end: statement.getEnd(),
          text: "",
        });
        references.set(
          "defineExtension",
          (references.get("defineExtension") ?? 1) - 1
        );
      }
    }
  const text = applyEdits(source, edits);
  ({ sf } = parse(text, fileName));
  const counts = new Map();
  walk(sf, (node) => {
    if (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent))
      counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
  });
  const importEdits = [];
  let target;
  let lastImport;
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    lastImport = statement;
    const named = statement.importClause?.namedBindings;
    if (!(named && ts.isNamedImports(named))) continue;
    const kept = named.elements.filter(
      (element) =>
        !(
          REMOVABLE.includes((element.propertyName ?? element.name).text) &&
          !counts.has(element.name.text)
        )
    );
    if (
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === specifier &&
      !statement.importClause.isTypeOnly &&
      !target
    )
      target = { statement, named, kept };
    else if (kept.length !== named.elements.length) {
      if (kept.length === 0 && !statement.importClause.name)
        importEdits.push({
          start: statement.getFullStart(),
          end: statement.getEnd(),
          text: "",
        });
      else
        importEdits.push({
          start: named.getStart(sf),
          end: named.getEnd(),
          text: `{ ${kept.map((e) => e.getText(sf)).join(", ")} }`,
        });
    }
  }
  // A word is imported already only under the name the printers used.
  const already = new Set(
    target
      ? target.named.elements
          .filter((e) => !e.isTypeOnly)
          .map((e) => `${(e.propertyName ?? e.name).text} ${e.name.text}`)
      : []
  );
  const wanted = WORDS.filter(
    (word) =>
      words.used.has(word) && !already.has(`${word} ${words.local.get(word)}`)
  );
  const specifiers = wanted.map((word) =>
    words.local.get(word) === word
      ? word
      : `${word} as ${words.local.get(word)}`
  );
  const hasImports = Boolean(lastImport);
  if (target) {
    const all = [...target.kept.map((e) => e.getText(sf)), ...specifiers];
    if (all.length === 0 && !target.statement.importClause.name)
      importEdits.push({
        start: target.statement.getFullStart(),
        end: target.statement.getEnd(),
        text: "",
      });
    else
      importEdits.push({
        start: target.named.getStart(sf),
        end: target.named.getEnd(),
        text: `{ ${all.join(", ")} }`,
      });
  } else if (specifiers.length && (hasImports || !importsOnlyIfAny)) {
    const line = `import { ${specifiers.join(", ")} } from ${printString(specifier)};\n`;
    const at = lastImport ? lastImport.getEnd() : 0;
    importEdits.push({
      start: at,
      end: at,
      text: lastImport ? `\n${line.trimEnd()}` : line,
    });
  }
  return applyEdits(text, importEdits);
}

// =============================================================================
// MARKDOWN: fenced TypeScript blocks
// =============================================================================

const FENCE = /^(\s*)(`{3,}|~{3,})(ts|typescript|tsx)\b(.*)$/;

/** Convert each fenced `ts` block of a .md/.mdx text; a block that does not parse is skipped. */
export function convertMarkdown(text) {
  const lines = text.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]);
    if (!open) continue;
    const [, indent, fence, lang] = open;
    let end = i + 1;
    while (
      end < lines.length &&
      !(
        lines[end].trim().startsWith(fence) &&
        lines[end].trim().replace(/[`~]/g, "") === ""
      )
    )
      end++;
    if (end >= lines.length) break;
    blocks.push({ start: i + 1, end, indent, lang });
    i = end;
  }
  const results = [];
  for (const block of blocks.reverse()) {
    const body = lines
      .slice(block.start, block.end)
      .map((line) =>
        line.startsWith(block.indent)
          ? line.slice(block.indent.length)
          : line.trimStart()
      );
    const source = body.join("\n");
    if (!MENTION.test(source)) continue;
    const fileName = block.lang === "tsx" ? "block.tsx" : "block.ts";
    if (parse(source, fileName).syntaxErrors.length) {
      results.push({ line: block.start, skipped: true });
      continue;
    }
    const converted = convertSource(source, {
      fileName,
      area: "docs",
      importsOnlyIfAny: true,
      lineOffset: block.start,
    });
    results.push({
      line: block.start,
      skipped: false,
      lang: block.lang,
      ...converted,
      source,
    });
    if (converted.changed) {
      const replaced = converted.text
        .split("\n")
        .map((line) => (line ? block.indent + line : line));
      lines.splice(block.start, block.end - block.start, ...replaced);
    }
  }
  return { text: lines.join("\n"), blocks: results.reverse() };
}

// =============================================================================
// COMMAND LINE AND REPORT
// =============================================================================

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = /\.(ts|mts|tsx)$/;
const MARKDOWN = /\.(md|mdx)$/;
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".scratch",
  ".git",
  ".claude",
  "coverage",
]);
const MENTION =
  /\$extends|defineExtension|defineHooks|enableExtensions|softDelete\(|ordering\(|permissions\(/;

function filesOf(paths) {
  const out = new Set();
  const visit = (path) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path))
        if (!SKIP_DIRS.has(name)) visit(join(path, name));
    } else if (
      (SOURCE.test(path) && !path.endsWith(".d.ts")) ||
      MARKDOWN.test(path)
    )
      out.add(resolve(path));
  };
  for (const path of paths) {
    if (existsSync(path)) visit(path);
    else
      for (const match of globSync(path, { cwd: ROOT }))
        visit(resolve(ROOT, match));
  }
  return [...out].sort();
}

const BIOME = join(ROOT, "node_modules/.bin/biome");

/** Format files of the repository in place. */
function biomeFormat(files) {
  if (!files.length) return { ok: true, output: "" };
  const result = spawnSync(BIOME, ["format", "--write", ...files], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout}${result.stderr}`,
  };
}

/**
 * Format one file wherever it lies (the configuration ignores `.scratch/`):
 * through stdin, under a neutral name, with the repository's configuration.
 */
function biomeFormatCopy(path) {
  const name = path.endsWith(".tsx") ? "codemod-check.tsx" : "codemod-check.ts";
  const input = readFileSync(path, "utf8");
  // A block whose only content was `enableExtensions()` is left empty.
  if (input.trim() === "") return { ok: true, output: "", empty: true };
  // The file itself is stdin: a piped input past 64 kB deadlocks spawnSync
  // against Biome.
  const stdin = openSync(path, "r");
  const result = spawnSync(BIOME, ["format", `--stdin-file-path=${name}`], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: [stdin, "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  closeSync(stdin);
  if (result.status === 0 && result.stdout) writeFileSync(path, result.stdout);
  const output = result.error
    ? `biome did not answer: ${result.error.message}`
    : `${result.stderr}`;
  return { ok: result.status === 0 && Boolean(result.stdout), output };
}

function parseArgs(argv) {
  const options = {
    mode: "dry",
    report: undefined,
    out: undefined,
    examples: [],
    format: true,
    paths: [],
  };
  const rest = argv[Symbol.iterator]();
  for (const arg of rest) {
    if (arg === "--dry") options.mode = "dry";
    else if (arg === "--write") options.mode = "write";
    else if (arg === "--no-format") options.format = false;
    else if (arg === "--report") options.report = rest.next().value;
    else if (arg === "--out") options.out = rest.next().value;
    else if (arg === "--examples")
      options.examples = rest.next().value.split(",").filter(Boolean);
    else options.paths.push(arg);
  }
  if (!options.paths.length) options.paths = ["tests", "docs"];
  return options;
}

function report({ files, options, formatChecks }) {
  const rows = new Map();
  const all = [];
  const unresolvedCounts = new Map();
  const steps = { folded: [], reported: [] };
  let skippedBlocks = [];
  for (const file of files) {
    const dir = dirname(file.rel);
    if (!rows.has(dir))
      rows.set(dir, { found: 0, converted: 0, flagged: 0, untouched: 0 });
    const row = rows.get(dir);
    for (const definition of file.definitions) {
      row.found++;
      row[definition.status]++;
      all.push({ ...definition, file: file.rel });
    }
    for (const u of file.unresolved) {
      const key = `${u.text} (${u.why})`;
      unresolvedCounts.set(key, (unresolvedCounts.get(key) ?? 0) + 1);
    }
    steps.folded.push(
      ...file.steps.folded.map((s) => ({ ...s, file: file.rel }))
    );
    steps.reported.push(
      ...file.steps.reported.map((s) => ({ ...s, file: file.rel }))
    );
    skippedBlocks = skippedBlocks.concat(
      (file.skipped ?? []).map((line) => `${file.rel}:${line}`)
    );
  }
  const total = { found: 0, converted: 0, flagged: 0, untouched: 0 };
  for (const row of rows.values())
    for (const key of Object.keys(total)) total[key] += row[key];
  const lines = [];
  lines.push("# Extension codemod: dry run", "");
  lines.push(
    `Generated by \`node scripts/extension-codemod.mjs ${options.mode === "write" ? "--write" : "--dry"} ${options.paths.join(" ")}\`. Files read: ${files.length} that mention an extension.`,
    ""
  );
  lines.push("## Definitions per directory", "");
  lines.push(
    "| Directory | Found | Converted | Converted, flagged | Untouched |",
    "| --- | ---: | ---: | ---: | ---: |"
  );
  for (const [dir, row] of [...rows.entries()].sort())
    if (row.found)
      lines.push(
        `| \`${dir}\` | ${row.found} | ${row.converted} | ${row.flagged} | ${row.untouched} |`
      );
  lines.push(
    `| **all** | ${total.found} | ${total.converted} | ${total.flagged} | ${total.untouched} |`,
    ""
  );
  const histogram = (items, keyOf) => {
    const counts = new Map();
    for (const item of items)
      counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };
  lines.push(
    "## Why definitions are left untouched",
    "",
    "| Count | Member | Reason |",
    "| ---: | --- | --- |"
  );
  for (const [key, count] of histogram(
    all.filter((d) => d.status === "untouched"),
    (d) => `${d.member}\u0000${d.reason.replace(/`[^`]*`/g, "`…`")}`
  )) {
    const [member, reason] = key.split("\u0000");
    lines.push(`| ${count} | \`${member}\` | ${reason} |`);
  }
  lines.push(
    "",
    "## Why conversions are flagged for hand review",
    "",
    "| Count | Flag |",
    "| ---: | --- |"
  );
  for (const [flag, count] of histogram(
    all.filter((d) => d.status === "flagged").flatMap((d) => d.flags),
    (f) => f.replace(/`[^`]*`/g, (m) => (m.length > 30 ? "`…`" : m))
  ))
    lines.push(`| ${count} | ${flag} |`);
  lines.push(
    "",
    "## Official extensions applied in one step (D11, spec §11)",
    ""
  );
  const omits = steps.folded.filter((s) => s.official === "defaultOmit").length;
  lines.push(
    `Two-step chains folded into one \`$extends(x)\`: ${steps.folded.length - omits}. \`defaultOmit<S>()(…)\` written \`defaultOmit(…)\`: ${omits}. Left for hand review: ${steps.reported.length}.`,
    ""
  );
  for (const s of steps.folded.filter((f) => f.official !== "defaultOmit"))
    lines.push(`- folded \`${s.file}:${s.line}\` ${s.official} \`${s.value}\``);
  for (const s of steps.reported)
    lines.push(`- hand review \`${s.file}:${s.line}\` ${s.official}: ${s.why}`);
  lines.push(
    "",
    "## `$extends` arguments that are not a definition the file writes",
    "",
    "Official extensions and values made elsewhere; counted, not converted.",
    "",
    "| Count | Argument |",
    "| ---: | --- |"
  );
  for (const [key, count] of [...unresolvedCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40))
    lines.push(`| ${count} | \`${key}\` |`);
  lines.push("", "## Parse and format check", "");
  lines.push(formatChecks ?? "Not run (no `--out`).", "");
  if (skippedBlocks.length)
    lines.push(
      `Fenced blocks skipped because they do not parse: ${skippedBlocks.length}.`,
      "",
      ...skippedBlocks.map((b) => `- \`${b}\``),
      ""
    );
  lines.push("## Untouched definitions", "");
  for (const d of all.filter((x) => x.status === "untouched"))
    lines.push(`- \`${d.file}:${d.line}\` \`${d.member}\`: ${d.reason}`);
  lines.push("", "## Flagged conversions", "");
  for (const d of all.filter((x) => x.status === "flagged"))
    lines.push(`- \`${d.file}:${d.line}\`: ${d.flags.join("; ")}`);
  return { text: `${lines.join("\n")}\n`, all };
}

function examplesSection(all, wanted, scratch) {
  const lines = ["", "## Before and after", ""];
  const chosen = wanted.map((spec) => {
    const [file, line] = spec.split(":");
    return {
      spec,
      found: all.find((d) => d.file === file && String(d.line) === line),
    };
  });
  mkdirSync(scratch, { recursive: true });
  const formatted = chosen.map(({ spec, found }, index) => {
    if (!found || found.status === "untouched") return { spec, found };
    const path = join(scratch, `example-${index}.ts`);
    writeFileSync(
      path,
      `${(found.declared ?? []).join("\n")}\nexport const after = ${found.after};\n`
    );
    biomeFormatCopy(path);
    return { spec, found, after: readFileSync(path, "utf8") };
  });
  for (const { spec, found, after } of formatted) {
    lines.push(`### \`${spec}\``, "");
    if (!found) {
      lines.push("No definition at this place.", "");
      continue;
    }
    if (found.flags?.length) lines.push(`Flags: ${found.flags.join("; ")}`, "");
    if (found.status === "untouched")
      lines.push(`Untouched: \`${found.member}\`, ${found.reason}`, "");
    lines.push("Before:", "", "```ts", found.before, "```", "");
    if (after) lines.push("After:", "", "```ts", after.trimEnd(), "```", "");
  }
  return lines.join("\n");
}

function main(argv) {
  const options = parseArgs(argv);
  const results = [];
  for (const path of filesOf(options.paths)) {
    const text = readFileSync(path, "utf8");
    if (!MENTION.test(text)) continue;
    const rel = relative(ROOT, path);
    if (MARKDOWN.test(path)) {
      const { text: out, blocks } = convertMarkdown(text);
      results.push({
        path,
        rel,
        text,
        out,
        markdown: true,
        blocks,
        definitions: blocks.flatMap((b) => b.definitions ?? []),
        unresolved: blocks.flatMap((b) => b.unresolved ?? []),
        steps: {
          folded: blocks.flatMap((b) => b.steps?.folded ?? []),
          reported: blocks.flatMap((b) => b.steps?.reported ?? []),
        },
        skipped: blocks.filter((b) => b.skipped).map((b) => b.line),
        syntaxErrors: blocks.reduce((n, b) => n + (b.syntaxErrors ?? 0), 0),
      });
    } else {
      const converted = convertSource(text, {
        fileName: path,
        area: rel.startsWith("docs") ? "docs" : "tests",
      });
      results.push({ ...converted, path, rel, text, out: converted.text });
    }
  }
  let formatChecks;
  if (options.out) {
    const outRoot = resolve(ROOT, options.out);
    const written = [];
    for (const result of results) {
      if (result.out === result.text) continue;
      if (result.markdown)
        for (const block of result.blocks) {
          if (!block.changed) continue;
          const target = join(
            outRoot,
            `${result.rel}.block${block.line}.${block.lang === "tsx" ? "tsx" : "ts"}`
          );
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, block.text);
          written.push({ target, rel: `${result.rel}:${block.line}` });
        }
      else {
        const target = join(outRoot, result.rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, result.out);
        written.push({ target, rel: result.rel });
      }
    }
    const failures = [];
    const emptied = [];
    for (const { target, rel } of written) {
      const outcome = biomeFormatCopy(target);
      if (outcome.empty)
        emptied.push(
          `- \`${rel}\` is left empty: the prose around it needs rewriting`
        );
      const reparsed = parse(readFileSync(target, "utf8"), target).syntaxErrors
        .length;
      if (!outcome.ok || reparsed)
        failures.push(
          `- \`${rel}\`: ${reparsed ? `${reparsed} syntax errors` : (outcome.output.split("\n").find((l) => BIOME_ERROR.test(l)) ?? "biome failed")}`
        );
    }
    formatChecks = `Converted files written under \`${options.out}\`: ${written.length} (fenced blocks count one each). Parsed by TypeScript and formatted by \`biome format --write\`: ${written.length - failures.length} clean, ${failures.length} failed. They are not type-checked: the new vocabulary has no types yet.${failures.length ? `\n\n${failures.join("\n")}` : ""}${emptied.length ? `\n\n${emptied.join("\n")}` : ""}`;
  }
  if (options.mode === "write") {
    const changed = results.filter((r) => r.out !== r.text);
    for (const result of changed) writeFileSync(result.path, result.out);
    if (options.format)
      biomeFormat(changed.filter((r) => !r.markdown).map((r) => r.path));
  }
  const { text, all } = report({ files: results, options, formatChecks });
  const full =
    text +
    (options.examples.length
      ? examplesSection(
          all,
          options.examples,
          join(ROOT, ".scratch/extension-codemod/examples")
        )
      : "");
  if (options.report) writeFileSync(options.report, full);
  else process.stdout.write(full);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2));
