import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/exports";
import { createClient } from "@client/client";
import { defaultOmit } from "@client/exports";
import type { AnyDriver } from "@drivers";
import { ValidationError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const user = s
  .model({
    id: s.string().id(),
    firstName: s.string(),
    lastName: s.string(),
    email: s.string(),
    password: s.string(),
    posts: s.toMany(() => post),
  })
  .map("result_fields_users");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string().nullable(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  })
  .map("result_fields_posts");
const category = s
  .model({
    id: s.string().id(),
    name: s.string(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => category)
      .fields("parentId")
      .references("id")
      .name("tree"),
    children: s.toMany(() => category).name("tree"),
  })
  .map("result_fields_categories");
const schema = { user, post, category };

type UserRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
};

const fullName = {
  needs: { firstName: true, lastName: true },
  compute: (row: UserRow) => `${row.firstName} ${row.lastName}`,
};

const FIRST_NAME = /firstName/;
const LAST_NAME = /lastName/;
const UNNEEDED_COLUMNS = /email|password/;

const USERS = [
  {
    id: "u1",
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ADA@EXAMPLE.COM",
    password: "s1",
  },
  {
    id: "u2",
    firstName: "Alan",
    lastName: "Turing",
    email: "Alan@Example.com",
    password: "s2",
  },
];
const POSTS = [
  { id: "p1", title: "notes", authorId: "u1" },
  { id: "p2", title: "engine", authorId: "u1" },
  { id: "p3", title: "orphan", authorId: null },
];

/**
 * `$extends({ result })` computed fields, as Prisma has them: on every row of
 * the model an operation returns (reads, row-returning writes, nested
 * relation rows, array transactions), selected and omitted by name, their
 * `needs` read even when not selected and removed again, a later extension
 * building on an earlier one's field, `$allModels`, and a field that shadows
 * a column. Every expected value is written from the seeded rows.
 */
export function runResultFieldsBehavior({
  name: provider,
  createDriver,
}: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}) {
  describe(`${provider}: result extensions compute fields`, () => {
    const clients: { $disconnect(): Promise<void> }[] = [];
    afterEach(async () => {
      for (const client of clients.splice(0)) await client.$disconnect();
    });

    const open = async () => {
      const driver = createDriver();
      const statements: string[] = [];
      const observed = driver as unknown as {
        execute: (...args: unknown[]) => Promise<unknown>;
      };
      const execute = observed.execute.bind(driver);
      observed.execute = (...args: unknown[]) => {
        statements.push(args[1] as string);
        return execute(...args);
      };
      const base = createClient({ schema, driver });
      clients.push(base);
      await syncLiveSchema(base);
      await base.user.createMany({ data: USERS });
      await base.post.createMany({ data: POSTS });
      await base.category.createMany({
        data: [
          { id: "c1", name: "root", parentId: null },
          { id: "c2", name: "child", parentId: "c1" },
          { id: "c3", name: "leaf", parentId: "c2" },
        ],
      });
      statements.length = 0;
      const db = base.$extends({
        name: "names",
        result: { user: { fullName } },
      } as never) as unknown as typeof base;
      return { base, db: db as Loose, statements };
    };

    test(`${provider}: a read returns the field, reads its needs, and removes the needs it did not select`, async () => {
      const { db, statements } = await open();
      expect(await db.user.findMany({ orderBy: { id: "asc" } })).toEqual(
        USERS.map((row) => ({
          ...row,
          fullName: `${row.firstName} ${row.lastName}`,
        }))
      );
      statements.length = 0;
      expect(
        await db.user.findUnique({
          where: { id: "u1" },
          select: { fullName: true },
        })
      ).toEqual({ fullName: "Ada Lovelace" });
      expect(statements.at(-1)).toMatch(FIRST_NAME);
      expect(statements.at(-1)).toMatch(LAST_NAME);
      expect(statements.at(-1)).not.toMatch(UNNEEDED_COLUMNS);
      expect(
        await db.user.findFirst({
          where: { id: "u2" },
          select: { id: true, firstName: true, fullName: true },
        })
      ).toEqual({ id: "u2", firstName: "Alan", fullName: "Alan Turing" });
      expect(
        await db.user.findUniqueOrThrow({
          where: { id: "u2" },
          omit: { fullName: true, password: true },
        })
      ).toEqual({
        id: "u2",
        firstName: "Alan",
        lastName: "Turing",
        email: "Alan@Example.com",
      });
      expect(
        await db.user.findFirstOrThrow({
          where: { id: "u1" },
          omit: { firstName: true, lastName: true, password: true },
        })
      ).toEqual({
        id: "u1",
        email: "ADA@EXAMPLE.COM",
        fullName: "Ada Lovelace",
      });
    });

    test(`${provider}: nested relation rows of the model carry the field`, async () => {
      const { db } = await open();
      expect(
        await db.post.findMany({
          orderBy: { id: "asc" },
          select: {
            id: true,
            author: { select: { fullName: true } },
          },
        })
      ).toEqual([
        { id: "p1", author: { fullName: "Ada Lovelace" } },
        { id: "p2", author: { fullName: "Ada Lovelace" } },
        { id: "p3", author: null },
      ]);
      const [ada] = await db.user.findMany({
        where: { id: "u1" },
        include: {
          posts: { include: { author: true }, orderBy: { id: "asc" } },
        },
      });
      expect(ada.fullName).toBe("Ada Lovelace");
      expect(
        ada.posts.map(
          (row: { author: { fullName: string } }) => row.author.fullName
        )
      ).toEqual(["Ada Lovelace", "Ada Lovelace"]);
      expect(
        await db.post.findUnique({
          where: { id: "p1" },
          include: { author: { omit: { firstName: true, password: true } } },
        })
      ).toEqual({
        id: "p1",
        title: "notes",
        authorId: "u1",
        author: {
          id: "u1",
          lastName: "Lovelace",
          email: "ADA@EXAMPLE.COM",
          fullName: "Ada Lovelace",
        },
      });
    });

    test(`${provider}: writes that return rows carry the field`, async () => {
      const { db } = await open();
      const created = await db.user.create({
        data: {
          id: "u3",
          firstName: "Grace",
          lastName: "Hopper",
          email: "g@h",
          password: "x",
        },
        select: { id: true, fullName: true },
      });
      expect(created).toEqual({ id: "u3", fullName: "Grace Hopper" });
      expect(
        (
          await db.user.update({
            where: { id: "u3" },
            data: { lastName: "Murray" },
          })
        ).fullName
      ).toBe("Grace Murray");
      expect(
        await db.user.upsert({
          where: { id: "u3" },
          create: USERS[0],
          update: { firstName: "G." },
          select: { fullName: true },
        })
      ).toEqual({ fullName: "G. Murray" });
      expect(
        await db.user.createMany({
          data: [
            {
              id: "u4",
              firstName: "K",
              lastName: "J",
              email: "k",
              password: "x",
            },
          ],
          select: { fullName: true },
        })
      ).toEqual([{ fullName: "K J" }]);
      expect(
        await db.user.updateMany({
          where: { id: { in: ["u3", "u4"] } },
          data: { lastName: "Z" },
          select: { id: true, fullName: true },
        })
      ).toEqual(
        expect.arrayContaining([
          { id: "u3", fullName: "G. Z" },
          { id: "u4", fullName: "K Z" },
        ])
      );
      expect(
        await db.user.updateMany({
          where: { id: "u4" },
          data: { lastName: "Y" },
        })
      ).toEqual({ count: 1 });
      expect(
        await db.user.delete({
          where: { id: "u4" },
          select: { fullName: true },
        })
      ).toEqual({ fullName: "K Y" });
      expect(
        await db.user.deleteMany({
          where: { id: "u3" },
          select: { fullName: true },
        })
      ).toEqual([{ fullName: "G. Z" }]);
      expect(await db.user.count()).toBe(2);
    });

    test(`${provider}: array and interactive transactions return the field`, async () => {
      const { db } = await open();
      const [users, first] = await db.$transaction([
        db.user.findMany({
          select: { fullName: true },
          orderBy: { id: "asc" },
        }),
        db.post.findFirst({
          where: { id: "p2" },
          select: { author: { select: { fullName: true } } },
        }),
        db.user.count(),
      ]);
      expect(users).toEqual([
        { fullName: "Ada Lovelace" },
        { fullName: "Alan Turing" },
      ]);
      expect(first).toEqual({ author: { fullName: "Ada Lovelace" } });
      const inside = await db.$transaction(
        async (tx: Loose) =>
          await tx.user.findUnique({
            where: { id: "u2" },
            select: { fullName: true },
          })
      );
      expect(inside).toEqual({ fullName: "Alan Turing" });
    });

    test(`${provider}: a cached read computes the field on a miss and on a hit, and caches only columns`, async () => {
      const { base, statements } = await open();
      const background: Promise<unknown>[] = [];
      const store = new MemoryCache();
      const db = base
        .$extends(
          cache({ driver: store, waitUntil: (work) => background.push(work) })
        )
        .$extends({
          name: "names",
          result: { user: { fullName } },
        } as never) as Loose;
      const read = () =>
        db.$withCache().user.findUnique({
          where: { id: "u1" },
          select: { id: true, fullName: true },
        });
      expect(await read()).toEqual({ id: "u1", fullName: "Ada Lovelace" });
      await Promise.all(background.splice(0));
      statements.length = 0;
      expect(await read()).toEqual({ id: "u1", fullName: "Ada Lovelace" });
      expect(statements).toEqual([]);
    });

    test(`${provider}: extensions compose: a later field needs an earlier one, overrides it, and $allModels reaches every model`, async () => {
      const { db: names } = await open();
      const db = names
        .$extends({
          name: "greeting",
          result: {
            user: {
              greeting: {
                needs: { fullName: true },
                compute: (row: { fullName: string }) =>
                  `Hello, ${row.fullName}`,
              },
            },
          },
        })
        .$extends({
          name: "shout",
          result: {
            $allModels: {
              ref: {
                needs: { id: true },
                compute: (row: { id: string }) => `#${row.id}`,
              },
            },
            user: {
              fullName: {
                needs: { fullName: true },
                compute: (row: { fullName: string }) =>
                  row.fullName.toUpperCase(),
              },
            },
          },
        });
      expect(
        await db.user.findUnique({
          where: { id: "u1" },
          select: { greeting: true, fullName: true, ref: true },
        })
      ).toEqual({
        greeting: "Hello, Ada Lovelace",
        fullName: "ADA LOVELACE",
        ref: "#u1",
      });
      expect(
        await db.user.findUnique({
          where: { id: "u2" },
          select: { greeting: true },
        })
      ).toEqual({ greeting: "Hello, Alan Turing" });
      expect(
        await db.post.findUnique({
          where: { id: "p1" },
          select: { title: true, ref: true },
        })
      ).toEqual({ title: "notes", ref: "#p1" });
    });

    test(`${provider}: a field may shadow a column it reads`, async () => {
      const { base } = await open();
      const db = base.$extends({
        name: "lower",
        result: {
          user: {
            email: {
              needs: { email: true },
              compute: (row: { email: string }) => row.email.toLowerCase(),
            },
          },
        },
      } as never) as Loose;
      expect(
        await db.user.findMany({
          select: { id: true, email: true },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        { id: "u1", email: "ada@example.com" },
        { id: "u2", email: "alan@example.com" },
      ]);
      expect(
        await db.user.findUnique({
          where: { id: "u1" },
          omit: { email: true, password: true },
        })
      ).toEqual({ id: "u1", firstName: "Ada", lastName: "Lovelace" });
      // The column still filters and orders; the computed field never does.
      expect(
        await db.user.count({ where: { email: { contains: "EXAMPLE" } } })
      ).toBe(1);
    });

    test(`${provider}: a need the client omits by default is read and removed again`, async () => {
      const { base } = await open();
      const db = base
        .$extends(defaultOmit<typeof schema>()({ user: { password: true } }))
        .$extends({
          name: "hint",
          result: {
            user: {
              hint: {
                needs: { password: true },
                compute: (row: { password: string }) =>
                  `${row.password.length}`,
              },
            },
          },
        } as never) as Loose;
      expect(await db.user.findUnique({ where: { id: "u1" } })).toEqual({
        id: "u1",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ADA@EXAMPLE.COM",
        hint: "2",
      });
    });

    test(`${provider}: filtering or ordering by a computed field is refused, and a throwing compute fails the call`, async () => {
      const { base, db } = await open();
      await expect(
        db.user.findMany({ where: { fullName: "Ada Lovelace" } })
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        db.user.findMany({ orderBy: { fullName: "asc" } })
      ).rejects.toBeInstanceOf(ValidationError);
      const failing = base.$extends({
        name: "failing",
        result: {
          user: {
            broken: {
              needs: {},
              compute: () => {
                throw new Error("compute failed");
              },
            },
          },
        },
      } as never) as Loose;
      await expect(failing.user.findMany()).rejects.toThrow("compute failed");
      const constant = base.$extends({
        name: "constant",
        result: { user: { one: { needs: {}, compute: () => 1 } } },
      } as never) as Loose;
      expect(
        await constant.user.findMany({
          select: { one: true },
          orderBy: { id: "asc" },
        })
      ).toEqual([{ one: 1 }, { one: 1 }]);
      expect(
        await failing.user.findMany({
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).toEqual([{ id: "u1" }, { id: "u2" }]);
    });

    test(`${provider}: a recursive projection carries the field at every level`, async () => {
      const { base } = await open();
      const db = base.$extends({
        name: "labels",
        result: {
          category: {
            label: {
              needs: { name: true },
              compute: (row: { name: string }) => `[${row.name}]`,
            },
          },
        },
      } as never) as Loose;
      expect(
        await db.category.findUnique({
          where: { id: "c1" },
          select: {
            label: true,
            children: { recurse: { depth: 3 }, select: { label: true } },
          },
        })
      ).toEqual({
        label: "[root]",
        children: [
          {
            label: "[child]",
            children: [{ label: "[leaf]", children: [] }],
          },
        ],
      });
    });

    test(`${provider}: a definition is checked when it is applied`, async () => {
      const { base } = await open();
      const apply = (result: unknown) => () =>
        base.$extends({ name: "bad", result } as never);
      expect(
        apply({ user: { x: { needs: { nope: true }, compute: () => 1 } } })
      ).toThrow(
        'Extension "bad" result.user.x needs "nope", which is not a readable scalar or an earlier computed field of model "user".'
      );
      expect(
        apply({ user: { posts: { needs: {}, compute: () => 1 } } })
      ).toThrow('"posts" is a relation of model "user"');
      expect(apply({ nobody: { x: { compute: () => 1 } } })).toThrow(
        'Extension "bad" result names unknown model "nobody".'
      );
      expect(apply({ user: { x: { needs: {} } } })).toThrow(
        "must be an object with a compute function"
      );
      expect(
        apply({
          $allModels: { x: { needs: { firstName: true }, compute: () => 1 } },
        })
      ).toThrow(
        'which is not a readable scalar or an earlier computed field of model "post"'
      );
    });
  });
}

/** The runtime contract is pinned here; the types are pinned in tests/types. */
type Loose = any;
