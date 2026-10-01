/**
 * A third party builds the guide's extension recipes from the published
 * package alone (extension-capabilities plan v4 §1: "must compile and run
 * verbatim from public exports"; owner decision §7.2: guide recipes, not
 * package entries).
 *
 * The consumer is a packed-package application (`packed-consumer.mjs`). Its
 * `recipes.ts` is `tests/fixtures/extension-recipes.ts` with its two imports
 * spelled as a consumer spells them, `viborm` and `viborm/validation`; this
 * script refuses any other import, so the recipes provably need nothing
 * private. Each of the recipe file's top-level blocks (the imports,
 * `perModel`, tenancy, audit, the optimistic lock) must appear verbatim in the
 * guide's recipes page, so the page, the fixture the behaviour tests run and
 * the packed consumer are one text. Its `use.ts` runs §1.1's calls against
 * `viborm/sqlite3` (the first read with an `include` added, to observe the
 * related filter), then audit and the lock applied over tenancy, with each
 * result checked. Last, it runs the page's three use blocks verbatim, each in
 * a scope of its own over the plain client, and checks what they wrote: the
 * lock's block twice, the second time on a row that moved on.
 *
 *   A. TYPES — `tsc --strict` over the consumer, against the published
 *              declarations: the recipes compile with no cast, the use block
 *              and the page's use blocks type-check, and the four
 *              `@ts-expect-error` lines (the
 *              controls' value and placement types) are needed.
 *   B. RUN   — Node runs the same file (type stripping): a tenant reads only
 *              its rows, through a relation too; a create is stamped with the
 *              tenant; `scope: "all"` reads every tenant; a missing tenant, a
 *              missing actor and a caller's stamped field are refused at their
 *              paths; another tenant's row is `NotFoundError`; audit stamps
 *              root and nested writes; the lock moves the version on and a
 *              stale version is `NotFoundError`.
 *
 * Run after `pnpm package:build`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot, withPackedConsumer } from "./packed-consumer.mjs";

const IMPORT_SPECIFIER = /^import\b[^;]*?\bfrom\s*"([^"]+)"/gm;
const PUBLIC_SPELLING = new Map([
  ["@src/index", "viborm"],
  ["@src/validation", "viborm/validation"],
]);
const GUIDE = join(
  repositoryRoot,
  "docs",
  "content",
  "docs",
  "extensions",
  "recipes.mdx"
);

const USE_BLOCK = /```ts\n(const db = base\.\$extends\([^`]*?)```/g;

/** The page's use blocks, in page order: tenancy, audit, the lock. */
function guideUseBlocks() {
  const blocks = [...readFileSync(GUIDE, "utf8").matchAll(USE_BLOCK)].map(
    (match) => match[1]
  );
  if (blocks.length !== 3) {
    throw new Error(
      `The recipes page must carry three use blocks starting "const db = base.$extends(", found ${blocks.length}`
    );
  }
  return blocks;
}
const [tenancyUse, auditUse, lockUse] = guideUseBlocks();

/** The recipes from their first import on, spelled as a consumer spells them. */
function consumerRecipes() {
  const fixture = readFileSync(
    join(repositoryRoot, "tests", "fixtures", "extension-recipes.ts"),
    "utf8"
  );
  let source = fixture.slice(fixture.indexOf("\nimport ") + 1);
  const specifiers = [...source.matchAll(IMPORT_SPECIFIER)].map(
    (match) => match[1]
  );
  const unexpected = specifiers.filter(
    (specifier) => !PUBLIC_SPELLING.has(specifier)
  );
  if (unexpected.length > 0 || specifiers.length !== PUBLIC_SPELLING.size) {
    throw new Error(
      `tests/fixtures/extension-recipes.ts must import only the files behind viborm and viborm/validation, found ${specifiers.join(", ")}`
    );
  }
  for (const [internal, published] of PUBLIC_SPELLING) {
    source = source.replace(`"${internal}"`, `"${published}"`);
  }
  const guide = readFileSync(GUIDE, "utf8");
  const missing = source
    .split("\n\n")
    .filter((block) => !guide.includes(block.trim()));
  if (missing.length > 0) {
    throw new Error(
      `The recipes page does not carry these blocks of the recipe file verbatim:\n${missing.join("\n\n")}`
    );
  }
  return source;
}

const use = `import assert from "node:assert/strict";
import { NotFoundError, s, ValidationError } from "viborm";
import { createMigrationClient } from "viborm/migrations";
import { createClient } from "viborm/sqlite3";
import { audit, optimisticLock, tenancy } from "./recipes.ts";

// Every field a recipe writes is nullable or has a default.
const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  tenantId: s.string().nullable(),
  createdBy: s.string().nullable(),
  updatedBy: s.string().nullable(),
  version: s.int().default(0),
  comments: s.toMany(() => comment),
});
const comment = s.model({
  id: s.string().id().ulid(),
  body: s.string(),
  tenantId: s.string().nullable(),
  createdBy: s.string().nullable(),
  updatedBy: s.string().nullable(),
  postId: s.string(),
  post: s.toOne(() => post).fields("postId").references("id"),
});

const base = createClient({ schema: { post, comment }, dataDir: ":memory:" });
const migrations = createMigrationClient(base);
const preview = await migrations.push({ dryRun: true });
await migrations.push({ consent: preview.consent });
const seeded = await base.post.create({
  data: {
    title: "a",
    tenantId: "acme",
    comments: {
      create: [
        { body: "ours", tenantId: "acme" },
        { body: "theirs", tenantId: "globex" },
      ],
    },
  },
  include: { comments: true },
});
const globex = await base.post.create({ data: { title: "g", tenantId: "globex" } });

const failure = async (pending: PromiseLike<unknown>) => {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
};
const issues = (error: unknown) => {
  assert.ok(error instanceof ValidationError);
  return error.issues;
};
const sorted = (rows: readonly { id: string }[]) => rows.map((row) => row.id).sort();

// §1.1's calls, the first read with an include to observe the related filter.
const title = "new";
const db = base.$extends(tenancy(["post", "comment"]));
const acme = await db.post.findMany({ tenant: "acme", include: { comments: true } });
assert.deepEqual(sorted(acme), [seeded.id]);
assert.deepEqual(
  acme[0]?.comments.map((row) => row.body),
  ["ours"]
);
const created = await db.post.create({ data: { title }, tenant: "acme" });
assert.equal(created.tenantId, "acme");
assert.deepEqual(sorted(await db.post.findMany({ tenant: "acme" })), sorted([seeded, created]));
assert.equal((await db.post.findMany({ tenant: "acme", scope: "all" })).length, 3);
assert.deepEqual(issues(await failure(db.post.findMany())), [
  { path: "tenant", message: 'Control "tenant" is required' },
]);
assert.deepEqual(
  issues(await failure(db.post.create({ data: { title, tenantId: "globex" }, tenant: "acme" }))),
  [{ path: "data.tenantId", message: 'Field "tenantId" is written by extension "tenancy"' }]
);
assert.ok(
  (await failure(
    db.post.update({ where: { id: globex.id }, data: { title: "x" }, tenant: "acme" })
  )) instanceof NotFoundError
);

// Audit and the lock, applied over tenancy.
const stamped = db.$extends(audit(["post", "comment"])).$extends(optimisticLock(["post"]));
const written = await stamped.post.create({
  data: { title: "s", comments: { create: [{ body: "n" }] } },
  include: { comments: true },
  tenant: "acme",
  actor: "ann",
});
assert.deepEqual(
  [written.tenantId, written.createdBy, written.updatedBy, written.version],
  ["acme", "ann", null, 0]
);
assert.deepEqual(
  written.comments.map((row) => [row.tenantId, row.createdBy]),
  [["acme", "ann"]]
);
assert.deepEqual(issues(await failure(stamped.post.create({ data: { title }, tenant: "acme" }))), [
  { path: "actor", message: 'Control "actor" is required' },
]);
const moved = await stamped.post.update({
  where: { id: written.id },
  data: { title: "t" },
  tenant: "acme",
  actor: "bob",
  expectedVersion: 0,
});
assert.deepEqual([moved.updatedBy, moved.version], ["bob", 1]);
assert.ok(
  (await failure(
    stamped.post.update({
      where: { id: written.id },
      data: { title: "stale" },
      tenant: "acme",
      actor: "bob",
      expectedVersion: 0,
    })
  )) instanceof NotFoundError
);
assert.deepEqual(
  issues(
    await failure(
      stamped.post.update({
        where: { id: written.id },
        data: { version: 7 },
        tenant: "acme",
        actor: "bob",
      })
    )
  ),
  [{ path: "data.version", message: 'Field "version" is written by extension "optimisticLock"' }]
);
assert.equal((await base.post.findUniqueOrThrow({ where: { id: written.id } })).title, "t");

// The page's use blocks, verbatim, each in its own scope over the plain client.
const session = { userId: "ann" };
{
  const title = "guide tenancy";
  const refused = await failure(
    (async () => {
${tenancyUse}    })()
  );
  assert.deepEqual(issues(refused), [{ path: "tenant", message: 'Control "tenant" is required' }]);
  const rows = await base.post.findMany({ where: { title } });
  assert.deepEqual(
    rows.map((row) => row.tenantId),
    ["acme"]
  );
}
const target = await base.post.create({ data: { title: "guide", version: 3 } });
{
  const { id } = target;
  const title = "guide audit";
${auditUse}  const rows = await base.post.findMany({ where: { title } });
  assert.deepEqual(
    rows.map((row) => [row.id === id, row.createdBy, row.updatedBy]).sort(),
    [
      [false, "ann", null],
      [true, null, "ann"],
    ]
  );
}
{
  const { id } = target;
  const data = { title: "guide lock" };
${lockUse}  const row = await base.post.findUniqueOrThrow({ where: { id } });
  assert.deepEqual([row.title, row.version], ["guide lock", 4]);
}
{
  const { id } = target;
  const data = { title: "stale" };
  const moved = await failure(
    (async () => {
${lockUse}    })()
  );
  assert.ok(moved instanceof NotFoundError);
  assert.equal((await base.post.findUniqueOrThrow({ where: { id } })).title, "guide lock");
}

export async function flagged() {
  // @ts-expect-error tenant takes a string
  await db.post.findMany({ tenant: 1 });
  // @ts-expect-error scope takes the declared modes only
  await db.post.findMany({ tenant: "acme", scope: "none" });
  // @ts-expect-error actor goes only on writes
  await stamped.post.findMany({ tenant: "acme", actor: "ann" });
  // @ts-expect-error expectedVersion goes only on update and delete
  await stamped.post.updateMany({ data: {}, tenant: "acme", actor: "ann", expectedVersion: 1 });
}

await base.$disconnect();
console.log("extension recipes consumer: pass");
`;

withPackedConsumer(
  "viborm-extension-recipes-consumer",
  { "recipes.ts": consumerRecipes(), "use.ts": use },
  ({ typeCheck, run }) => {
    typeCheck(["use.ts"]);
    run("use.ts", "extension recipes consumer");
  }
);
console.log("packed extension recipes consumer: pass");
