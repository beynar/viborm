#!/usr/bin/env node
/**
 * Type-checks the TypeScript examples of the extension documentation against
 * the repository's source, with the native compiler.
 *
 * Pages: every `.mdx` under `docs/content/docs/extensions/`, and every other
 * documentation page that mentions `$extends`. Each fenced `ts` or
 * `typescript` block becomes one module: the page's preamble (the schema,
 * client and values its examples assume), then the block. The preamble lives
 * beside this script, at `docs-extension-examples/<page path>.ts`, so the
 * pages carry only what a reader copies; a page without one compiles its
 * blocks bare. A preamble declaration that the block declares itself, or an
 * import the block makes itself, is left out of that block's module, so a
 * block that writes its own `schema` or `client` shadows the preamble's.
 *
 * A preamble may hold named sections, each opened by a line
 * `// @section <name>`: the text before the first section serves every block
 * of the page, a section only the blocks whose info string says
 * `with=<name>` (several: `with=a,b`). That is how a block that continues an
 * earlier one (the same `db`, the same predicates) is compiled without the
 * page repeating it.
 *
 * A block's relative import (`import type { schema } from "./schema"`)
 * resolves to `docs-extension-examples/modules/<name>.ts`.
 *
 * Two info strings take a block out of the plain check, and are listed:
 * - `ts no-check`: deliberately partial (a signature, a shape); not compiled.
 * - `ts expect-error`: shows an error; compiled, and must fail to compile.
 *
 *   node scripts/docs-extension-examples.mjs          check every page
 *   node scripts/docs-extension-examples.mjs create   only pages whose path contains "create"
 *
 * Exit 1 when a block that should compile does not, or an `expect-error`
 * block compiles.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs", "content", "docs");
const PREAMBLES = join(ROOT, "scripts", "docs-extension-examples");
const OUT = join(ROOT, "node_modules", ".cache", "docs-extension-examples");
const TSC = join(ROOT, "node_modules", "typescript-native", "bin", "tsc");

const FENCE_OPEN = /^(\s*)```(ts|typescript)\b(.*)$/;
const FENCE_CLOSE = /^\s*```\s*$/;
const ANY_FENCE_OPEN = /^(\s*)```/;
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const ENTRY = /^\s*"?([\w/-]+)"?:\s*"\.\/(src\/[^"]+)"/gm;
const SECTION = /^\/\/ @section (\S+)\s*$/;

/** The flags an info string may carry after the language. */
export const FLAGS = new Set(["no-check", "expect-error"]);

/**
 * The fenced TypeScript blocks of one page, each with the 1-based page line
 * of its first code line, its flags, and its code dedented by the fence's
 * own indentation (a block inside a list item).
 */
export function extractBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const open = FENCE_OPEN.exec(lines[index]);
    if (open === null) {
      // Skip the body of any other fenced block, so a ``` inside it is not
      // read as a TypeScript fence.
      if (ANY_FENCE_OPEN.test(lines[index])) {
        index += 1;
        while (index < lines.length && !FENCE_CLOSE.test(lines[index]))
          index += 1;
      }
      continue;
    }
    const indent = open[1].length;
    const tokens = open[3].trim().split(/\s+/);
    const flags = new Set(tokens.filter((token) => FLAGS.has(token)));
    const sections = tokens
      .filter((token) => token.startsWith("with="))
      .flatMap((token) => token.slice("with=".length).split(","));
    const code = [];
    const first = index + 2;
    index += 1;
    while (index < lines.length && !FENCE_CLOSE.test(lines[index])) {
      code.push(lines[index].slice(Math.min(indent, leading(lines[index]))));
      index += 1;
    }
    blocks.push({ line: first, flags, sections, code: code.join("\n") });
  }
  return blocks;
}

const leading = (line) => line.length - line.trimStart().length;

/** The names a module's top-level statements declare or import. */
export function declaredNames(code) {
  const file = ts.createSourceFile("block.ts", code, ts.ScriptTarget.Latest);
  const names = new Set();
  for (const statement of file.statements)
    for (const name of statementNames(statement)) names.add(name);
  return names;
}

function statementNames(statement) {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause === undefined) return [];
    const names = clause.name === undefined ? [] : [clause.name.text];
    const bindings = clause.namedBindings;
    if (bindings === undefined) return names;
    if (ts.isNamespaceImport(bindings)) return [...names, bindings.name.text];
    return [...names, ...bindings.elements.map((element) => element.name.text)];
  }
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name)
    );
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)) &&
    statement.name !== undefined &&
    ts.isIdentifier(statement.name)
  )
    return [statement.name.text];
  return [];
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  );
}

/**
 * The preamble with every statement the block declares itself left out,
 * and every import specifier the block imports itself.
 */
export function preambleFor(preamble, code) {
  if (preamble === "") return "";
  const own = declaredNames(code);
  const gone = new Set(own);
  const file = ts.createSourceFile(
    "preamble.ts",
    preamble,
    ts.ScriptTarget.Latest,
    true
  );
  const kept = [];
  for (const statement of file.statements) {
    const text = preamble.slice(statement.getFullStart(), statement.getEnd());
    if (ts.isImportDeclaration(statement)) {
      kept.push(importWithout(statement, text, own));
      continue;
    }
    const names = statementNames(statement);
    // A statement the block redeclares goes, and so does one that reads
    // what went: the block's own name would otherwise be read before it is
    // declared.
    if (names.some((name) => own.has(name)) || readsAny(statement, gone)) {
      for (const name of names) gone.add(name);
      continue;
    }
    kept.push(text);
  }
  return kept.filter((text) => text !== "").join("");
}

/** Whether a statement names one of `names` anywhere inside it. */
function readsAny(statement, names) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isIdentifier(node) && names.has(node.text) && !isKeyName(node))
      found = true;
    else ts.forEachChild(node, visit);
  };
  ts.forEachChild(statement, visit);
  return found;
}

/** A property's own name (`{ user: … }`, `a.user`), which reads no variable. */
function isKeyName(node) {
  const { parent } = node;
  return (
    ((ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node)
  );
}

function importWithout(statement, text, own) {
  const clause = statement.importClause;
  if (clause === undefined) return text;
  const bindings = clause.namedBindings;
  const keepDefault = clause.name !== undefined && !own.has(clause.name.text);
  if (bindings !== undefined && ts.isNamespaceImport(bindings))
    return own.has(bindings.name.text) ? "" : text;
  const elements = (bindings?.elements ?? []).filter(
    (element) => !own.has(element.name.text)
  );
  if (!keepDefault && elements.length === 0) return "";
  const specifier = statement.moduleSpecifier.getText();
  const typeOnly = clause.isTypeOnly ? "type " : "";
  const named = elements.map((element) => element.getText()).join(", ");
  const parts = [
    keepDefault ? clause.name.text : "",
    elements.length > 0 ? `{ ${named} }` : "",
  ].filter((part) => part !== "");
  return `\nimport ${typeOnly}${parts.join(", ")} from ${specifier};`;
}

/** A preamble file as its common text and its named sections. */
export function splitPreamble(text) {
  const sections = new Map();
  let current = [];
  const common = current;
  for (const line of text.split("\n")) {
    const opened = SECTION.exec(line);
    if (opened === null) {
      current.push(line);
      continue;
    }
    current = [];
    sections.set(opened[1], current);
  }
  return {
    common: common.join("\n"),
    sections: new Map(
      [...sections].map(([name, lines]) => [name, lines.join("\n")])
    ),
  };
}

/**
 * One block's module, and the number of preamble lines before its code. A
 * named section overrides the common preamble as the block does.
 */
export function assemble(preamble, code, sections = "") {
  const head = [
    preambleFor(preamble, `${sections}\n${code}`),
    preambleFor(sections, code),
  ]
    .join("\n")
    .replace(/^\n+/, "");
  const prefix = head === "" ? "" : `${head}\n`;
  const offset = prefix === "" ? 0 : prefix.split("\n").length - 1;
  return { text: `${prefix}${code}\nexport {};\n`, offset };
}

/** Every page this check reads, as paths relative to `docs/content/docs`. */
export function pages(filter) {
  const all = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".mdx")) all.push(path);
    }
  };
  walk(DOCS);
  return all
    .filter(
      (path) =>
        path.startsWith(join(DOCS, "extensions") + sep) ||
        readFileSync(path, "utf8").includes("$extends")
    )
    .map((path) => relative(DOCS, path).split(sep).join("/"))
    .filter((page) => filter === undefined || page.includes(filter))
    .sort();
}

/** `viborm/<entry>` → its source file, read from the package build's entries. */
export function entryPaths() {
  const config = readFileSync(join(ROOT, "tsdown.config.ts"), "utf8");
  const paths = { viborm: [join(ROOT, "src", "index.ts")] };
  for (const [, name, file] of config.matchAll(ENTRY)) {
    if (name === "index") continue;
    paths[`viborm/${name}`] = [join(ROOT, file)];
  }
  paths["docs-examples/*"] = [join(PREAMBLES, "*")];
  return paths;
}

/**
 * The syntax errors of one module, by the JavaScript compiler: the native
 * one stops at the first file that does not parse, so a module that does
 * not parse is reported here and kept out of the type check.
 */
export function syntaxErrors(text) {
  const { diagnostics = [] } = ts.transpileModule(text, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return diagnostics
    .filter((diagnostic) => diagnostic.file !== undefined)
    .map((diagnostic) => {
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start ?? 0
      );
      return {
        line: line + 1,
        column: character + 1,
        code: `TS${diagnostic.code}`,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      };
    });
}

/** Map one compiler diagnostic back to its page and line. */
export function locate(diagnostic, modules) {
  const match = DIAGNOSTIC.exec(diagnostic);
  if (match === null) return undefined;
  const [, file, line, column, code, message] = match;
  const module = modules.get(resolve(OUT, file));
  if (module === undefined)
    return { where: file, line: Number(line), code, message, module };
  return {
    ...placeOf(module, Number(line)),
    column: Number(column),
    code,
    message,
    module,
  };
}

/** A module line as a page line, or a preamble line when it is before the block. */
export function placeOf(module, line) {
  const at = line - module.offset;
  return at >= 1
    ? { where: `docs/content/docs/${module.page}`, line: module.block.line + at - 1 }
    : {
        where: `scripts/docs-extension-examples/${module.preamble} (preamble, module line)`,
        line,
      };
}

/**
 * What the compiler said, judged per block: a plain block must have no
 * diagnostic, an `expect-error` block at least one in its own lines.
 */
export function judge(located, modules) {
  const failing = new Map();
  const errors = [];
  const library = [];
  for (const entry of located) {
    // A diagnostic outside any block fails the check when it is in a
    // preamble module; one in the library's own files (reached through a
    // block's imports) is the type tests' to fail, and is only listed.
    if (entry.module === undefined) {
      if (resolve(OUT, entry.where).startsWith(PREAMBLES)) errors.push(entry);
      else library.push(entry);
      continue;
    }
    const list = failing.get(entry.module) ?? [];
    list.push(entry);
    failing.set(entry.module, list);
  }
  const marked = [];
  let compiled = 0;
  for (const module of modules.values()) {
    const found = failing.get(module) ?? [];
    if (module.block.flags.has("expect-error")) {
      marked.push(module);
      const inBlock = found.filter((entry) => entry.where.startsWith("docs/"));
      if (inBlock.length === 0)
        errors.push({
          where: `docs/content/docs/${module.page}`,
          line: module.block.line,
          message: "marked expect-error, but compiles",
        });
      continue;
    }
    if (found.length === 0) compiled += 1;
    else errors.push(...found);
  }
  return { compiled, marked, errors, library };
}

function main() {
  const started = performance.now();
  const filter = process.argv[2];
  const modules = new Map();
  const skipped = [];
  const unparsable = [];
  const located = [];
  mkdirSync(OUT, { recursive: true });
  // A block's relative import (`./schema`) resolves beside the generated
  // modules: the preamble folder's `modules/` are copied there.
  const relatives = join(PREAMBLES, "modules");
  if (existsSync(relatives))
    for (const name of readdirSync(relatives))
      copyFileSync(join(relatives, name), join(OUT, name));
  for (const page of pages(filter)) {
    const preamblePath = page.replace(/\.mdx$/, ".ts");
    const preambleFile = join(PREAMBLES, preamblePath);
    const { common, sections } = splitPreamble(
      existsSync(preambleFile) ? readFileSync(preambleFile, "utf8") : ""
    );
    const blocks = extractBlocks(readFileSync(join(DOCS, page), "utf8"));
    for (const [index, block] of blocks.entries()) {
      if (block.flags.has("no-check")) {
        skipped.push({ page, block });
        continue;
      }
      const unknown = block.sections.filter((name) => !sections.has(name));
      if (unknown.length > 0)
        throw new Error(
          `docs/content/docs/${page}:${block.line} names preamble sections ${unknown.join(", ")}, which scripts/docs-extension-examples/${preamblePath} does not have`
        );
      const { text, offset } = assemble(
        common,
        block.code,
        block.sections.map((name) => sections.get(name)).join("\n")
      );
      const unparsed = syntaxErrors(text);
      if (unparsed.length > 0) {
        const module = { page, block, offset, preamble: preamblePath };
        unparsable.push(module);
        for (const error of unparsed)
          located.push({
            ...error,
            ...placeOf(module, error.line),
            module,
          });
        continue;
      }
      const file = join(
        OUT,
        `${page.replace(/\.mdx$/, "").replace(/[^\w-]+/g, "_")}__${index + 1}.ts`
      );
      writeFileSync(file, text);
      modules.set(file, { page, block, offset, preamble: preamblePath });
    }
  }
  writeFileSync(
    join(OUT, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "es2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          noImplicitAny: false,
          noUncheckedIndexedAccess: true,
          resolveJsonModule: true,
          isolatedModules: true,
          skipLibCheck: true,
          lib: ["es2022", "DOM", "esnext.disposable"],
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules", "@types")],
          paths: { ...entryPaths(), ...sourceAliases() },
        },
        // Ambient declarations a preamble needs (a runtime's own module,
        // such as `cloudflare:workers`) come from the preamble folder's
        // `modules/*.d.ts`.
        files: [
          ...(existsSync(relatives)
            ? readdirSync(relatives).filter((name) => name.endsWith(".d.ts"))
            : []),
          ...[...modules.keys()].map((file) => relative(OUT, file)),
        ],
      },
      null,
      2
    )
  );
  const result = spawnSync(
    process.execPath,
    [TSC, "-p", join(OUT, "tsconfig.json"), "--pretty", "false"],
    { cwd: OUT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const output = `${result.stdout}${result.stderr}`;
  for (const line of output.split("\n")) {
    const entry = locate(line, modules);
    if (entry !== undefined) located.push(entry);
  }
  for (const module of unparsable) modules.set(Symbol("unparsed"), module);
  const { compiled, marked, errors, library } = judge(located, modules);
  if (library.length > 0) {
    console.log("Library diagnostics the examples reach (not counted):");
    for (const entry of library)
      console.log(`  ${relative(ROOT, resolve(OUT, entry.where))}:${entry.line} ${entry.code} ${entry.message}`);
    console.log("");
  }
  for (const error of errors)
    console.log(
      `${error.where}:${error.line}${error.column ? `:${error.column}` : ""} ${error.code ?? ""} ${error.message}`
    );
  console.log("");
  console.log("Marked blocks:");
  for (const { page, block } of skipped)
    console.log(`  no-check      docs/content/docs/${page}:${block.line}`);
  for (const { page, block } of marked)
    console.log(`  expect-error  docs/content/docs/${page}:${block.line}`);
  const blocks = modules.size + skipped.length;
  const failed = new Set(
    errors.map((error) => error.module ?? `${error.where}:${error.line}`)
  ).size;
  console.log("");
  console.log(
    `${blocks} blocks: ${compiled} compile, ${skipped.length + marked.length} marked (${skipped.length} no-check, ${marked.length} expect-error), ${failed} failing; ${((performance.now() - started) / 1000).toFixed(1)} s`
  );
  if (errors.length > 0 || result.status === null) process.exitCode = 1;
}

/** The repository's own path aliases, a preamble may use them (`@src/*`). */
function sourceAliases() {
  const root = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8"));
  const aliases = {};
  for (const [alias, targets] of Object.entries(root.compilerOptions.paths)) {
    if (alias === "viborm") continue;
    aliases[alias] = targets.map((target) => join(ROOT, target));
  }
  return aliases;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
