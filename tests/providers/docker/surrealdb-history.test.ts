/**
 * Migration history on SurrealDB: generate, apply, verify, down and reset, end to
 * end against a server. Gated on SURREAL_TEST_URL.
 */

import { createClient } from "@client/client";
import "@migrations/dialects/surrealql";
import { createMigrationClient } from "@migrations/client";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import {
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { describe, expect, it } from "vitest";

const UNIQUE_FAILURE = /Unique/;

const first = () => {
  const author = s.model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.int().id().increment(),
    title: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  });
  return { author, post };
};

const second = () => {
  const author = s.model({
    id: s.string().id(),
    name: s.string(),
    bio: s.string().nullable(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.int().id().increment(),
    title: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
    tags: s.toMany(() => tag),
  });
  const tag = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  return { author, post, tag };
};

const renaming = (change: any) =>
  change.type === "ambiguous" ? change.rename() : undefined;
const pushing = async (client: any) => {
  const migrations = createMigrationClient(client);
  const preview = await migrations.push({ dryRun: true, resolve: renaming });
  return await migrations.push({ consent: preview.consent, resolve: renaming });
};

describe.skipIf(!surrealUrl)("the rest of what a history answers", () => {
  it("reads its log, list and graph, baselines a pushed database, and prunes", async () => {
    const schema = () => ({
      item: s.model({ id: s.string().id(), label: s.string() }),
    });
    const driver = createSurrealTestDriver();
    const client: any = createClient({ schema: schema(), driver });
    try {
      await pushing(client);
      const storage = new MemoryEstateStorage();
      const migrations = createMigrationClient(client, { storage });
      const generated = await migrations.generate({ name: "init" });
      await expect(migrations.apply()).rejects.toThrow();
      await migrations.baseline({ stateId: generated.stateId } as never);
      await expect(migrations.verify()).resolves.toEqual({ ok: true });
      expect(await migrations.status()).toMatchObject({ pending: [] });
      expect((await migrations.log()).length).toBeGreaterThan(0);
      expect((await migrations.list()).length).toBeGreaterThan(0);
      await migrations.graph();
      await migrations.check();
    } finally {
      await client.$disconnect();
    }
  });
});

describe.skipIf(!surrealUrl)("Studio's plan of a statement", () => {
  it("reads a plan, with the lists a statement holds ahead of it", async () => {
    const client: any = createClient({
      schema: { item: s.model({ id: s.string().id(), n: s.int() }) },
      driver: createSurrealTestDriver(),
    });
    try {
      await pushing(client);
      await client.item.create({ data: { id: "a", n: 1 } });
      const { explainStatements } = await import(
        "../../../packages/studio/src/explain"
      );
      const [read] = await explainStatements(
        client,
        "surrealql",
        [
          {
            sql: "LET $h1 = [1]; SELECT id AS id FROM item WHERE n IN $h1 ORDER BY id ASC",
            params: [],
          } as never,
        ],
        true
      );
      expect(read).toMatchObject({ plan: { analyzed: true } });
    } finally {
      await client.$disconnect();
    }
  });
});

describe.skipIf(!surrealUrl)("what SQL can change in place", () => {
  it("a renamed field keeps its values, its index and its reference", async () => {
    const before = () => {
      const team = s.model({
        id: s.string().id(),
        people: s.toMany(() => person),
      });
      const person = s
        .model({
          id: s.string().id(),
          email: s.string().unique(),
          age: s.int(),
          teamId: s.string(),
          team: s
            .toOne(() => team)
            .fields("teamId")
            .references("id"),
        })
        .index(["age"]);
      return { team, person };
    };
    const after = () => {
      const team = s.model({
        id: s.string().id(),
        people: s.toMany(() => person),
      });
      const person = s
        .model({
          id: s.string().id(),
          mail: s.string().unique(),
          years: s.int(),
          teamRef: s.string(),
          team: s
            .toOne(() => team)
            .fields("teamRef")
            .references("id"),
        })
        .index(["years"]);
      return { team, person };
    };
    const driver = createSurrealTestDriver();
    const first: any = createClient({ schema: before(), driver });
    try {
      await pushing(first);
      await first.team.create({ data: { id: "t" } });
      await first.person.create({
        data: { id: "p", email: "e", age: 30, teamId: "t" },
      });
      const second: any = createClient({ schema: after(), driver });
      await pushing(second);
      expect(await second.person.findMany()).toEqual([
        { id: "p", mail: "e", years: 30, teamRef: "t" },
      ]);
      await expect(
        second.person.create({
          data: { id: "q", mail: "e", years: 1, teamRef: "t" },
        })
      ).rejects.toThrow(UNIQUE_FAILURE);
      expect(
        await second.team.findMany({
          include: { people: { select: { id: true } } },
        })
      ).toEqual([{ id: "t", people: [{ id: "p" }] }]);
      await expect(createMigrationClient(second).push()).resolves.toMatchObject(
        {
          outcome: "noop",
        }
      );
    } finally {
      await first.$disconnect();
    }
  });

  it("a renamed table keeps its rows, what holds them and its numbering", async () => {
    const tables = (map: string) => {
      const author = s
        .model({
          id: s.int().id().increment(),
          name: s.string(),
          boss: s.int().nullable(),
          manager: s
            .toOne(() => author)
            .fields("boss")
            .references("id")
            .name("tree"),
          reports: s.toMany(() => author).name("tree"),
          posts: s.toMany(() => post),
          tags: s.toMany(() => tag),
        })
        .map(map);
      const post = s.model({
        id: s.string().id(),
        authorId: s.int(),
        author: s
          .toOne(() => author)
          .fields("authorId")
          .references("id"),
      });
      const tag = s.model({
        id: s.string().id(),
        authors: s.toMany(() => author),
      });
      return { author, post, tag };
    };
    const driver = createSurrealTestDriver();
    const first: any = createClient({ schema: tables("writers"), driver });
    try {
      await pushing(first);
      const ada = await first.author.create({ data: { name: "Ada" } });
      await first.author.create({ data: { name: "Bob", boss: ada.id } });
      await first.post.create({ data: { id: "p", authorId: ada.id } });
      await first.tag.create({
        data: { id: "t", authors: { connect: { id: ada.id } } },
      });
      const second: any = createClient({ schema: tables("authors"), driver });
      await pushing(second);
      const rows = await second.author.findMany({
        orderBy: { id: "asc" },
        include: {
          posts: { select: { id: true } },
          tags: { select: { id: true } },
          manager: { select: { name: true } },
        },
      });
      expect(rows).toMatchObject([
        {
          name: "Ada",
          posts: [{ id: "p" }],
          tags: [{ id: "t" }],
          manager: null,
        },
        { name: "Bob", posts: [], tags: [], manager: { name: "Ada" } },
      ]);
      const carl = await second.author.create({ data: { name: "Carl" } });
      expect(carl.id).toBeGreaterThan(rows[1].id);
      await expect(createMigrationClient(second).push()).resolves.toMatchObject(
        {
          outcome: "noop",
        }
      );
    } finally {
      await first.$disconnect();
    }
  });

  it("a new key rewrites each row under it", async () => {
    const before = () => ({
      item: s.model({
        id: s.string().id(),
        code: s.string(),
        label: s.string(),
      }),
    });
    const after = () => ({
      item: s.model({
        id: s.string(),
        code: s.string().id(),
        label: s.string(),
      }),
    });
    const driver = createSurrealTestDriver();
    const first: any = createClient({ schema: before(), driver });
    try {
      await pushing(first);
      await first.item.create({ data: { id: "a", code: "x", label: "one" } });
      const second: any = createClient({ schema: after(), driver });
      await pushing(second);
      expect(await second.item.findUnique({ where: { code: "x" } })).toEqual({
        id: "a",
        code: "x",
        label: "one",
      });
      await second.item.create({ data: { id: "b", code: "y", label: "two" } });
      await expect(createMigrationClient(second).push()).resolves.toMatchObject(
        {
          outcome: "noop",
        }
      );
    } finally {
      await first.$disconnect();
    }
  });

  it("a renamed table held by a unique field leaves what holds it, which follows it", async () => {
    const family = (map: string) => {
      const parent = s
        .model({
          id: s.string().id(),
          email: s.string().unique(),
          children: s.toMany(() => child),
        })
        .map(map);
      const child = s.model({
        id: s.string().id(),
        email: s.string(),
        parent: s
          .toOne(() => parent)
          .fields("email")
          .references("email")
          .onDelete("cascade")
          .onUpdate("cascade"),
      });
      return { parent, child };
    };
    const driver = createSurrealTestDriver();
    const first: any = createClient({ schema: family("parent"), driver });
    try {
      await pushing(first);
      await first.parent.create({
        data: { id: "p", email: "e", children: { create: { id: "c" } } },
      });
      const second: any = createClient({ schema: family("renamed"), driver });
      const moved = await pushing(second);
      // The copy writes rows into the new table: its unique refuses a duplicate
      // at once, not in a build behind the push.
      expect(
        moved.statements
          .map(({ sql }: { sql: string }) => sql)
          .filter((sql: string) => sql.startsWith("DEFINE INDEX"))
      ).toEqual([
        "DEFINE INDEX parent_email_key ON renamed FIELDS email UNIQUE;",
        "DEFINE INDEX renamed_email_key ON renamed FIELDS email UNIQUE;",
      ]);
      expect(await second.child.findMany()).toEqual([{ id: "c", email: "e" }]);
      await expect(createMigrationClient(second).push()).resolves.toMatchObject(
        { outcome: "noop" }
      );
      await second.parent.update({ where: { id: "p" }, data: { email: "f" } });
      expect(await second.child.findMany()).toEqual([{ id: "c", email: "f" }]);
      await second.parent.delete({ where: { id: "p" } });
      expect(await second.child.findMany()).toEqual([]);
    } finally {
      await first.$disconnect();
    }
  });

  it("a new compound key names its parts, which a unique over one reads", async () => {
    const before = () => ({
      item: s.model({
        legacy: s.string().id(),
        a: s.string().unique(),
        b: s.int(),
      }),
    });
    const after = () => ({
      item: s
        .model({ legacy: s.string(), a: s.string().unique(), b: s.int() })
        .id(["a", "b"]),
    });
    const driver = createSurrealTestDriver();
    const first: any = createClient({ schema: before(), driver });
    try {
      await pushing(first);
      await first.item.create({ data: { legacy: "old", a: "A", b: 1 } });
      const second: any = createClient({ schema: after(), driver });
      await pushing(second);
      expect(await second.item.findMany()).toEqual([
        { legacy: "old", a: "A", b: 1 },
      ]);
      await expect(
        second.item.create({ data: { legacy: "second", a: "A", b: 2 } })
      ).rejects.toThrow(UNIQUE_FAILURE);
      await second.item.create({ data: { legacy: "third", a: "B", b: 2 } });
      await expect(createMigrationClient(second).push()).resolves.toMatchObject(
        { outcome: "noop" }
      );
    } finally {
      await first.$disconnect();
    }
  });

  it("a partial index's predicate in another spelling is no change, a new one is", async () => {
    const declared = (where: string) => ({
      seat: s
        .model({ id: s.string().id(), room: s.string(), open: s.boolean() })
        .index(["room"], { name: "open_rooms", where }),
    });
    const driver = createSurrealTestDriver();
    const db: any = createClient({
      schema: declared("open = true"),
      driver,
    });
    try {
      await pushing(db);
      const planned = (where: string) =>
        createMigrationClient(
          createClient({ schema: declared(where) as never, driver }) as never
        ).push({ dryRun: true });
      expect((await planned(`("open" = TRUE)`)).operations).toEqual([]);
      expect((await planned("open = false")).operations).toHaveLength(2);
    } finally {
      await db.$disconnect();
    }
  });

  it("a partial unique index over a value holds among the rows it names", async () => {
    const schema = () => ({
      seat: s
        .model({
          id: s.string().id(),
          room: s.string(),
          state: s.string(),
          floor: s.int().nullable(),
        })
        .index(["room"], {
          unique: true,
          where: `"state" = 'taken' AND ("floor" > 0 OR "floor" IS NULL)`,
          name: "one_taken",
        }),
    });
    const db: any = createClient({
      schema: schema(),
      driver: createSurrealTestDriver(),
    });
    try {
      await pushing(db);
      await db.seat.createMany({
        data: [
          { id: "a", room: "r", state: "taken", floor: 1 },
          { id: "b", room: "r", state: "free", floor: 1 },
          { id: "c", room: "r", state: "taken", floor: -1 },
        ],
      });
      await expect(
        db.seat.create({
          data: { id: "d", room: "r", state: "taken", floor: 2 },
        })
      ).rejects.toThrow(UNIQUE_FAILURE);
      await expect(createMigrationClient(db).push()).resolves.toMatchObject({
        outcome: "noop",
      });
    } finally {
      await db.$disconnect();
    }
  });
});

describe.skipIf(!surrealUrl)("migration history on SurrealDB", () => {
  const accounts = (unique: boolean) => ({
    account: s.model({
      id: s.string().id(),
      email: unique ? s.string().unique() : s.string(),
    }),
  });

  it("a failed apply leaves the rows and the marker, and runs again once it can", async () => {
    const storage = new MemoryEstateStorage();
    const driver = createSurrealTestDriver();
    const first: any = createClient({ schema: accounts(false), driver });
    const migrations = createMigrationClient(first, { storage });
    try {
      await migrations.generate({ name: "init" });
      await migrations.apply();
      await first.account.createMany({
        data: [
          { id: "a", email: "same" },
          { id: "b", email: "same" },
        ],
      });
      const second: any = createClient({ schema: accounts(true), driver });
      const next = createMigrationClient(second, { storage });
      await next.generate({ name: "unique" });
      await expect(next.apply()).rejects.toThrow();
      expect(await first.account.count()).toBe(2);
      const log = await next.log();
      expect(log.map((event: any) => event.kind)).toContain("failed");
      await first.account.update({
        where: { id: "b" },
        data: { email: "other" },
      });
      await expect(next.apply()).resolves.toMatchObject({ outcome: "applied" });
      await expect(next.verify()).resolves.toEqual({ ok: true });
    } finally {
      await first.$disconnect();
    }
  });

  it("two applies at once: one applies, and the other finds it done or waits its turn", async () => {
    const storage = new MemoryEstateStorage();
    const driver = createSurrealTestDriver();
    const client: any = createClient({ schema: accounts(false), driver });
    const migrations = createMigrationClient(client, { storage });
    try {
      await migrations.generate({ name: "init" });
      const outcomes = await Promise.allSettled([
        migrations.apply(),
        createMigrationClient(client, { storage }).apply(),
      ]);
      const applied = outcomes.filter(
        (outcome) =>
          outcome.status === "fulfilled" && outcome.value.outcome === "applied"
      );
      expect(applied).toHaveLength(1);
      await expect(migrations.verify()).resolves.toEqual({ ok: true });
    } finally {
      await client.$disconnect();
    }
  });

  it("the file it generates is SurrealQL, and refuses a transaction of its own", async () => {
    const storage = new MemoryEstateStorage();
    const client: any = createClient({
      schema: accounts(false),
      driver: createSurrealTestDriver(),
    });
    try {
      const generated = await createMigrationClient(client, {
        storage,
      }).generate({ name: "init" });
      expect(generated.sql).toContain("DEFINE TABLE account");
    } finally {
      await client.$disconnect();
    }
    const { assertArtifactExecutionSafe } = await import(
      "@migrations/statement-safety"
    );
    expect(() =>
      assertArtifactExecutionSafe(
        ["DEFINE TABLE a; -- COMMIT\nRETURN 'COMMIT'; { BEGIN }"],
        "surrealql",
        "up"
      )
    ).not.toThrow();
    expect(() =>
      assertArtifactExecutionSafe(
        ["DEFINE TABLE a;\nCOMMIT;"],
        "surrealql",
        "up"
      )
    ).toThrow("COMMIT");
  });

  it("generates, applies, verifies, goes down and resets", async () => {
    const storage = new MemoryEstateStorage();
    const driver = createSurrealTestDriver();
    const client: any = createClient({ schema: first(), driver });
    const migrations = createMigrationClient(client, { storage });
    try {
      await migrations.generate({ name: "init" });
      await expect(migrations.apply()).resolves.toMatchObject({
        outcome: "applied",
      });
      await expect(migrations.verify()).resolves.toEqual({ ok: true });
      await expect(migrations.apply()).resolves.toMatchObject({
        outcome: "noop",
      });
      await expect(migrations.push()).resolves.toMatchObject({
        outcome: "noop",
        operations: [],
      });

      await client.author.create({
        data: { id: "a", name: "Ada", posts: { create: { title: "kept" } } },
      });
      expect(await migrations.status()).toMatchObject({ pending: [] });

      const grown: any = createClient({ schema: second(), driver });
      const next = createMigrationClient(grown, { storage });
      await next.generate({ name: "grow" });
      await expect(next.apply()).resolves.toMatchObject({
        outcome: "applied",
      });
      await expect(next.verify()).resolves.toEqual({ ok: true });
      expect(
        await grown.post.findMany({ select: { title: true, tags: true } })
      ).toEqual([{ title: "kept", tags: [] }]);
      await grown.post.update({
        where: { id: 1 },
        data: { tags: { create: { id: "t" } } },
      });

      await next.down({
        steps: 1,
        resolve: (change: any) =>
          change.type === "destructive" ? change.proceed() : undefined,
      });
      await expect(migrations.verify()).resolves.toEqual({ ok: true });
      expect(await client.post.findMany()).toMatchObject([{ title: "kept" }]);

      await migrations.reset({
        resolve: (change: any) =>
          change.type === "destructive" ? change.proceed() : undefined,
      } as never);
      await expect(migrations.verify()).resolves.toEqual({ ok: true });
    } finally {
      await client.$disconnect();
    }
  });
});
