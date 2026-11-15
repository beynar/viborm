// The extension codemod, one case per member and per form it reads. Run with
// `node --test scripts/extension-codemod.test.mjs`. Outputs are compared with
// their whitespace collapsed: Biome formats them after the codemod.

import assert from "node:assert/strict";
import { test } from "node:test";
import { convertMarkdown, convertSource } from "./extension-codemod.mjs";

const flat = (text) =>
  text
    .replace(/\s+/g, " ")
    .replace(/\s*([(){}[\],;])\s*/g, "$1")
    .trim();

// The helpers throw rather than assert: an assertion belongs in a test.
function convert(source) {
  const result = convertSource(source, { fileName: "case.ts" });
  if (result.syntaxErrors !== 0)
    throw new Error(`output does not parse:\n${result.text}`);
  return { ...result, flat: flat(result.text) };
}

const has = (result, ...pieces) => {
  for (const piece of pieces)
    if (!result.flat.includes(flat(piece)))
      throw new Error(`missing ${piece}\nin ${result.text}`);
};
const lacks = (result, ...pieces) => {
  for (const piece of pieces)
    if (result.flat.includes(flat(piece)))
      throw new Error(`unexpected ${piece}\nin ${result.text}`);
};

const NOT_A_MEMBER = /not a member/;
const UNHOISTED =
  /FIXME\(extension-codemod\): `onWriteOutcome` is not called unconditionally/;

const HEAD = `import { defineExtension } from "@src/index";\n`;

// ---------------------------------------------------------------------------
// Forms of a definition
// ---------------------------------------------------------------------------

test("defineExtension({…}) becomes extension(name, …) and the import follows", () => {
  const r = convert(
    `${HEAD}export const x = defineExtension({ name: "x", result: { post: {} } });`
  );
  has(
    r,
    `export const x = extension("x", fields({ post: {} }));`,
    `import { extension, fields } from "@src/index";`
  );
  lacks(r, "defineExtension");
});

test("defineExtension<S>()({…}) and a binder defineExtension<S>() both convert; the unused binder goes", () => {
  const r = convert(`${HEAD}const define = defineExtension<typeof schema>();
const a = define({ name: "a", order: { models: { post: { title: "asc" } } } });
const b = defineExtension<typeof schema>()({ name: "b", order: { models: { post: { title: "desc" } } } });`);
  has(
    r,
    `const a = extension("a", defaults({ post: { orderBy: { title: "asc" } } }));`
  );
  has(
    r,
    `const b = extension("b", defaults({ post: { orderBy: { title: "desc" } } }));`
  );
  lacks(r, "define =", "defineExtension");
});

test("defineHooks and an object literal passed to $extends convert", () => {
  const r = convert(`import { defineHooks } from "viborm";
client.$extends(defineHooks({ name: "h", statement: ({ statement }) => statement }));
client.$extends({ name: "lit", order: { models: { post: { id: "asc" } } } });`);
  has(
    r,
    `client.$extends(extension("h", unit((u, next) => next(statement(u)), ["statement"], { rewrites: true })));`
  );
  has(
    r,
    `client.$extends(extension("lit", defaults({ post: { orderBy: { id: "asc" } } })));`
  );
  has(r, `from "viborm"`);
});

test("a const literal passed later, with satisfies and as const, sheds its wrappers and type", () => {
  const r = convert(`import type { ClientExtension } from "@src/index";
const held: ClientExtension<S> = { name: "held", order: { models: { post: { id: "asc" } } } } satisfies ClientExtension<S>;
const frozen = { name: "frozen", order: { models: { post: { id: "desc" } } } } as const;
client.$extends(held).$extends(frozen);`);
  has(
    r,
    `const held = extension("held",`,
    `const frozen = extension("frozen",`,
    "client.$extends(held).$extends(frozen);"
  );
  lacks(r, "satisfies", "as const", "ClientExtension");
});

test("a definition a local helper function returns is converted where it is written", () => {
  const r = convert(`function make(label: string) {
  return { name: label, order: { models: { post: { id: "asc" } } } };
}
client.$extends(make("m"));`);
  has(
    r,
    `return extension(label, defaults({ post: { orderBy: { id: "asc" } } }));`,
    `client.$extends(make("m"));`
  );
});

test("a spread of a definition the file writes is read member by member, later members winning", () => {
  const r =
    convert(`const base = { name: "base", order: { models: { post: { id: "asc" } } } } as const;
client.$extends({ ...base, name: "copy" });`);
  has(
    r,
    `client.$extends(extension("copy", defaults({ post: { orderBy: { id: "asc" } } })));`
  );
});

test("a spread of a value made elsewhere, a computed key and an unknown member are left untouched and reported", () => {
  const source = `import { official } from "./official";
client.$extends({ ...official, name: "x" });
client.$extends({ name: "y", [key]: 1 });
client.$extends({ name: "z", cliet: () => ({}) });`;
  const r = convert(source);
  assert.equal(r.text, source);
  assert.deepEqual(
    r.definitions.map((d) => [d.status, d.member]),
    [
      ["untouched", "..."],
      ["untouched", "?"],
      ["untouched", "cliet"],
    ]
  );
  assert.match(r.definitions[2].reason, NOT_A_MEMBER);
});

test("enableExtensions() and its import go", () => {
  const r = convert(
    `import { createClient, enableExtensions } from "viborm";\nenableExtensions();\nconst c = createClient(config);`
  );
  lacks(r, "enableExtensions");
  has(r, `import { createClient } from "viborm";`);
});

// ---------------------------------------------------------------------------
// call: request, query, written, retry, route
// ---------------------------------------------------------------------------

test("request, function form: input → c.args, controls → c.values, every return → c.set", () => {
  const r =
    convert(`client.$extends({ name: "r", request: ({ input, controls, operation }) => {
  if (operation !== "findMany") return {};
  return { take: controls.limit, where: input.where };
} });`);
  has(
    r,
    `call((c) => { if (c.operation !== "findMany") { c.set({}); return; } c.set({ take: c.values.limit, where: c.args.where }); })`
  );
});

test("request, map form: one call part per model operation, with target(model, operation)", () => {
  const r = convert(
    `client.$extends({ name: "r", request: { post: { findMany({ input }) { return { take: 1 }; }, count: () => ({ skip: 2 }) } } });`
  );
  has(
    r,
    `call((c) => { c.set({ take: 1 }); }, target("post", "findMany"))`,
    `call((c) => { c.set({ skip: 2 }); }, target("post", "count"))`
  );
});

test("query, destructured: proceed → run, input → run.input, mode → run.mode, model → c.model", () => {
  const r =
    convert(`client.$extends({ name: "q", query: async ({ proceed, input, mode, model }) => {
  log(model, mode, input);
  return proceed();
} });`);
  has(
    r,
    "around((c) => async (run) => { log(c.model, run.mode, run.input); return run(); })"
  );
});

test("query, named context: property accesses are rewritten; a moment-2-only handler reads no c", () => {
  const r = convert(
    `client.$extends({ name: "q", async query(context) { return context.proceed(); } });`
  );
  has(r, "around(() => async (run) => { return run(); })");
});

test("query, shorthand property in the body keeps its name", () => {
  const r = convert(
    `client.$extends({ name: "q", query: ({ proceed, input }) => send({ input }, proceed) });`
  );
  has(r, "around(() => (run) => send({ input: run.input }, run))");
});

test("query, a rest pattern keeps the body and binds the old names first", () => {
  const r = convert(
    `client.$extends({ name: "q", query: async ({ proceed, ...rest }) => { seen.push(rest); return proceed(); } });`
  );
  has(
    r,
    "const { proceed, ...rest } = { proceed: run, input: run.input, mode: run.mode, kind: c.kind, model: c.model, operation: c.operation, controls: c.values, onWriteOutcome: (listener) => settled(c, listener) };"
  );
  assert.equal(r.definitions[0].status, "flagged");
});

test("query map: an unconditional onWriteOutcome before proceed() is hoisted to settled(c, …) at the first moment", () => {
  const r = convert(`client.$extends({ name: "A", query: { record: {
  async deleteMany({ onWriteOutcome, proceed, operation }) {
    events.push("in");
    onWriteOutcome(({ certainty }) => events.push(operation + certainty));
    return await proceed();
  } } } });`);
  has(
    r,
    `around((c) => { settled(c, ({ certainty }) => events.push(c.operation + certainty)); return async (run) => { events.push("in"); return await run(); }; }, target("record", "deleteMany"))`
  );
  assert.equal(r.definitions[0].status, "converted");
});

test("query: a conditional onWriteOutcome, or one reading the second moment, is left in place and flagged", () => {
  const r =
    convert(`client.$extends({ name: "B", async query({ kind, onWriteOutcome, proceed }) {
  if (kind === "model") onWriteOutcome(() => events.push("B"));
  return proceed();
} });
client.$extends({ name: "C", async query({ input, onWriteOutcome, proceed }) {
  onWriteOutcome(() => events.push(input));
  return proceed();
} });`);
  has(
    r,
    `if (c.kind === "model") settled(c, () => events.push("B"));`,
    "settled(c, () => events.push(run.input));"
  );
  assert.deepEqual(
    r.definitions.map((d) => d.status),
    ["flagged", "flagged"]
  );
  assert.match(r.text, UNHOISTED);
});

test("query held in a variable the file does not write: called with the old context rebuilt, flagged", () => {
  const r = convert(
    `import { handler } from "./h";\nclient.$extends({ name: "q", query: handler });`
  );
  has(r, "around((c) => (run) => handler({ proceed: run, input: run.input");
  assert.equal(r.definitions[0].status, "flagged");
});

test("written → call with watch and settled, target(writes); its call's members become c's", () => {
  const r = convert(`client.$extends({ name: "w", written: (call) => ({
  wants: (model, kind) => call.model === model,
  rows(model, kind, rows) { seen.push(rows); },
  async settled(outcome) { done.push(outcome.certainty, call.controls); },
}) });`);
  // The old handler's parameter named `call` is gone: the word keeps its name.
  has(
    r,
    "call((c) => { watch(c, { wants: (model, kind) => c.model === model, rows(model, kind, rows) { seen.push(rows); } }); settled(c, async (outcome) => { done.push(outcome.certainty, c.values); }); }, target(writes))",
    "import { extension, call, target, writes, watch, settled }"
  );
});

test("written whose watcher comes from elsewhere is adapted and flagged", () => {
  const r = convert(`client.$extends({ name: "w", written: recording(log) });`);
  has(
    r,
    "const watcher = (recording(log))({ model: c.model, operation: c.operation, args: c.args, controls: c.values }); if (watcher === undefined) return; watch(c, watcher); settled(c, (outcome) => watcher.settled(outcome));"
  );
  assert.equal(r.definitions[0].status, "flagged");
});

test("retry → a second moment that runs again while again(run) and the old handler say so", () => {
  const r = convert(
    `client.$extends({ name: "r", retry: (error, attempt) => attempt < 3 });`
  );
  has(
    r,
    "around((c) => { const retry = (error, attempt) => attempt < 3; return async (run) => { for (let attempt = 1; ; attempt++) { try { return await run(); } catch (error) { if (!(again(run) && (await retry(error, attempt, { model: c.model, operation: c.operation })))) throw error; } } }; })"
  );
});

test("route → via(run, driver) on reads, flagged", () => {
  const r = convert(`client.$extends({ name: "r", route: () => replica });`);
  has(
    r,
    "around((c) => { const route = () => replica; return (run) => { const driver = route({ model: c.model, operation: c.operation, args: run.input }); return driver === undefined ? run() : via(run, driver); }; }, target(reads))"
  );
  assert.equal(r.definitions[0].status, "flagged");
});

// ---------------------------------------------------------------------------
// unit: transaction, statement, observe
// ---------------------------------------------------------------------------

test("transaction → a transaction unit that runs the old handler with run(u, sql)", () => {
  const r = convert(
    `client.$extends({ name: "t", transaction: async (run) => { await run(setup); } });`
  );
  has(
    r,
    `unit(async (u, next) => { const open = async (run) => { await run(setup); }; await open((query) => extRun(u, query)); return next(); }, ["transaction"])`
  );
  has(r, "run as extRun");
});

test("statement → a rewriting statement unit; every return goes through next", () => {
  const r =
    convert(`client.$extends({ name: "s", statement({ statement, operation }) {
  if (operation === "$queryRaw") return statement;
  return rewrite(statement);
} });`);
  has(
    r,
    `unit((u, next) => { if (u.operation === "$queryRaw") return next(statement(u)); return next(rewrite(statement(u))); }, ["statement"], { rewrites: true })`
  );
});

test("observe → a unit on every kind; the parameter named unit gives way to the word", () => {
  const r = convert(
    `client.$extends({ name: "o", observe: async (unit, proceed) => { const end = await proceed(); log(unit.kind, end.status); } });`
  );
  has(
    r,
    "unit(async (u, next) => { const end = await next(); log(u.kind, end.status); })",
    "import { extension, unit }"
  );
});

test("observe that reads the facts of observes is left untouched", () => {
  const r = convert(
    `client.$extends({ name: "o", observes: capability, observe(unit, proceed, facts) { log(facts.read()); return proceed(); } });`
  );
  assert.equal(r.definitions[0].status, "untouched");
  assert.equal(r.definitions[0].member, "observe");
});

// ---------------------------------------------------------------------------
// args, rule, methods, fields
// ---------------------------------------------------------------------------

test("controls → args with each modifier; required lists the models the definition names", () => {
  const r = convert(`${HEAD}defineExtension({ name: "c", controls: {
  tenant: { schema: v.string(), required: true },
  actor: { schema: actorSchema, bound: true },
  kind: { oneOf: ["a", "b"], on: "reads", uncacheable: true },
  version: { schema: v.number(), on: ["update", "delete"] },
  all: { oneOf: modes, on: "all" },
  note: { schema: v.string() },
}, data: { models: { post: { create: { tenantId: { control: "tenant" } } } } } });`);
  // A schema without modifier is written accepts(schema) too: one spelling.
  has(
    r,
    `args({ tenant: accepts(v.string()).required(["post"]), actor: bound(actorSchema), kind: oneOf("a", "b").on(reads).volatile(), version: accepts(v.number()).on(["update", "delete"]), all: oneOf(...modes), note: accepts(v.string()) })`
  );
});

test("rows: the mode control becomes oneOf(…).default(d); each mode's filters are when(arg(control), mode, where)", () => {
  const r =
    convert(`${HEAD}defineExtension({ name: "soft", rows: { control: "deleted", default: "without", models: { post: {
  without: { root: { deletedAt: null }, related: { deletedAt: null } },
  with: {},
  only: { root: { deletedAt: { not: null } } },
} } } });`);
  has(
    r,
    `args({ deleted: oneOf("without", "with", "only").default("without") })`
  );
  has(
    r,
    `root: [when(arg("deleted"), "without", { deletedAt: null }), when(arg("deleted"), "only", { deletedAt: { not: null } })]`
  );
  has(r, `related: when(arg("deleted"), "without", { deletedAt: null })`);
});

test("rows.verbs: keys of rule; a predicate used twice is a const declared above, once is inlined", () => {
  const r =
    convert(`${HEAD}const sharing = defineExtension({ name: "sharing", rows: { control: "as", default: "default",
  models: { document: { default: {}, mine: { root: "own" } } },
  verbs: { document: {
    predicates: { seen: { public: true }, own: { ownerId: { control: "user" } }, arch: { archivistId: 1 } },
    read: "seen", update: "own", delete: "own", place: "own",
    writes: { archivedAt: "arch" }, moves: { parentId: "seen" }, reads: { notes: "own" },
    acyclic: ["parent"], evidence: { as: "$access", names: ["seen", "own"] },
  } }, confine: { document: { orgId: 1 } } } });`);
  has(
    r,
    `const documentOwn = { ownerId: arg("user") };`,
    "const documentArch = { archivistId: 1 };"
  );
  has(
    r,
    "read: { where: documentSeen, fields: { notes: gate(documentOwn) }, select: { $access: facts({ seen: documentSeen, own: documentOwn }) } }"
  );
  has(r, `root: when(arg("as"), "mine", documentOwn)`);
  has(r, "create: { check: check(documentOwn) }");
  has(
    r,
    "update: { where: only(documentOwn), check: check(documentOwn), fields: { archivedAt: { where: only(documentArch), check: check(documentArch) }, parentId: { check: check(documentSeen) } } }"
  );
  has(
    r,
    "delete: { where: only(documentOwn) }",
    `acyclic: ["parent"]`,
    "confine: { orgId: 1 }"
  );
  assert.equal(r.definitions[0].status, "flagged");
});

test("rows.verbs, lazy entry: the model's whole entry becomes a function and its shared predicates go inside", () => {
  const r =
    convert(`client.$extends({ name: "lazy", rows: { control: "m", default: "on", models: { doc: { on: { root: "own" } } },
  verbs: { doc: () => { const id = load(); return { predicates: { own: { ownerId: id } }, read: "own", delete: "own" }; } } } });`);
  has(
    r,
    `doc: lazy(() => { const id = load(); const docOwn = { ownerId: id }; return { read: { where: docOwn }, root: when(arg("m"), "on", docOwn), update: { where: only(nothing) }, delete: { where: only(docOwn) } }; })`
  );
});

test("rows.confine → confine of the model's entry", () => {
  const r = convert(
    `client.$extends({ name: "c", rows: { control: "m", default: "on", models: { node: { on: {} } }, confine: { node: { tenantId: { control: "tenant" } } } } });`
  );
  has(r, `node: { confine: { tenantId: arg("tenant") } }`);
});

test("deletion → delete.instead, unless(arg(removeWhen), value, …); its control is placed on deletes of the models it manages", () => {
  const r =
    convert(`client.$extends({ name: "d", controls: { mode: { oneOf: ["soft", "hard"] } },
  deletion: { removeWhen: { mode: "hard" }, models: { post: { at: "deletedAt", assign: { reason: { control: "why" } } } } } });`);
  has(r, `args({ mode: oneOf("soft", "hard").on(deletes).models(["post"]) })`);
  has(
    r,
    `delete: { instead: keep(unless(arg("mode"), "hard", { deletedAt: now, reason: arg("why") })) }`
  );
});

const RULE_CALL = /\brule\(/g;
const DEFAULTS_CALL = /\bdefaults\(/g;

test("members naming one model merge into one entry per part: rows and deletion in rule, data and order in defaults (D13)", () => {
  const r = convert(`client.$extends({ name: "m",
  rows: { control: "deleted", default: "without", models: { post: { without: { root: { deletedAt: null } }, with: {} } } },
  deletion: { models: { post: { at: "deletedAt" } } },
  data: { models: { post: { create: { at: { now: true } }, update: { by: { control: "actor" }, version: { increment: 1 } } } } },
  order: { models: { post: [{ rank: "asc" }] } } });`);
  has(
    r,
    `rule({ post: { root: when(arg("deleted"), "without", { deletedAt: null }), delete: { instead: keep({ deletedAt: now }) } } })`,
    `defaults({ post: { orderBy: [{ rank: "asc" }], create: { at: now }, update: { by: arg("actor"), version: { increment: 1 } } } })`
  );
  assert.equal(r.text.match(RULE_CALL)?.length, 1);
  assert.equal(r.text.match(DEFAULTS_CALL)?.length, 1);
});

test("per-model calls: members built by the same call over the same list merge inside it, per part (the recipes)", () => {
  const r =
    convert(`${HEAD}export const tenancy = <const M extends readonly string[]>(models: M) => defineExtension({
  name: "tenancy",
  controls: { tenant: { schema: v.string(), required: true } },
  rows: { control: "scope", default: "tenant", models: perModel(models, () => ({ tenant: { root: { tenantId: { control: "tenant" } } }, all: {} })) },
  deletion: { models: perModel(models, () => ({ at: "deletedAt" })) },
  data: { models: perModel(models, () => ({ create: { tenantId: { control: "tenant" } } })) },
  order: { models: perModel(models, () => [{ id: "asc" }]) },
});`);
  has(
    r,
    `args({ tenant: accepts(v.string()).required(models), scope: oneOf("tenant", "all").default("tenant") })`,
    `rule(perModel(models, () => ({ root: when(arg("scope"), "tenant", { tenantId: arg("tenant") }), delete: { instead: keep({ deletedAt: now }) } })))`,
    `defaults(perModel(models, () => ({ orderBy: [{ id: "asc" }], create: { tenantId: arg("tenant") } })))`
  );
});

test("defaultOmit<S>()(config) is written defaultOmit(config); a held binder is reported", () => {
  const r = convert(`import { defaultOmit } from "@src/client/default-omit";
const db = client.$extends(defaultOmit<typeof schema>()({ user: { passwordHash: true } }));
const bind = defaultOmit<typeof schema>();`);
  has(
    r,
    "client.$extends(defaultOmit({ user: { passwordHash: true } }))",
    "const bind = defaultOmit<typeof schema>();"
  );
  assert.equal(r.steps.folded.length, 1);
  assert.equal(r.steps.reported.length, 1);
});

test("the word statement is imported under its own name once the handler parameter it replaced is gone", () => {
  const r = convert(`import { defineHooks } from "viborm";
client.$extends(defineHooks({ name: "s", statement: ({ statement }) => statement }));`);
  has(
    r,
    `import { extension, unit, statement } from "viborm";`,
    "next(statement(u))"
  );
});

test("result → fields; client and model → methods({ client, models })", () => {
  const r =
    convert(`client.$extends({ name: "m", result: { post: { slug: { needs: { title: true }, compute: (p) => p.title } } },
  client(scope) { return { $ping: () => scope }; }, model: { post: (delegate) => ({ top: () => delegate.findFirst() }) } });`);
  has(
    r,
    "methods((scope) => { const own = { client(scope) { return { $ping: () => scope }; }, models: { post: (delegate) => ({ top: () => delegate.findFirst() }) } }; return { ...own.client(scope), ...own.models }; })"
  );
  has(
    r,
    "fields({ post: { slug: { needs: { title: true }, compute: (p) => p.title } } })"
  );
});

// ---------------------------------------------------------------------------
// Values: references only where a value goes (create.mdx)
// ---------------------------------------------------------------------------

test("{ control } is a reference in a value position, and a field named control in a filter position", () => {
  const r =
    convert(`client.$extends({ name: "p", rows: { control: "m", default: "on", models: { post: { on: {
  root: { control: "x" },
  related: { AND: [{ control: "y" }, { tenantId: { control: "t" } }], NOT: { control: "z" }, ownerId: { in: { control: "ids", path: "list" } }, author: { is: { control: "w" } } },
} } } } });`);
  has(r, `root: when(arg("m"), "on", { control: "x" })`);
  has(
    r,
    `AND: [{ control: "y" }, { tenantId: arg("t") }]`,
    `NOT: { control: "z" }`,
    `ownerId: { in: arg("ids", "list") }`,
    `author: { is: { control: "w" } }`
  );
});

test("{ now: true }, { $row, up } and $exists become now, row(…) and exists(…); a filter held in a const is written out", () => {
  const r =
    convert(`const member = { member: { orgId: { $row: "orgId", up: 1 }, userId: { control: "user" } } };
client.$extends({ name: "p", rows: { control: "m", default: "on", models: { org: { on: {
  root: { $exists: member, createdAt: { lt: { now: true } } },
} } } } });`);
  has(
    r,
    `when(arg("m"), "on", { AND: [{ createdAt: { lt: now } }, exists({ member: { orgId: row("orgId", 1), userId: arg("user") } })] })`
  );
});

test("$if → provided(arg, test, filter?): it holds only where its test holds", () => {
  const r =
    convert(`client.$extends({ name: "p", rows: { control: "m", default: "on", models: { doc: { on: {
  root: { OR: [{ $if: { control: "scopes", path: "all", equals: true } }, { $if: { control: "actor", path: "id", exists: true }, ownerId: { control: "actor", path: "id" } }] },
} } } } });`);
  has(
    r,
    `OR: [provided(arg("scopes", "all"), true), provided(arg("actor", "id"), { exists: true }, { ownerId: arg("actor", "id") })]`
  );
  assert.equal(r.definitions[0].status, "converted");
});

// ---------------------------------------------------------------------------
// Names, imports, D11, Markdown
// ---------------------------------------------------------------------------

test("a word whose name the file uses is imported under an alias; words join the definer's import", () => {
  const r = convert(`import { defineExtension } from "viborm";
import { on } from "viborm/on";
client.$extends(on({})).$extends(defineExtension({ name: "r", request: { post: { findMany: () => ({ take: 1 }) } } }));`);
  has(
    r,
    `import { extension, call, target } from "viborm";`,
    `target("post", "findMany")`,
    `import { on } from "viborm/on";`
  );
});

test("D11: x.rows then x.methods of one official value in one chain fold into one $extends(x)", () => {
  const r =
    convert(`const tombstones = softDelete({ models: { post: { deletedAt: "deletedAt" } } });
const db = base.$extends(tombstones.rows).$extends(policy).$extends(tombstones.methods);`);
  has(r, "const db = base.$extends(tombstones).$extends(policy);");
  assert.equal(r.steps.folded.length, 1);
});

test("D11: a lone step and a step applied as a function are reported, not changed", () => {
  const source = `const held = permissions(config);
const a = base.$extends(held.rows);
const b = held.methods(held.rows(base));`;
  const r = convert(source);
  assert.equal(r.text, source);
  assert.equal(r.steps.reported.length, 3);
});

test("Markdown: fenced ts blocks convert in place; a block that does not parse is skipped", () => {
  const { text, blocks } = convertMarkdown(`# Title

\`\`\`ts
import { defineExtension } from "viborm";

const x = defineExtension({ name: "x", order: { models: { post: { id: "asc" } } } });
\`\`\`

\`\`\`ts
client.$extends({ name: "y", ... });
\`\`\`
`);
  assert.ok(
    text.includes(`import { extension, defaults } from "viborm";`),
    text
  );
  assert.ok(
    text.includes(
      `const x = extension("x", defaults({ post: { orderBy: { id: "asc" } } }));`
    ),
    text
  );
  assert.ok(text.includes(`client.$extends({ name: "y", ... });`));
  assert.deepEqual(
    blocks.map((b) => b.skipped),
    [false, true]
  );
});
