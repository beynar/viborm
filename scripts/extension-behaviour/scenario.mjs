// The calls `scripts/extension-behaviour.mjs` runs on in-memory SQLite, written
// against the public entries as an application imports them. Sections A to G
// are the hundred calls of the extension rewrite's proposal B; H to N cover
// what they do not touch. Each answer is recorded under its label, so a label
// names one call and never changes meaning: add a call under a new label.

import {
  accepts,
  again,
  arg,
  args,
  around,
  createClient,
  defaults,
  call as extCall,
  extension,
  fields as extFields,
  unit as extUnit,
  methods,
  modelMethods,
  now,
  oneOf,
  raw,
  reads,
  rule,
  sql,
  statement,
  target,
  via,
  when,
  writes,
} from "viborm";
import { cache } from "viborm/cache";
import { MemoryCache } from "viborm/cache/memory";
import { defaultOmit } from "viborm/client";
import { instrumentation } from "viborm/instrumentation";
import { createMigrationClient } from "viborm/migrations";
import { on } from "viborm/on";
import { ordering } from "viborm/ordering";
import { permissions } from "viborm/permissions";
import { s } from "viborm/schema";
import { softDelete } from "viborm/soft-delete";
import { SQLite3Driver } from "viborm/sqlite3";
import { v } from "viborm/validation";

const ISO_INSTANT = /^\d{4}-\d\d-\d\dT/;
const FIRST_LINE = /\n[\s\S]*$/;

// Instants change from run to run, and a bigint is not JSON.
const normalize = (value) =>
  JSON.parse(
    JSON.stringify(value ?? null, (_key, item) => {
      if (typeof item === "string" && ISO_INSTANT.test(item)) return "DATE";
      if (typeof item === "bigint") return Number(item);
      return item;
    })
  );

const errorAnswer = (error) => ({
  error: error?.constructor?.name ?? typeof error,
  code: typeof error?.code === "string" ? error.code : null,
  message: String(error?.message).replace(FIRST_LINE, "").slice(0, 160),
});

// Observer completions and `settled` callbacks may land a tick after the call.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const ids = (rows) => rows.map((row) => row.id).sort();
const keys = (row) => (row ? Object.keys(row).sort() : row);

const blog = () => {
  const user = s.model({
    id: s.string().id(),
    email: s.string().unique(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
    deletedAt: s.dateTime().nullable(),
    tenantId: s.string().nullable(),
    stampedAt: s.dateTime().nullable(),
    views: s.int().default(0),
  });
  return { user, post };
};

const plainBlog = () => {
  const user = s.model({
    id: s.string().id(),
    email: s.string().unique(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  });
  return { user, post };
};

const allFourBlog = () => {
  const user = s.model({
    id: s.string().id(),
    email: s.string().unique(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    title: s.string(),
    rank: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
    deletedAt: s.dateTime().nullable(),
  });
  return { user, post };
};

const open = async (
  schema,
  driver = new SQLite3Driver({ dataDir: ":memory:" })
) => {
  const base = createClient({ schema, driver });
  const migrations = createMigrationClient(base);
  const preview = await migrations.push({ dryRun: true });
  await migrations.push({ consent: preview.consent });
  return base;
};

const seed = async (base) => {
  await base.user.create({ data: { id: "u1", email: "a@example.com" } });
  await base.user.create({ data: { id: "u2", email: "b@example.com" } });
  for (const [id, authorId] of [
    ["p1", "u1"],
    ["p2", "u1"],
    ["p3", "u2"],
  ]) {
    await base.post.create({ data: { id, title: `t ${id}`, authorId } });
  }
};

const seedUsers = async (base) => {
  await base.user.create({ data: { id: "u1", email: "a@example.com" } });
  await base.user.create({ data: { id: "u2", email: "b@example.com" } });
};

const blogPolicy = (deleteRule) =>
  permissions({
    actor: v.object({ userId: v.string(), admin: v.boolean() }),
    models: {
      post: {
        read: {},
        update: { authorId: { actor: "userId" } },
        delete: deleteRule,
        create: { authorId: { actor: "userId" } },
      },
      user: { read: {} },
    },
  });

const softDeleted = async (step) => {
  const base = await open(blog());
  await seed(base);
  const db = base.$extends(
    softDelete({ models: { post: { deletedAt: "deletedAt" } } })
  );
  await step("sd delete", () =>
    db.post
      .delete({ where: { id: "p1" } })
      .then((r) => [r.id, r.deletedAt !== null])
  );
  await step("sd findMany", () => db.post.findMany().then(ids));
  await step("sd with", () => db.post.findMany({ deleted: "with" }).then(ids));
  await step("sd only", () => db.post.findMany({ deleted: "only" }).then(ids));
  await step("sd include", () =>
    db.user
      .findMany({ include: { posts: true }, orderBy: { id: "asc" } })
      .then((users) => users.map((u) => [u.id, ids(u.posts)]))
  );
  await step("sd where relation", () =>
    db.user
      .findMany({ where: { posts: { some: { title: "t p1" } } } })
      .then(ids)
  );
  await step("sd count", () => db.post.count());
  await step("sd update hidden", () =>
    db.post.update({ where: { id: "p1" }, data: { title: "x" } })
  );
  await step("sd delete again", () => db.post.delete({ where: { id: "p1" } }));
  await step("sd restore", () =>
    db.post.restore({ where: { id: "p1" } }).then((r) => [r.id, r.deletedAt])
  );
  await step("sd deleteMany", () =>
    db.post.deleteMany({ where: { authorId: "u1" } })
  );
  await step("sd purgeMany", () => db.post.purgeMany({ where: { id: "p2" } }));
  await step("sd hard", () =>
    db.post.delete({ where: { id: "p3" }, mode: "hard" }).then((r) => r.id)
  );
  await step("sd raw rows", () =>
    base.post
      .findMany()
      .then((rows) => rows.map((r) => [r.id, r.deletedAt !== null]))
  );
  await step("sd bad mode", () => db.post.findMany({ deleted: "nope" }));
  await step("sd tx array", () =>
    db
      .$transaction([db.post.findMany({ deleted: "with" }), db.post.count()])
      .then(([rows, n]) => [ids(rows), n])
  );
  await step("sd tx callback", () =>
    db.$transaction(async (tx) => {
      await tx.post.restore({ where: { id: "p1" } });
      return ids(await tx.post.findMany());
    })
  );
  await step("sd nested delete", () =>
    db.user
      .update({
        where: { id: "u1" },
        data: { posts: { delete: { id: "p1" } } },
        include: { posts: true },
      })
      .then((u) => ids(u.posts))
  );
  await step("sd unknown model", () =>
    base.$extends(softDelete({ models: { nope: { deletedAt: "deletedAt" } } }))
  );
  await base.$disconnect();
};

const ordered = async (step) => {
  const column = s.model({ id: s.string().id(), cards: s.toMany(() => card) });
  const card = s.model({
    id: s.string().id(),
    title: s.string(),
    rank: s.string(),
    columnId: s.string(),
    column: s
      .toOne(() => column)
      .fields("columnId")
      .references("id"),
  });
  const base = await open({ column, card });
  const db = base.$extends(
    ordering({ card: { key: "rank", within: ["columnId"] } })
  );
  await base.column.create({ data: { id: "c1" } });
  for (const id of ["a", "b", "c"]) {
    await step(`or create ${id}`, () =>
      db.card
        .create({ data: { id, title: id, columnId: "c1" } })
        .then((r) => typeof r.rank)
    );
  }
  const list = () => db.card.findMany().then((rows) => rows.map((r) => r.id));
  await step("or list", list);
  await step("or move first", () =>
    db.card.move({ where: { id: "c" }, first: true }).then((r) => r.id)
  );
  await step("or list 2", list);
  await step("or include", () =>
    db.column
      .findMany({ include: { cards: true } })
      .then((cols) => cols.map((c) => c.cards.map((x) => x.id)))
  );
  await step("or explicit order", () =>
    db.card
      .findMany({ orderBy: { id: "desc" } })
      .then((rows) => rows.map((r) => r.id))
  );
  await step("or rekey", () => db.card.rekey({ where: { columnId: "c1" } }));
  await step("or list 3", list);
  await base.$disconnect();
};

const hooked = async (step, note) => {
  const base = await open(blog());
  await seed(base);
  const seen = [];
  const hook = (kind) => (rows) => {
    seen.push([kind, ids(rows)]);
  };
  const db = base.$extends(
    on({
      post: {
        create: hook("create"),
        update: hook("update"),
        delete: hook("delete"),
      },
    })
  );
  await step("on create", () =>
    db.post
      .create({ data: { id: "p9", title: "n", authorId: "u1" } })
      .then((r) => r.id)
  );
  await step("on update", () =>
    db.post.update({
      where: { id: "p9" },
      data: { title: "m" },
      select: { title: true },
    })
  );
  await step("on nested", () =>
    db.user
      .update({
        where: { id: "u2" },
        data: { posts: { create: { id: "p8", title: "k" } } },
      })
      .then((r) => r.id)
  );
  await step("on delete", () =>
    db.post.delete({ where: { id: "p9" } }).then((r) => r.id)
  );
  await step("on tx", () =>
    db.$transaction(async (tx) => {
      await tx.post.create({ data: { id: "p7", title: "t", authorId: "u1" } });
      return seen.length;
    })
  );
  await step("on array", () =>
    db
      .$transaction([
        db.post.create({ data: { id: "p6", title: "t", authorId: "u1" } }),
        db.post.count(),
      ])
      .then(([r, n]) => [r.id, n])
  );
  await step("on rollback", () =>
    db.$transaction(async (tx) => {
      await tx.post.create({ data: { id: "p5", title: "t", authorId: "u1" } });
      throw new Error("no");
    })
  );
  note("on seen", seen);
  await base.$disconnect();
};

const governed = async (step) => {
  const base = await open(plainBlog());
  await seedUsers(base);
  await base.post.create({ data: { id: "p1", title: "one", authorId: "u2" } });
  const db = base.$extends(blogPolicy({ actor: { admin: true } }));
  const call = db.$as({ userId: "u1", admin: false });
  const admin = db.$as({ userId: "u2", admin: true });
  await step("pm unbound", () => db.post.findMany());
  await step("pm read", () => call.post.findMany().then(ids));
  await step("pm include", () =>
    call.user
      .findMany({ include: { posts: true }, orderBy: { id: "asc" } })
      .then((users) => users.map((u) => [u.id, ids(u.posts)]))
  );
  await step("pm create own", () =>
    call.post
      .create({ data: { id: "p2", title: "two", authorId: "u1" } })
      .then((r) => r.id)
  );
  await step("pm create other", () =>
    call.post.create({ data: { id: "p3", title: "three", authorId: "u2" } })
  );
  await step("pm update own", () =>
    call.post
      .update({ where: { id: "p2" }, data: { title: "TWO" } })
      .then((r) => r.title)
  );
  await step("pm update other", () =>
    call.post.update({ where: { id: "p1" }, data: { title: "x" } })
  );
  await step("pm move away", () =>
    call.post.update({ where: { id: "p2" }, data: { authorId: "u2" } })
  );
  await step("pm delete not admin", () =>
    call.post.delete({ where: { id: "p2" } })
  );
  // `can` was removed: an application reads the row's `$access`.
  const can = (delegate, action, id) =>
    delegate
      .findUnique({ where: { id }, select: { $access: [action] } })
      .then((row) => row?.$access[action] === true);
  await step("pm can", () => can(call.post, "update", "p2"));
  await step("pm can other", () => can(call.post, "update", "p1"));
  await step("pm access", () =>
    call.post.findMany({
      select: { id: true, $access: true },
      orderBy: { id: "asc" },
    })
  );
  await step("pm user write", () =>
    call.user.update({ where: { id: "u1" }, data: { email: "z@example.com" } })
  );
  await step("pm admin delete", () =>
    admin.post.delete({ where: { id: "p2" } }).then((r) => r.id)
  );
  await step("pm updateMany", () =>
    admin.post.updateMany({ where: {}, data: { title: "all" } })
  );
  await step("pm tx array", () =>
    db
      .$transaction([call.post.findMany(), admin.post.count()])
      .then(([rows, n]) => [ids(rows), n])
  );
  await step("pm tx callback", () =>
    call.$transaction(async (tx) => ids(await tx.post.findMany()))
  );
  await step("pm bad actor", () => db.$as({ userId: 1 }));
  await base.$disconnect();
};

const tenancyDefinition = () =>
  extension(
    "tenancy",
    args({
      tenant: accepts(v.string()).required(["post"]),
      reason: oneOf("typo", "legal").on(writes),
      scope: oneOf("tenant", "all").default("tenant"),
    }),
    rule({
      post: {
        root: when(arg("scope"), "tenant", { tenantId: arg("tenant") }),
        related: when(arg("scope"), "tenant", { tenantId: arg("tenant") }),
      },
    }),
    defaults({
      post: {
        orderBy: [{ title: "desc" }],
        create: { tenantId: arg("tenant"), stampedAt: now },
        update: { views: { increment: 1 } },
      },
    })
  );

const tenanted = async (step) => {
  const base = await open(blog());
  await seed(base);
  await base.post.updateMany({
    where: { authorId: "u1" },
    data: { tenantId: "acme" },
  });
  await base.post.updateMany({
    where: { authorId: "u2" },
    data: { tenantId: "globex" },
  });
  const tenancy = tenancyDefinition();
  const db = base.$extends(tenancy);
  await step("tn read", () =>
    db.post.findMany({ tenant: "acme" }).then((rows) => rows.map((r) => r.id))
  );
  await step("tn all", () =>
    db.post.findMany({ tenant: "acme", scope: "all" }).then(ids)
  );
  await step("tn missing", () => db.post.findMany());
  await step("tn bad", () => db.post.findMany({ tenant: 3 }));
  await step("tn related", () =>
    db.user
      .findMany({
        tenant: "globex",
        include: { posts: true },
        orderBy: { id: "asc" },
      })
      .then((users) => users.map((u) => [u.id, ids(u.posts)]))
  );
  await step("tn create", () =>
    db.post
      .create({
        tenant: "acme",
        data: { id: "p4", title: "four", authorId: "u1" },
      })
      .then((r) => [r.tenantId, r.stampedAt !== null, r.views])
  );
  await step("tn create explicit", () =>
    db.post
      .create({
        tenant: "acme",
        data: { id: "p5", title: "five", authorId: "u1", tenantId: "globex" },
      })
      .then((r) => r.tenantId)
  );
  await step("tn update", () =>
    db.post
      .update({
        tenant: "acme",
        where: { id: "p4" },
        data: { title: "FOUR" },
        reason: "typo",
      })
      .then((r) => [r.title, r.views])
  );
  await step("tn update other tenant", () =>
    db.post.update({
      tenant: "acme",
      where: { id: "p3" },
      data: { title: "x" },
    })
  );
  await step("tn bad reason", () =>
    db.post.update({
      tenant: "acme",
      where: { id: "p4" },
      data: { title: "y" },
      reason: "nope",
    })
  );
  await step("tn reason on read", () =>
    db.post.findMany({ tenant: "acme", reason: "typo" })
  );
  await step("tn count", () => db.post.count({ tenant: "globex" }));
  await step("tn typo filter", () =>
    base.$extends(
      extension(
        "typo",
        args({ m: oneOf("d").default("d") }),
        rule({ post: { root: when(arg("m"), "d", { tenantIdd: "x" }) } })
      )
    )
  );
  await step("tn dup control", () =>
    db.$extends(extension("again", args({ tenant: oneOf(1) })))
  );
  await step("tn dup name", () => db.$extends(tenancy));
  await base.$disconnect();
};

const handlers = async (step, note) => {
  const base = await open(blog());
  await seed(base);
  const log = [];
  const tools = extension(
    "tools",
    extCall((c) => {
      c.set({ take: Math.min(c.args.take ?? 2, 2) });
    }),
    around((c) => async (run) => {
      log.push(["query", c.model ?? c.kind, c.operation]);
      const result = await run();
      log.push([
        "after",
        Array.isArray(result) ? result.length : typeof result,
      ]);
      return result;
    }),
    extUnit(
      (u, next) => {
        log.push(["statement"]);
        return next(statement(u));
      },
      ["statement"],
      { rewrites: true }
    ),
    methods((scope) => ({ $postCount: () => scope.post.count() })),
    modelMethods(() => ({
      post: (delegate) => ({
        titled: (title) => delegate.findMany({ where: { title } }),
      }),
    }))
  );
  const db = base.$extends(tools).$extends(
    extension(
      "names",
      extFields({
        user: {
          handle: {
            needs: { email: true },
            compute: (user) => user.email.split("@")[0],
          },
        },
      })
    )
  );
  await step("hk findMany", () =>
    db.post.findMany({ orderBy: { id: "asc" } }).then(ids)
  );
  await step("hk method", () => db.post.titled("t p1").then(ids));
  await step("hk client method", () => db.$postCount());
  await step("hk result", () =>
    db.user.findMany({
      orderBy: { id: "asc" },
      select: { id: true, handle: true },
    })
  );
  await step("hk array", () =>
    db
      .$transaction([
        db.post.findMany({ orderBy: { id: "asc" } }),
        db.post.count(),
      ])
      .then(([rows, n]) => [ids(rows), n])
  );
  await step("hk write", () =>
    db.post
      .update({ where: { id: "p1" }, data: { title: "w" } })
      .then((r) => r.title)
  );
  await step("hk collide", () =>
    base.$extends(
      extension(
        "bad",
        methods(() => ({ $transaction: () => 1 }))
      )
    )
  );
  await step("hk no proceed", () =>
    base
      .$extends(
        extension(
          "np",
          around(() => async (_run) => 1)
        )
      )
      .post.update({ where: { id: "p1" }, data: { title: "q" } })
  );
  note("hk log", log);
  await base.$disconnect();
};

const allFour = (base, seen, inner = base) => {
  const remember = (kind) => (rows) => {
    seen.push([kind, ids(rows)]);
  };
  return inner
    .$extends(
      on({
        post: {
          create: remember("create"),
          update: remember("update"),
          delete: remember("delete"),
        },
      })
    )
    .$extends(softDelete({ models: { post: { deletedAt: "deletedAt" } } }))
    .$extends(ordering({ post: { key: "rank", within: ["authorId"] } }))
    .$extends(blogPolicy({ authorId: { actor: "userId" } }));
};

const everyOfficial = async (step, note) => {
  const base = await open(allFourBlog());
  await seedUsers(base);
  const seen = [];
  const db = allFour(base, seen);
  const u1 = db.$as({ userId: "u1", admin: false });
  const u2 = db.$as({ userId: "u2", admin: false });
  for (const id of ["a", "b", "c"]) {
    await step(`all create ${id}`, () =>
      u1.post
        .create({ data: { id, title: id, authorId: "u1" } })
        .then((r) => r.id)
    );
  }
  await step("all create u2", () =>
    u2.post
      .create({ data: { id: "z", title: "z", authorId: "u2" } })
      .then((r) => r.id)
  );
  await step("all create forged", () =>
    u1.post.create({ data: { id: "f", title: "f", authorId: "u2" } })
  );
  const mine = () =>
    u1.post
      .findMany({ where: { authorId: "u1" } })
      .then((rows) => rows.map((r) => r.id));
  await step("all list", mine);
  await step("all move", () =>
    u1.post.move({ where: { id: "c" }, first: true }).then((r) => r.id)
  );
  // `z` is alone and first in its list: the move writes nothing. Its key is
  // random, so the answer keeps the row's identity only.
  await step("all move other", () =>
    u1.post
      .move({ where: { id: "z" }, first: true })
      .then((r) => [r.id, r.authorId])
  );
  await step("all list 2", mine);
  await step("all delete", () =>
    u1.post
      .delete({ where: { id: "a" } })
      .then((r) => [r.id, r.deletedAt !== null])
  );
  await step("all delete other", () => u1.post.delete({ where: { id: "z" } }));
  await step("all list 3", () => u2.post.findMany().then(ids));
  await step("all with", () => u2.post.findMany({ deleted: "with" }).then(ids));
  await step("all only", () =>
    u1.post.findMany({ deleted: "only", select: { id: true, $access: true } })
  );
  await step("all restore other", () =>
    u2.post.restore({ where: { id: "a" } })
  );
  await step("all restore", () =>
    u1.post.restore({ where: { id: "a" } }).then((r) => r.id)
  );
  await step("all include", () =>
    u2.user
      .findMany({ include: { posts: true }, orderBy: { id: "asc" } })
      .then((users) => users.map((u) => [u.id, u.posts.map((p) => p.id)]))
  );
  await step("all purge", () =>
    u1.post.purge({ where: { id: "b" } }).then((r) => r.id)
  );
  await step("all tx", () =>
    db.$transaction([
      u1.post.count(),
      u2.post.updateMany({ where: {}, data: { title: "mine" } }),
    ])
  );
  await step("all raw", () =>
    base.post
      .findMany({ orderBy: { id: "asc" } })
      .then((rows) => rows.map((r) => [r.id, r.title, r.deletedAt !== null]))
  );
  note("all seen", seen);
  await base.$disconnect();
};

const unitName = (unit) =>
  [unit.kind, unit.model, unit.operation].filter(Boolean).join(":");

const cached = async (step) => {
  const base = await open(blog());
  await seed(base);
  const units = [];
  const counter = extension(
    "units",
    extUnit((u, next) => {
      units.push(unitName(u));
      return next();
    })
  );
  const db = base
    .$extends(counter)
    .$extends(cache({ driver: new MemoryCache(), version: "1" }));
  const reader = db.$withCache({ ttl: 60_000 });
  // The units a call opens tell a hit (no statement) from a miss.
  const measured = async (run) => {
    units.length = 0;
    const value = await run();
    await tick();
    return { value, units: [...units] };
  };
  const titles = () =>
    reader.post
      .findMany({ orderBy: { id: "asc" } })
      .then((rows) => rows.map((r) => [r.id, r.title]));
  await step("ca miss", () => measured(titles));
  await step("ca hit", () => measured(titles));
  await step("ca other arguments", () =>
    measured(() =>
      reader.post.findMany({ where: { authorId: "u2" } }).then(ids)
    )
  );
  await step("ca include", () =>
    measured(() =>
      reader.user
        .findMany({ include: { posts: true }, orderBy: { id: "asc" } })
        .then((users) => users.map((u) => [u.id, ids(u.posts)]))
    )
  );
  await step("ca include hit", () =>
    measured(() =>
      reader.user
        .findMany({ include: { posts: true }, orderBy: { id: "asc" } })
        .then((users) => users.map((u) => [u.id, ids(u.posts)]))
    )
  );
  await step("ca write invalidates", () =>
    measured(() =>
      db.post
        .update({ where: { id: "p1" }, data: { title: "changed" } })
        .then((r) => r.title)
    )
  );
  await step("ca after write", () => measured(titles));
  await step("ca write kept", () =>
    measured(() =>
      db.post
        .update({
          where: { id: "p2" },
          data: { title: "quiet" },
          cache: { autoInvalidate: false },
        })
        .then((r) => r.title)
    )
  );
  await step("ca stale after kept write", () => measured(titles));
  await step("ca invalidate", () => measured(() => db.$invalidate("post:*")));
  await step("ca after invalidate", () => measured(titles));
  await step("ca bad option", () =>
    db.post.update({
      where: { id: "p2" },
      data: { title: "x" },
      cache: { autoInvalidate: "yes" },
    })
  );
  await step("ca bad invalidate", () => db.$invalidate("viborm:post"));
  await step("ca bypass", () =>
    measured(() =>
      db.$withCache({ ttl: 60_000, bypass: true }).post.findMany().then(ids)
    )
  );
  await step("ca in transaction", () =>
    measured(() => db.$transaction(async (tx) => ids(await tx.post.findMany())))
  );
  await step("ca array", () =>
    measured(() =>
      db
        .$transaction([reader.post.findMany(), reader.post.count()])
        .then(([rows, n]) => [ids(rows), n])
    )
  );
  const rewritten = db.$extends(
    extension(
      "rewrites",
      extUnit((u, next) => next(statement(u)), ["statement"], {
        rewrites: true,
      })
    )
  );
  const rewrittenRead = () =>
    rewritten.$withCache({ ttl: 60_000 }).post.findMany().then(ids);
  await step("ca statement chain", () => measured(rewrittenRead));
  await step("ca statement chain again", () => measured(rewrittenRead));
  await step("ca no cache method on base", () => typeof base.$withCache);
  await base.$disconnect();
};

const JITTER = /^\d\d$/;
const STABLE_ATTRIBUTE = /^(db\.|viborm\.|error)/;
const VARYING_ATTRIBUTE = /duration|time|correlation|\.id$/i;

const instrumented = async (step) => {
  const base = await open(blog());
  await seed(base);
  const events = [];
  const observer = extension(
    "observer",
    extUnit((u, next) => {
      events.push(["start", unitName(u)]);
      next().then((completion) => {
        events.push(["end", unitName(u), completion.status]);
      });
    })
  );
  const spans = [];
  const tracer = {
    startActiveSpan(name, run) {
      const attributes = {};
      spans.push(["start", name]);
      return run({
        setAttribute(key, value) {
          attributes[key] = value;
        },
        end() {
          const kept = Object.keys(attributes)
            .filter((key) => STABLE_ATTRIBUTE.test(key))
            .filter((key) => !VARYING_ATTRIBUTE.test(key))
            .sort()
            .map((key) => [key, attributes[key]]);
          spans.push(["end", name, kept]);
        },
      });
    },
  };
  const logs = [];
  const logged = (level) => (event) => {
    logs.push([
      level,
      event.model ?? null,
      event.operation ?? null,
      event.sql ?? null,
      event.params ?? null,
      event.error?.name ?? null,
    ]);
  };
  const db = base.$extends(observer).$extends(
    instrumentation({
      tracing: { tracer, includeSql: true },
      logging: {
        query: logged("query"),
        error: logged("error"),
        includeSql: true,
        includeParams: true,
      },
    })
  );
  const watched = async (run) => {
    events.length = 0;
    spans.length = 0;
    logs.length = 0;
    let value;
    try {
      value = await run();
    } catch (error) {
      value = errorAnswer(error);
    }
    await tick();
    return { value, events: [...events], spans: [...spans], logs: [...logs] };
  };
  await step("in read", () =>
    watched(() =>
      db.user
        .findMany({ include: { posts: true }, orderBy: { id: "asc" } })
        .then((users) => users.map((u) => [u.id, ids(u.posts)]))
    )
  );
  await step("in write", () =>
    watched(() =>
      db.user
        .update({
          where: { id: "u2" },
          data: { posts: { create: { id: "p8", title: "nested" } } },
        })
        .then((r) => r.id)
    )
  );
  await step("in failed write", () =>
    watched(() =>
      db.post.update({ where: { id: "nope" }, data: { title: "x" } })
    )
  );
  await step("in transaction", () =>
    watched(() =>
      db.$transaction(async (tx) => {
        await tx.post.update({ where: { id: "p1" }, data: { title: "tx" } });
        return tx.post.count();
      })
    )
  );
  await step("in array", () =>
    watched(() => db.$transaction([db.post.count(), db.user.count()]))
  );
  await step("in second observes", () =>
    db.$extends(
      extension(
        "second",
        extUnit((_u, _next) => {
          return undefined;
        })
      )
    )
  );
  await base.$disconnect();
};

const omitted = async (step) => {
  const user = s.model({
    id: s.string().id(),
    email: s.string().unique(),
    secret: s.string(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  });
  const base = await open({ user, post });
  await base.user.create({ data: { id: "u1", email: "a@x", secret: "s1" } });
  await base.post.create({ data: { id: "p1", title: "t", authorId: "u1" } });
  const db = base.$extends(defaultOmit({ user: { secret: true } }));
  await step("om root", () =>
    db.user.findMany().then((rows) => rows.map(keys))
  );
  await step("om nested", () =>
    db.post
      .findMany({ include: { author: true } })
      .then((rows) => rows.map((r) => keys(r.author)))
  );
  await step("om nested to-many", () =>
    db.user
      .findFirst({ include: { posts: { include: { author: true } } } })
      .then((u) => [keys(u), keys(u.posts[0].author)])
  );
  await step("om explicit keep", () =>
    db.user.findFirst({ omit: { secret: false } }).then(keys)
  );
  await step("om select", () =>
    db.user.findFirst({ select: { id: true, secret: true } })
  );
  await step("om create", () =>
    db.user
      .create({ data: { id: "u2", email: "b@x", secret: "s2" } })
      .then(keys)
  );
  await step("om update", () =>
    db.user.update({ where: { id: "u2" }, data: { email: "c@x" } }).then(keys)
  );
  await step("om array", () =>
    db
      .$transaction([db.user.findMany(), db.post.findMany()])
      .then(([users, posts]) => [users.map(keys), posts.map(keys)])
  );
  await step("om unknown field", () =>
    base.$extends(defaultOmit({ user: { nope: true } }))
  );
  await step("om base unchanged", () =>
    base.user.findFirst({ where: { id: "u1" } }).then(keys)
  );
  await base.$disconnect();
};

const computed = async (step) => {
  const base = await open(blog());
  await seed(base);
  const fields = {
    user: {
      handle: {
        needs: { email: true },
        compute: (user) => user.email.split("@")[0],
      },
    },
    post: {
      loud: {
        needs: { title: true },
        compute: (row) => row.title.toUpperCase(),
      },
    },
  };
  const db = base.$extends(extension("fields", extFields(fields)));
  await step("rs root", () =>
    db.post
      .findMany({ orderBy: { id: "asc" } })
      .then((rows) => rows.map((r) => [r.id, r.loud]))
  );
  await step("rs nested", () =>
    db.post
      .findFirst({ where: { id: "p3" }, include: { author: true } })
      .then((r) => [r.loud, r.author.handle])
  );
  await step("rs select only", () =>
    db.user.findUnique({ where: { id: "u1" }, select: { handle: true } })
  );
  await step("rs omit", () =>
    db.user
      .findUnique({ where: { id: "u1" }, omit: { handle: true } })
      .then(keys)
  );
  await step("rs create", () =>
    db.post
      .create({ data: { id: "p4", title: "made", authorId: "u2" } })
      .then((r) => r.loud)
  );
  await step("rs array", () =>
    db
      .$transaction([
        db.user.findMany({ orderBy: { id: "asc" } }),
        db.post.count(),
      ])
      .then(([users, n]) => [users.map((u) => u.handle), n])
  );
  await step("rs callback", () =>
    db.$transaction(async (tx) =>
      tx.user
        .findMany({ orderBy: { id: "asc" } })
        .then((users) => users.map((u) => u.handle))
    )
  );
  await step("rs unknown need", () =>
    base.$extends(
      extension(
        "bad-need",
        extFields({ user: { x: { needs: { nope: true }, compute: () => 1 } } })
      )
    )
  );
  await step("rs relation name", () =>
    base.$extends(
      extension(
        "bad-name",
        extFields({ user: { posts: { needs: {}, compute: () => 1 } } })
      )
    )
  );
  // A known fault of the starting commit, recorded so its fix shows: a
  // `result` built through `defineExtension` is read again by `$extends`.
  await step("rs through defineExtension", () =>
    base
      .$extends(extension("defined", extFields(fields)))
      .user.findMany()
      .then((users) => users.map((u) => u.handle))
  );
  await base.$disconnect();
};

const arrays = async (step, note) => {
  const base = await open(blog());
  await seed(base);
  const log = [];
  const db = base.$extends(
    extension(
      "around",
      around((c) => async (run) => {
        log.push(["before", c.model, c.operation]);
        const result = await run();
        log.push(["after", c.model, c.operation]);
        return Array.isArray(result) ? result.length : result;
      })
    )
  );
  await step("ar mapped", () =>
    db.$transaction([
      db.post.findMany(),
      db.post.update({ where: { id: "p1" }, data: { title: "arr" } }),
      db.user.count(),
    ])
  );
  await step("ar member fails", () =>
    db.$transaction([
      db.post.create({ data: { id: "p9", title: "n", authorId: "u1" } }),
      db.post.update({ where: { id: "nope" }, data: { title: "x" } }),
    ])
  );
  await step("ar rolled back", () =>
    base.post.findUnique({ where: { id: "p9" } })
  );
  const skipping = base.$extends(
    extension(
      "skip",
      around((c) => async (run) => (c.operation === "findMany" ? [] : run()))
    )
  );
  await step("ar handler skips", () =>
    skipping.$transaction([skipping.post.findMany(), skipping.post.count()])
  );
  await step("ar direct skip", () => skipping.post.findMany());
  const refusing = base.$extends(
    extension(
      "refuse",
      around((c) => async (run) => {
        if (c.operation === "create") throw new Error("refused by handler");
        return await run();
      })
    )
  );
  await step("ar handler throws", () =>
    refusing.$transaction([
      refusing.post.update({ where: { id: "p2" }, data: { title: "gone" } }),
      refusing.post.create({ data: { id: "p8", title: "n", authorId: "u1" } }),
    ])
  );
  await step("ar after throw", () =>
    base.post.findUnique({ where: { id: "p2" } }).then((r) => r.title)
  );
  note("ar log", log);
  await base.$disconnect();
};

const routed = async (step, note) => {
  const schema = blog();
  const base = await open(schema);
  await seed(base);
  // The statement transform breaks the next `broken` statements, so a read
  // fails with nothing written and `retry` is asked.
  let broken = 0;
  const attempts = [];
  const db = base.$extends(
    extension(
      "resilience",
      around((c) => {
        const retry = (error, attempt, call) => {
          attempts.push([
            error?.constructor?.name,
            attempt,
            call.model,
            call.operation,
          ]);
          return attempt < 2;
        };
        return async (run) => {
          for (let attempt = 1; ; attempt++) {
            try {
              return await run();
            } catch (error) {
              if (
                !(
                  again(run) &&
                  (await retry(error, attempt, {
                    model: c.model,
                    operation: c.operation,
                  }))
                )
              )
                throw error;
            }
          }
        };
      }),
      extUnit(
        (u, next) => {
          if (broken === 0) return next(statement(u));
          broken -= 1;
          return next(sql`${raw("SELECT missing FROM no_such_table")}`);
        },
        ["statement"],
        { rewrites: true }
      )
    )
  );
  await step("rt read retried", () => {
    broken = 1;
    return db.post.findMany().then(ids);
  });
  await step("rt read exhausted", () => {
    broken = 5;
    return db.post.findMany();
  });
  await step("rt in transaction", () => {
    broken = 1;
    return db.$transaction(async (tx) => tx.post.findMany());
  });
  await step("rt write", () => {
    broken = 1;
    return db.post.update({ where: { id: "p1" }, data: { title: "r" } });
  });
  await step("rt array member", () => {
    broken = 1;
    return db.$transaction([db.post.count(), db.user.count()]);
  });
  broken = 0;
  note("rt attempts", attempts);

  const replicaDriver = new SQLite3Driver({ dataDir: ":memory:" });
  const replica = await open(schema, replicaDriver);
  await replica.user.create({ data: { id: "r1", email: "r@example.com" } });
  await replica.post.create({
    data: { id: "r1", title: "replica", authorId: "r1" },
  });
  const asked = [];
  const routedDb = base.$extends(
    extension(
      "replica",
      around((c) => {
        const route = ({ model, operation }) => {
          asked.push([model, operation]);
          return operation.startsWith("find") ? replicaDriver : undefined;
        };
        return (run) => {
          // `via` routes a read outside a transaction only: only then asked.
          if (run.mode !== "direct") return run();
          const driver = route({
            model: c.model,
            operation: c.operation,
            args: run.input,
          });
          return driver === undefined ? run() : via(run, driver);
        };
      }, target(reads))
    )
  );
  await step("ro read", () => routedDb.post.findMany().then(ids));
  await step("ro count", () => routedDb.post.count());
  await step("ro write", () =>
    routedDb.post
      .create({ data: { id: "p7", title: "w", authorId: "u1" } })
      .then((r) => r.id)
  );
  await step("ro write landed", () =>
    Promise.all([base.post.count(), replica.post.count()])
  );
  await step("ro in transaction", () =>
    routedDb.$transaction(async (tx) => ids(await tx.post.findMany()))
  );
  await step("ro array", () =>
    routedDb
      .$transaction([routedDb.post.findMany()])
      .then(([rows]) => ids(rows))
  );
  note("ro asked", asked);
  await replica.$disconnect();
  await base.$disconnect();
};

const statements = async (step) => {
  const base = await open(allFourBlog());
  await seedUsers(base);
  const logs = [];
  const traced = base.$extends(
    instrumentation({
      logging: {
        query: (event) => {
          logs.push([event.sql ?? null, event.params ?? null]);
        },
        includeSql: true,
        includeParams: true,
      },
    })
  );
  const db = allFour(base, [], traced);
  const u1 = db.$as({ userId: "u1", admin: false });
  const captured = async (run) => {
    logs.length = 0;
    let value;
    try {
      value = await run();
    } catch (error) {
      value = errorAnswer(error);
    }
    return { value, sql: [...logs] };
  };
  await step("sq create", () =>
    captured(() =>
      u1.post
        .create({ data: { id: "a", title: "a", authorId: "u1" } })
        .then((r) => r.id)
    )
  );
  await u1.post.create({ data: { id: "b", title: "b", authorId: "u1" } });
  await step("sq read", () =>
    captured(() => u1.post.findMany({ where: { authorId: "u1" } }).then(ids))
  );
  await step("sq include", () =>
    captured(() =>
      u1.user
        .findMany({ include: { posts: true } })
        .then((users) => users.map((u) => [u.id, ids(u.posts)]))
    )
  );
  // A moved key ends in two random digits, bound as one parameter.
  await step("sq move", () =>
    captured(() =>
      u1.post.move({ where: { id: "b" }, first: true }).then((r) => r.id)
    ).then(({ value, sql: sent }) => ({
      value,
      sql: sent.map(([text, params]) => [
        text,
        params?.map((param) => (JITTER.test(param) ? "RANDOM" : param)),
      ]),
    }))
  );
  await step("sq update", () =>
    captured(() =>
      u1.post
        .update({ where: { id: "a" }, data: { title: "A" } })
        .then((r) => r.title)
    )
  );
  await step("sq delete", () =>
    captured(() => u1.post.delete({ where: { id: "a" } }).then((r) => r.id))
  );
  await step("sq restore", () =>
    captured(() => u1.post.restore({ where: { id: "a" } }).then((r) => r.id))
  );
  await step("sq can", () =>
    captured(() =>
      u1.post
        .findUnique({ where: { id: "a" }, select: { $access: ["delete"] } })
        .then((row) => row?.$access.delete === true)
    )
  );
  await step("sq access", () =>
    captured(() =>
      u1.post.findMany({
        select: { id: true, $access: true },
        orderBy: { id: "asc" },
      })
    )
  );

  const tenantBase = await open(blog());
  await seed(tenantBase);
  const tenantLogs = [];
  const tenantDb = tenantBase
    .$extends(
      instrumentation({
        logging: {
          query: (event) => {
            tenantLogs.push([event.sql ?? null, event.params ?? null]);
          },
          includeSql: true,
          includeParams: true,
        },
      })
    )
    .$extends(tenancyDefinition());
  const tenantCaptured = async (run) => {
    tenantLogs.length = 0;
    let value;
    try {
      value = await run();
    } catch (error) {
      value = errorAnswer(error);
    }
    return { value, sql: [...tenantLogs] };
  };
  await step("sq tenant read", () =>
    tenantCaptured(() =>
      tenantDb.user
        .findMany({ tenant: "acme", include: { posts: true } })
        .then((users) => users.map((u) => [u.id, ids(u.posts)]))
    )
  );
  await step("sq tenant create", () =>
    tenantCaptured(() =>
      tenantDb.post
        .create({
          tenant: "acme",
          data: { id: "p4", title: "f", authorId: "u1" },
        })
        .then((r) => r.tenantId)
    )
  );
  await step("sq tenant update", () =>
    tenantCaptured(() =>
      tenantDb.post
        .update({ tenant: "acme", where: { id: "p4" }, data: { title: "F" } })
        .then((r) => r.views)
    )
  );
  await tenantBase.$disconnect();
  await base.$disconnect();
};

export const SECTIONS = {
  A: softDeleted,
  B: ordered,
  C: hooked,
  D: governed,
  E: tenanted,
  F: handlers,
  G: everyOfficial,
  H: cached,
  I: instrumented,
  J: omitted,
  K: computed,
  L: arrays,
  M: routed,
  N: statements,
};

/** Run the sections named (all when none is) and return their answers in order. */
export async function run(only) {
  const answers = [];
  const step = async (label, call) => {
    try {
      answers.push([label, "ok", normalize(await call())]);
    } catch (error) {
      answers.push([label, "err", errorAnswer(error)]);
    }
  };
  const note = (label, value) => {
    answers.push([label, "ok", normalize(value)]);
  };
  for (const [name, section] of Object.entries(SECTIONS)) {
    if (only.length > 0 && !only.includes(name)) continue;
    await section(step, note);
    await tick();
  }
  return answers;
}
