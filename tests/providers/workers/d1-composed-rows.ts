/**
 * W-K1e on D1: the 27 calls of `tests/raptor3/post-prep/row-scopes.test.ts`'s
 * golden ("tenancy, soft delete and an optional control: SQL unchanged"),
 * through the same composed chain, recorded on the D1 binding with the values
 * each statement binds. Its golden, `__golden__/d1-composed-rows-sql.json`,
 * was recorded with this module on D1 at 2fcaa26a8 (VibORM 1.2.4, before
 * K1/K2), where relation filters were plain `EXISTS`; the driver now reads
 * them from a derived table (`deepExpressions: false`, the expression-depth
 * fact), which {@link unwrapDerivedExists} undoes textually, so any other
 * difference is a change of the statements themselves. Each statement a
 * `batch` call ran carries that batch's ordinal within the call: on D1, one
 * batch is one atomic unit, so a call's batch count is part of what it does.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { defineExtension } from "@extensions/definition";
import { s } from "@schema";
import { v } from "@src/validation";
import type { RecordingD1 } from "./d1-statements";

const author = s.model({
  id: s.int().id(),
  tenantId: s.string(),
  name: s.string(),
  deletedAt: s.dateTime().nullable(),
  version: s.int().default(0),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.int().id(),
  tenantId: s.string(),
  title: s.string(),
  authorId: s.int(),
  author: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
  deletedAt: s.dateTime().nullable(),
  version: s.int().default(0),
  comments: s.toMany(() => comment),
});
const comment = s.model({
  id: s.int().id(),
  tenantId: s.string(),
  body: s.string(),
  postId: s.int(),
  post: s
    .toOne(() => post)
    .fields("postId")
    .references("id"),
  deletedAt: s.dateTime().nullable(),
  version: s.int().default(0),
});
const MODELS = ["author", "post", "comment"] as const;
const each = <T>(build: () => T) =>
  Object.fromEntries(MODELS.map((model) => [model, build()])) as Record<
    (typeof MODELS)[number],
    T
  >;
const tenancy = defineExtension({
  name: "tenancy",
  controls: { tenant: { schema: v.string(), required: true } },
  rows: {
    control: "scope",
    default: "tenant",
    models: each(() => ({
      tenant: {
        root: { tenantId: { control: "tenant" } },
        related: { tenantId: { control: "tenant" } },
      },
      all: {},
    })),
  },
  data: {
    models: each(() => ({ create: { tenantId: { control: "tenant" } } })),
  },
});
const soft = defineExtension({
  name: "soft",
  controls: { mode: { oneOf: ["soft", "hard"] } },
  rows: {
    control: "deleted",
    default: "without",
    models: each(() => ({
      without: { root: { deletedAt: null }, related: { deletedAt: null } },
      with: {},
      only: {
        root: { deletedAt: { not: null } },
        related: { deletedAt: null },
      },
    })),
  },
  deletion: {
    removeWhen: { mode: "hard" },
    models: each(() => ({ at: "deletedAt", assign: {} })),
  },
});
const lock = defineExtension({
  name: "lock",
  controls: {
    expectedVersion: { schema: v.number(), on: ["update", "delete"] },
  },
  rows: {
    control: "versionCheck",
    default: "checked",
    models: each(() => ({
      checked: { root: { version: { control: "expectedVersion" } } },
      unchecked: {},
    })),
  },
});

/** An ISO instant among a statement's values: the call's clock, not a pin. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const pinned = (value: unknown) =>
  value instanceof Date || (typeof value === "string" && INSTANT.test(value))
    ? "<instant>"
    : value;

export type Transcript = Record<
  string,
  string | { sql: string; params: unknown[]; batch?: number }[]
>;

/** The chain over `driver`'s fresh tables: the base client and the composed one. */
export async function composedRowsClient(
  driver: AnyDriver,
  prepare: (client: any) => Promise<unknown>
) {
  const base = createClient({ schema: { author, post, comment }, driver });
  await prepare(base);
  // The chain's calls, typed loosely: the statements are the subject.
  const db: any = base.$extends(tenancy).$extends(soft).$extends(lock);
  return { base, db };
}

/** The 27 calls, each with the statements it ran or the error it threw. */
export async function composedRowsTranscript(
  driver: AnyDriver,
  recorder: RecordingD1,
  prepare: (client: any) => Promise<unknown>
): Promise<Transcript> {
  const { base, db } = await composedRowsClient(driver, prepare);
  try {
    const transcript: Transcript = {};
    const at = async (name: string, run: () => Promise<unknown>) => {
      recorder.statements.length = 0;
      try {
        await run();
        // Batches numbered within the call: 1 is the call's first.
        const batches = new Map<number, number>();
        transcript[name] = recorder.statements.map(({ sql, values, batch }) => {
          if (batch !== undefined && !batches.has(batch))
            batches.set(batch, batches.size + 1);
          return {
            sql,
            params: values.map(pinned),
            ...(batch === undefined ? {} : { batch: batches.get(batch)! }),
          };
        });
      } catch (error) {
        transcript[name] =
          `ERROR ${(error as Error).constructor.name}: ${(error as Error).message}`;
      }
    };
    const T = { tenant: "acme" } as const;
    await at("create author", () =>
      db.author.create({ ...T, data: { id: 1, name: "a" } })
    );
    await at("create post nested comments", () =>
      db.post.create({
        ...T,
        data: {
          id: 10,
          title: "t",
          authorId: 1,
          comments: { create: [{ id: 100, body: "b", tenantId: "acme" }] },
        },
      })
    );
    await at("createMany posts", () =>
      db.post.createMany({
        ...T,
        data: [
          { id: 11, title: "u", authorId: 1 },
          { id: 12, title: "v", authorId: 1 },
        ],
      })
    );
    await at("findMany", () => db.post.findMany(T));
    await at("findMany where", () =>
      db.post.findMany({ ...T, where: { title: "t" } })
    );
    await at("findMany all", () => db.post.findMany({ ...T, scope: "all" }));
    await at("findMany with", () =>
      db.post.findMany({ ...T, deleted: "with" })
    );
    await at("findMany only", () =>
      db.post.findMany({ ...T, deleted: "only" })
    );
    await at("findMany include", () =>
      db.author.findMany({
        ...T,
        include: { posts: { include: { comments: true } } },
      })
    );
    await at("findMany include to-one", () =>
      db.post.findMany({ ...T, include: { author: true } })
    );
    await at("relation filters", () =>
      db.author.findMany({
        ...T,
        where: {
          posts: {
            some: { title: "t" },
            none: { title: "x" },
            every: { authorId: 1 },
          },
        },
      })
    );
    await at("is filter", () =>
      db.post.findMany({ ...T, where: { author: { is: { name: "a" } } } })
    );
    await at("count", () => db.post.count(T));
    await at("aggregate", () =>
      db.post.aggregate({ ...T, _count: { _all: true } })
    );
    await at("groupBy", () =>
      db.post.groupBy({ ...T, by: ["authorId"], _count: { _all: true } })
    );
    await at("cursor", () =>
      db.post.findMany({ ...T, cursor: { id: 10 }, take: 2 })
    );
    await at("findUnique", () =>
      db.post.findUnique({ ...T, where: { id: 10 } })
    );
    await at("relation count order", () =>
      db.author.findMany({
        ...T,
        orderBy: { posts: { _count: "desc" } },
        select: { id: true, _count: { select: { posts: true } } },
      })
    );
    await at("update", () =>
      db.post.update({ ...T, where: { id: 10 }, data: { title: "t2" } })
    );
    await at("update locked", () =>
      db.post.update({
        ...T,
        expectedVersion: 0,
        where: { id: 10 },
        data: { title: "t3" },
      })
    );
    await at("updateMany", () =>
      db.post.updateMany({
        ...T,
        where: { title: "u" },
        data: { title: "u2" },
      })
    );
    await at("upsert", () =>
      db.post.upsert({
        ...T,
        where: { id: 13 },
        create: { id: 13, title: "w", authorId: 1 },
        update: { title: "w2" },
      })
    );
    await at("nested update", () =>
      db.author.update({
        ...T,
        where: { id: 1 },
        data: {
          posts: {
            update: { where: { id: 10 }, data: { title: "n" } },
            delete: { id: 13 },
          },
        },
      })
    );
    await at("delete tombstone", () =>
      db.post.delete({ ...T, where: { id: 12 } })
    );
    await at("deleteMany", () =>
      db.comment.deleteMany({ ...T, where: { body: "zz" } })
    );
    await at("delete hard", () =>
      db.post.delete({ ...T, mode: "hard", where: { id: 11 } })
    );
    await at("no tenant", () => db.post.findMany({}));
    return transcript;
  } finally {
    await base.$disconnect();
  }
}

const WRAPPER = "SELECT 1 FROM (SELECT 1 FROM ";
const OPEN = "SELECT 1 FROM (".length;

/** The index of the `)` closing the `(` at `open`, outside quoted text. */
function closing(sql: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let at = open; at < sql.length; at++) {
    const char = sql[at]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return at;
  }
  throw new Error(`unbalanced derived table in ${sql}`);
}

/** Each `SELECT 1 FROM (SELECT 1 FROM … WHERE …)` back to its inner form. */
function unwrapped(sql: string): string {
  let text = sql;
  for (let at = text.indexOf(WRAPPER); at >= 0; at = text.indexOf(WRAPPER)) {
    const end = closing(text, at + OPEN - 1);
    text = text.slice(0, at) + text.slice(at + OPEN, end) + text.slice(end + 1);
  }
  return text;
}

export function unwrapDerivedExists(transcript: Transcript): Transcript {
  return Object.fromEntries(
    Object.entries(transcript).map(([name, entry]) => [
      name,
      typeof entry === "string"
        ? entry
        : entry.map((statement) => ({
            ...statement,
            sql: unwrapped(statement.sql),
          })),
    ])
  );
}
