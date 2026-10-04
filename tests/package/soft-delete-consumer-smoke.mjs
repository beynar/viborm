/**
 * A third party builds soft delete from the published package alone
 * (extension-capabilities plan v3.1 §1.1, "Done": "a third-party fixture
 * reproduces §1.1 from public exports").
 *
 * The consumer is a packed-package application (`packed-consumer.mjs`). Its
 * `soft-delete.ts` is the shipped definition (`src/soft-delete/index.ts`) with
 * its two imports spelled as a consumer spells them, `viborm` and
 * `viborm/client`; this script refuses any other import, so the definition
 * provably needs nothing private. Its `use.ts` is §1.1's use block against
 * `viborm/sqlite3`, with each result checked; `use-entry.ts` is the same block
 * importing `softDelete` from the published `viborm/soft-delete` entry, whose
 * declarations name the package's hashed chunks, so the shipped entry itself
 * is type-checked and run.
 *
 *   A. TYPES — `tsc --strict` over the consumer, against the published
 *              declarations: the definition compiles with its three casts, the
 *              use block type-checks through both imports, `restore` narrows
 *              exactly to its `select`, and the five `@ts-expect-error` lines
 *              are needed.
 *   B. RUN   — Node runs the same files (type stripping): reads show live
 *              posts, the recycle bin shows tombstones, delete returns the
 *              post-image with the actor, restore narrows, the purge removes
 *              only old tombstones.
 *
 * Run after `pnpm package:build`. `VIBORM_PACKAGE_TARBALL` names an existing
 * tarball instead of packing one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot, withPackedConsumer } from "./packed-consumer.mjs";

const IMPORT_SPECIFIER = /^import\b[^;]*?\bfrom\s*"([^"]+)"/gm;
const PUBLIC_SPELLING = new Map([
  ["../index", "viborm"],
  ["../client/exports", "viborm/client"],
]);

/** The shipped definition, its imports spelled as a consumer spells them. */
function consumerDefinition() {
  let source = readFileSync(
    join(repositoryRoot, "src", "soft-delete", "index.ts"),
    "utf8"
  );
  const specifiers = [...source.matchAll(IMPORT_SPECIFIER)].map(
    (match) => match[1]
  );
  const unexpected = specifiers.filter(
    (specifier) => !PUBLIC_SPELLING.has(specifier)
  );
  if (unexpected.length > 0 || specifiers.length !== PUBLIC_SPELLING.size) {
    throw new Error(
      `src/soft-delete/index.ts must import only the files behind viborm and viborm/client, found ${specifiers.join(", ")}`
    );
  }
  for (const [internal, published] of PUBLIC_SPELLING) {
    source = source.replace(`"${internal}"`, `"${published}"`);
  }
  return source;
}

const use = `import assert from "node:assert/strict";
import { s } from "viborm";
import { createMigrationClient } from "viborm/migrations";
import { createClient } from "viborm/sqlite3";
import { softDelete } from "./soft-delete.ts";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => post).name("author"),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  createdAt: s.dateTime(),
  authorId: s.string(),
  author: s.toOne(() => user).name("author").fields("authorId").references("id"),
  deletedAt: s.dateTime().nullable(),
  deletedById: s.string().nullable(),
});

const base = createClient({ schema: { user, post }, dataDir: ":memory:" });
const migrations = createMigrationClient(base);
const preview = await migrations.push({ dryRun: true });
await migrations.push({ consent: preview.consent });
await base.user.create({ data: { id: "u1", name: "Ada" } });
const day = (iso: string) => new Date(iso + "T00:00:00.000Z");
for (const [id, createdAt, deletedAt] of [
  ["p1", "2025-01-01", null],
  ["p2", "2025-02-01", null],
  ["p3", "2025-03-01", "2025-04-01"],
  ["p4", "2025-03-01", "2026-08-01"],
] as const) {
  await base.post.create({
    data: {
      id,
      title: id,
      authorId: "u1",
      createdAt: day(createdAt),
      deletedAt: deletedAt === null ? null : day(deletedAt),
    },
  });
}
const session = { userId: "admin-1" };
const cutoff = day("2026-06-01");
const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

// §1.1's use block.
const db = softDelete({
  models: { post: { deletedAt: "deletedAt", deletedBy: "deletedById" } },
  actor: session.userId,
})(base);
const users = await db.user.findMany({ include: { posts: { orderBy: { id: "asc" } } } });
assert.deepEqual(ids(users[0]?.posts ?? []), ["p1", "p2"]);
const bin = await db.post.findMany({ deleted: "only", orderBy: { id: "asc" } });
assert.deepEqual(ids(bin), ["p3", "p4"]);
const deleted = await db.post.delete({ where: { id: "p1" } });
assert.equal(deleted.id, "p1");
assert.equal(deleted.deletedById, "admin-1");
assert.ok(deleted.deletedAt instanceof Date);
const restored = await db.post.restore({ where: { id: "p1" }, select: { id: true } });
// Exact, not assignable: a full post row would satisfy \`{ id: string }\` too.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
const narrowed: Equal<typeof restored, { id: string }> = true;
assert.ok(narrowed);
assert.deepEqual(restored, { id: "p1" });
const purged = await db.post.deleteMany({
  where: { deletedAt: { lt: cutoff } },
  deleted: "only",
  mode: "hard",
});
assert.deepEqual(purged, { count: 1 });
assert.deepEqual(ids(await base.post.findMany({ orderBy: { id: "asc" } })), ["p1", "p2", "p4"]);

export async function flagged() {
  // @ts-expect-error restore exists only on configured models
  await db.user.restore({ where: { id: "u1" } });
  // @ts-expect-error restore writes its own data
  await db.post.restore({ where: { id: "p1" }, data: { title: "x" } });
  // @ts-expect-error mode goes only on the deletes of managed models
  await db.user.delete({ where: { id: "u1" }, mode: "hard" });
  // @ts-expect-error a misspelt restore key is flagged
  await db.post.restore({ where: { id: "p1" }, selcet: { id: true } });
  // @ts-expect-error deleted takes the declared modes only
  await db.post.findMany({ deleted: "gone" });
}

await base.$disconnect();
console.log("LABEL: pass");
`;

/** The use block importing `softDelete` from `source`, reporting as `label`. */
const useFrom = (source, label) =>
  use
    .replace('from "./soft-delete.ts"', `from "${source}"`)
    .replace("LABEL: pass", `${label}: pass`);

const uses = {
  "use.ts": useFrom("./soft-delete.ts", "soft-delete consumer"),
  "use-entry.ts": useFrom("viborm/soft-delete", "soft-delete entry consumer"),
};
withPackedConsumer(
  "viborm-soft-delete-consumer",
  { "soft-delete.ts": consumerDefinition(), ...uses },
  ({ typeCheck, run }) => {
    typeCheck(Object.keys(uses));
    run("use.ts", "soft-delete consumer");
    run("use-entry.ts", "soft-delete entry consumer");
  }
);
console.log("packed soft-delete consumer and entry consumer: pass");
