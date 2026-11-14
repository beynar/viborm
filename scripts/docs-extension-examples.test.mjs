import assert from "node:assert/strict";
import test from "node:test";
import {
  assemble,
  declaredNames,
  entryPaths,
  extractBlocks,
  judge,
  pages,
  placeOf,
  preambleFor,
  splitPreamble,
  syntaxErrors,
} from "./docs-extension-examples.mjs";

const FENCE = "```";

test("extracts ts and typescript blocks with their first line, flags and sections", () => {
  const page = [
    "# Title",
    `${FENCE}ts`,
    "const a = 1;",
    FENCE,
    `${FENCE}bash`,
    `echo "${FENCE}ts"`,
    FENCE,
    `${FENCE}typescript no-check with=one,two title="x.ts"`,
    "partial(",
    FENCE,
    "- item",
    `  ${FENCE}ts expect-error`,
    "  const b: number = 'b';",
    `  ${FENCE}`,
  ].join("\n");
  const blocks = extractBlocks(page);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], {
    line: 3,
    flags: new Set(),
    sections: [],
    code: "const a = 1;",
  });
  assert.deepEqual([...blocks[1].flags], ["no-check"]);
  assert.deepEqual(blocks[1].sections, ["one", "two"]);
  // A block inside a list item is dedented by its fence's indentation.
  assert.equal(blocks[2].code, "const b: number = 'b';");
  assert.equal(blocks[2].line, 13);
  assert.deepEqual([...blocks[2].flags], ["expect-error"]);
});

test("names what a module's top-level statements declare or import", () => {
  const names = declaredNames(
    [
      'import d, { a, b as c } from "x";',
      'import * as ns from "y";',
      "const { e, f: [g] } = h;",
      "function i() {}",
      "type J = 1;",
      "interface K {}",
      "class L {}",
      "i();",
    ].join("\n")
  );
  assert.deepEqual(
    [...names].sort(),
    ["L", "J", "K", "a", "c", "d", "e", "g", "i", "ns"].sort()
  );
});

test("a preamble statement the block redeclares goes, with what reads it", () => {
  const preamble = [
    'import { a, b } from "x";',
    "const db = make();",
    "const call = db.as();",
    "const other = { db: 1 };",
    "declare const id: string;",
  ].join("\n");
  const kept = preambleFor(preamble, 'import { a } from "x";\nconst db = 2;');
  assert.ok(kept.includes('import { b } from "x";'));
  assert.ok(!kept.includes("make()"));
  // `call` reads the `db` that went; `{ db: 1 }` only names a key.
  assert.ok(!kept.includes("db.as"));
  assert.ok(kept.includes("const other"));
  assert.ok(kept.includes("declare const id"));
  assert.equal(preambleFor("", "x"), "");
});

test("a preamble splits into its common text and named sections", () => {
  const { common, sections } = splitPreamble(
    ["const a = 1;", "// @section one", "const b = 2;"].join("\n")
  );
  assert.equal(common, "const a = 1;");
  assert.deepEqual([...sections], [["one", "const b = 2;"]]);
});

test("a module puts the preamble before the block, and a section overrides the common text", () => {
  const { text, offset } = assemble(
    "const db = 1;\ndeclare const id: string;",
    "use(db, id);",
    "const db = 2;"
  );
  assert.equal(offset, 2);
  assert.equal(
    text,
    "declare const id: string;\nconst db = 2;\nuse(db, id);\nexport {};\n"
  );
  assert.deepEqual(assemble("", "x;"), { text: "x;\nexport {};\n", offset: 0 });
});

test("a module line maps to its page line, or to the preamble before the block", () => {
  const module = {
    page: "extensions/create.mdx",
    preamble: "extensions/create.ts",
    offset: 3,
    block: { line: 40 },
  };
  assert.deepEqual(placeOf(module, 5), {
    where: "docs/content/docs/extensions/create.mdx",
    line: 41,
  });
  assert.ok(placeOf(module, 2).where.includes("preamble"));
});

test("syntax errors are found before the type check", () => {
  assert.deepEqual(syntaxErrors("const a = 1;\nexport {};\n"), []);
  const [error] = syntaxErrors("post: { a: 1 },\n");
  assert.equal(error.line, 1);
  assert.ok(error.code.startsWith("TS1"));
});

test("a plain block must compile, an expect-error block must not", () => {
  const plain = { page: "p.mdx", block: { line: 1, flags: new Set() } };
  const failing = { page: "p.mdx", block: { line: 9, flags: new Set() } };
  const expected = {
    page: "p.mdx",
    block: { line: 20, flags: new Set(["expect-error"]) },
  };
  const compiling = {
    page: "p.mdx",
    block: { line: 30, flags: new Set(["expect-error"]) },
  };
  const modules = new Map([
    ["a", plain],
    ["b", failing],
    ["c", expected],
    ["d", compiling],
  ]);
  const located = [
    { where: "docs/content/docs/p.mdx", line: 9, module: failing },
    { where: "docs/content/docs/p.mdx", line: 21, module: expected },
    { where: "../../../src/x.ts", line: 1, module: undefined },
  ];
  const { compiled, marked, errors, library } = judge(located, modules);
  assert.equal(compiled, 1);
  assert.deepEqual(marked, [expected, compiling]);
  assert.deepEqual(
    errors.map((error) => error.line),
    [9, 30]
  );
  assert.equal(library.length, 1);
});

test("the pages checked include every extension page and the entries resolve to source", () => {
  const checked = pages();
  assert.ok(checked.includes("extensions/create.mdx"));
  assert.ok(checked.includes("extensions/recipes.mdx"));
  const paths = entryPaths();
  assert.ok(paths.viborm[0].endsWith("src/index.ts"));
  assert.ok(paths["viborm/on"][0].endsWith("src/on/index.ts"));
  assert.ok(
    paths["viborm/cache/memory"][0].endsWith("src/cache/drivers/memory.ts")
  );
});
