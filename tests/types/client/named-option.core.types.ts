/**
 * `named`, the call option of named statements: every operation of every
 * client takes it, a driver without named statements included, so code
 * written for pg runs on any database. It is a boolean; an extension's
 * arguments sit beside it. `namedStatements` takes `true`, `"explicit"` and
 * `{ max, auto }`.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { createClient as createBunSQLClient } from "@drivers/bun-sql";
import { createClient as createD1Client } from "@drivers/d1";
import { createClient as createMySQL2Client } from "@drivers/mysql2";
import { createClient as createNeonHTTPClient } from "@drivers/neon-http";
import { createClient as createPgClient } from "@drivers/pg";
import { createClient as createPGliteClient } from "@drivers/pglite";
import { createClient as createPostgresClient } from "@drivers/postgres";
import { createClient as createSQLite3Client } from "@drivers/sqlite3";
import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import { s } from "@src/index";
import { softDelete } from "@src/soft-delete";

const author = s.model({
  id: s.string().id(),
  name: s.string(),
  deletedAt: s.dateTime().nullable(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
});
const schema = { author, post };

declare const database: D1Database;

const pg = createPgClient({ schema, namedStatements: "explicit" });
const clients = [
  pg,
  createPostgresClient({ schema, namedStatements: { max: 50, auto: false } }),
  createBunSQLClient({ schema }),
  createD1Client({ schema, database }),
  createMySQL2Client({ schema }),
  createNeonHTTPClient({ schema }),
  createPGliteClient({ schema }),
  createSQLite3Client({ schema }),
] as const;

for (const db of clients) {
  db.author.findMany({ named: true, include: { posts: true } });
  db.author.findMany({ named: false });
  db.author.findUnique({ where: { id: "a" }, named: true });
  db.author.findUniqueOrThrow({ where: { id: "a" }, named: true });
  db.author.count({ named: true });
  db.author.create({
    data: { id: "a", name: "A", posts: { create: { id: "p", title: "T" } } },
    named: true,
  });
  db.author.update({ where: { id: "a" }, data: { name: "B" }, named: false });
  db.author.deleteMany({ named: true });
  db.$transaction([
    db.author.findMany({ named: true }),
    db.post.count({ named: false }),
  ]);
  db.$transaction((tx) => tx.author.findMany({ named: true }));
  // @ts-expect-error - named is a boolean
  db.author.findMany({ named: "yes" });
  // @ts-expect-error - a misspelt key is still refused
  db.author.findMany({ name: true });
}

// An extension's arguments sit beside it, and a cached read takes it.
const extended = pg
  .$extends(softDelete({ models: { author: { deletedAt: "deletedAt" } } }))
  .$extends(cache({ driver: new MemoryCache() }));
extended.author.findMany({ named: true, deleted: "only" });
extended.author.delete({ where: { id: "a" }, mode: "hard", named: false });
extended.$withCache().author.findMany({ named: true, deleted: "with" });
// @ts-expect-error - named is a boolean, beside an extension's arguments too
extended.author.findMany({ named: 1, deleted: "only" });

createPgClient({ schema, namedStatements: true });
createPgClient({ schema, namedStatements: { max: 20 } });
createPgClient({ schema, namedStatements: { max: 20, auto: true } });
// @ts-expect-error - the explicit mode is spelled "explicit"
createPgClient({ schema, namedStatements: "auto" });
