import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { NotFoundError, UniqueConstraintError } from "@errors";
import { s } from "@schema";
import { defineContract } from "@tests/contracts/contract";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => post),
  })
  .map("relation_filter_mutation_users");

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    published: s.boolean().default(false),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id")
      .onDelete("cascade"),
  })
  .map("relation_filter_mutation_posts");

// Self-relation: the mutated table appears in the relation-filter subquery's
// FROM, which MySQL rejects for UPDATE/DELETE (error 1093) unless the engine
// wraps the subquery in a derived table.
const employee = s
  .model({
    id: s.string().id(),
    name: s.string(),
    managerId: s.string().nullable(),
    manager: s
      .toOne(() => employee)
      .fields("managerId")
      .references("id"),
    reports: s.toMany(() => employee),
  })
  .map("relation_filter_mutation_employees");

const schema = { user, post, employee };

type RelationFilterMutationClientConfig = VibORMConfig<typeof schema>;

type RelationFilterMutationClient =
  VibORMClient<RelationFilterMutationClientConfig>;

export interface RelationFilterMutationBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * Top-level relation filters inside a mutation's `where` — the bulk
 * updateMany/deleteMany forms (some/every/none) and, since N6-U2, the UNIQUE
 * `where` of update/delete/upsert. Guards against decorrelated EXISTS
 * subqueries: an unqualified parent column inside the subquery binds to the
 * related table and affects the wrong rows.
 *
 * Seed: Alice (2 published posts), Bob (1 published + 1 draft), Cara (no posts).
 */
export function runRelationFilterMutationBehavior({
  driverName,
  createDriver,
}: RelationFilterMutationBehaviorOptions) {
  describe(`${driverName} relation-filter mutation behavior`, () => {
    let client: RelationFilterMutationClient | undefined;

    beforeEach(async () => {
      client = createClient({ schema, driver: createDriver() });
      await syncLiveSchema(client);

      await client.user.create({
        data: {
          id: "user-1",
          name: "Alice",
          posts: {
            createMany: {
              data: [
                { id: "post-1", title: "Alice One", published: true },
                { id: "post-2", title: "Alice Two", published: true },
              ],
            },
          },
        },
      });
      await client.user.create({
        data: {
          id: "user-2",
          name: "Bob",
          posts: {
            createMany: {
              data: [
                { id: "post-3", title: "Bob One", published: true },
                { id: "post-4", title: "Bob Draft", published: false },
              ],
            },
          },
        },
      });
      await client.user.create({ data: { id: "user-3", name: "Cara" } });
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    async function userNames(): Promise<string[]> {
      const users = await requireClient(client).user.findMany({
        orderBy: { id: "asc" },
      });
      return users.map((matchedUser) => matchedUser.name);
    }

    async function postIds(): Promise<string[]> {
      const posts = await requireClient(client).post.findMany({
        orderBy: { id: "asc" },
      });
      return posts.map((matchedPost) => matchedPost.id);
    }

    async function postTitles(): Promise<string[]> {
      const posts = await requireClient(client).post.findMany({
        orderBy: { id: "asc" },
      });
      return posts.map((matchedPost) => matchedPost.title);
    }

    test("updateMany with some relation filter affects only matching rows", async () => {
      const result = await requireClient(client).user.updateMany({
        where: { posts: { some: { published: false } } },
        data: { name: "Updated" },
      });

      expect(result.count).toBe(1);
      expect(await userNames()).toEqual(["Alice", "Updated", "Cara"]);
    });

    test("updateMany with every relation filter affects only matching rows", async () => {
      const result = await requireClient(client).user.updateMany({
        where: { posts: { every: { published: true } } },
        data: { name: "Updated" },
      });

      // Alice (all published) and Cara (vacuously true: no posts)
      expect(result.count).toBe(2);
      expect(await userNames()).toEqual(["Updated", "Bob", "Updated"]);
    });

    test("updateMany with none relation filter affects only matching rows", async () => {
      const result = await requireClient(client).user.updateMany({
        where: { posts: { none: { published: false } } },
        data: { name: "Updated" },
      });

      expect(result.count).toBe(2);
      expect(await userNames()).toEqual(["Updated", "Bob", "Updated"]);
    });

    test("deleteMany with some relation filter deletes only matching rows", async () => {
      const result = await requireClient(client).user.deleteMany({
        where: { posts: { some: { published: false } } },
      });

      expect(result.count).toBe(1);
      expect(await userNames()).toEqual(["Alice", "Cara"]);
    });

    test("deleteMany with every relation filter deletes only matching rows", async () => {
      const result = await requireClient(client).user.deleteMany({
        where: { posts: { every: { published: true } } },
      });

      expect(result.count).toBe(2);
      expect(await userNames()).toEqual(["Bob"]);
    });

    test("deleteMany with none relation filter deletes only matching rows", async () => {
      const result = await requireClient(client).user.deleteMany({
        where: { posts: { none: { published: false } } },
      });

      expect(result.count).toBe(2);
      expect(await userNames()).toEqual(["Bob"]);
    });

    describe("combined relation operators", () => {
      test("updateMany applies same-object some and none filters", async () => {
        const result = await requireClient(client).user.updateMany({
          where: {
            posts: {
              some: { published: true },
              none: { published: false },
            },
          },
          data: { name: "Updated" },
        });

        expect(result.count).toBe(1);
        expect(await userNames()).toEqual(["Updated", "Bob", "Cara"]);
      });

      test("updateMany applies same-object some and every filters", async () => {
        const result = await requireClient(client).user.updateMany({
          where: {
            posts: {
              some: { published: true },
              every: { published: true },
            },
          },
          data: { name: "Updated" },
        });

        expect(result.count).toBe(1);
        expect(await userNames()).toEqual(["Updated", "Bob", "Cara"]);
      });

      test("updateMany applies same-object every and none filters", async () => {
        const result = await requireClient(client).user.updateMany({
          where: {
            posts: {
              every: { published: true },
              none: { title: "Alice One" },
            },
          },
          data: { name: "Updated" },
        });

        expect(result.count).toBe(1);
        expect(await userNames()).toEqual(["Alice", "Bob", "Updated"]);
      });

      test("updateMany applies same-object some, every, and none filters", async () => {
        const result = await requireClient(client).user.updateMany({
          where: {
            posts: {
              some: { published: true },
              every: { published: true },
              none: { title: "Alice One" },
            },
          },
          data: { name: "Updated" },
        });

        expect(result.count).toBe(0);
        expect(await userNames()).toEqual(["Alice", "Bob", "Cara"]);
      });

      test("updateMany applies same-object is and isNot filters", async () => {
        const result = await requireClient(client).post.updateMany({
          where: {
            author: {
              is: { name: "Alice" },
              isNot: { name: "Alice" },
            },
          },
          data: { title: "Updated" },
        });

        expect(result.count).toBe(0);
        expect(await postTitles()).toEqual([
          "Alice One",
          "Alice Two",
          "Bob One",
          "Bob Draft",
        ]);
      });

      test("deleteMany applies reversed same-object none and some filters", async () => {
        const result = await requireClient(client).user.deleteMany({
          where: {
            posts: {
              none: { published: false },
              some: { published: true },
            },
          },
        });

        expect(result.count).toBe(1);
        expect(await userNames()).toEqual(["Bob", "Cara"]);
      });

      test("deleteMany applies reversed same-object every and some filters", async () => {
        const result = await requireClient(client).user.deleteMany({
          where: {
            posts: {
              every: { published: true },
              some: { published: true },
            },
          },
        });

        expect(result.count).toBe(1);
        expect(await userNames()).toEqual(["Bob", "Cara"]);
      });

      test("deleteMany applies reversed same-object none and every filters", async () => {
        const result = await requireClient(client).user.deleteMany({
          where: {
            posts: {
              none: { title: "Alice One" },
              every: { published: true },
            },
          },
        });

        expect(result.count).toBe(1);
        expect(await userNames()).toEqual(["Alice", "Bob"]);
      });

      test("deleteMany applies reversed same-object none, every, and some filters", async () => {
        const result = await requireClient(client).user.deleteMany({
          where: {
            posts: {
              none: { title: "Alice One" },
              every: { published: true },
              some: { published: true },
            },
          },
        });

        expect(result.count).toBe(0);
        expect(await userNames()).toEqual(["Alice", "Bob", "Cara"]);
      });

      test("deleteMany applies reversed same-object isNot and is filters", async () => {
        const result = await requireClient(client).post.deleteMany({
          where: {
            author: {
              isNot: { name: "Alice" },
              is: { name: "Alice" },
            },
          },
        });

        expect(result.count).toBe(0);
        expect(await postIds()).toEqual([
          "post-1",
          "post-2",
          "post-3",
          "post-4",
        ]);
      });

      test("rolls back a combined-filter mutation when a later operation fails", async () => {
        let mutationCount: number | undefined;

        await expect(
          requireClient(client).$transaction(async (tx) => {
            const result = await tx.user.updateMany({
              where: {
                posts: {
                  some: { published: true },
                  none: { published: false },
                },
              },
              data: { name: "Must roll back" },
            });
            mutationCount = result.count;

            await tx.user.create({
              data: { id: "user-1", name: "Duplicate primary key" },
            });
          })
        ).rejects.toBeInstanceOf(UniqueConstraintError);

        expect(mutationCount).toBe(1);
        expect(await userNames()).toEqual(["Alice", "Bob", "Cara"]);
      });
    });

    // Self-relation filters make the mutated table appear in the subquery
    // FROM — MySQL error 1093 territory. Seed: boss ← mid ← kid.
    describe("self-relation filters", () => {
      beforeEach(async () => {
        const c = requireClient(client);
        // Create inputs require one of managerId/manager when the relation
        // declares fields, even for optional relations — pass null explicitly.
        await c.employee.create({
          data: { id: "e1", name: "boss", managerId: null },
        });
        await c.employee.create({
          data: { id: "e2", name: "mid", managerId: "e1" },
        });
        await c.employee.create({
          data: { id: "e3", name: "kid", managerId: "e2" },
        });
      });

      async function employeeNames(): Promise<string[]> {
        const employees = await requireClient(client).employee.findMany({
          orderBy: { id: "asc" },
        });
        return employees.map((e) => e.name);
      }

      test("updateMany with to-many self-relation filter affects only matching rows", async () => {
        const result = await requireClient(client).employee.updateMany({
          where: { reports: { some: { name: "kid" } } },
          data: { name: "promoted" },
        });

        expect(result.count).toBe(1);
        expect(await employeeNames()).toEqual(["boss", "promoted", "kid"]);
      });

      test("updateMany with to-one self-relation filter affects only matching rows", async () => {
        const result = await requireClient(client).employee.updateMany({
          where: { manager: { is: { name: "boss" } } },
          data: { name: "reportsToBoss" },
        });

        expect(result.count).toBe(1);
        expect(await employeeNames()).toEqual(["boss", "reportsToBoss", "kid"]);
      });

      test("deleteMany with self-relation filter deletes only matching rows", async () => {
        const result = await requireClient(client).employee.deleteMany({
          where: { reports: { none: {} } },
        });

        expect(result.count).toBe(1);
        expect(await employeeNames()).toEqual(["boss", "mid"]);
      });

      // N6-U2 — the same wrapper, reached from a UNIQUE `where`.
      //
      // `update`/`delete` address the located row by the primary key their
      // FOR UPDATE locate captured, so on a transaction substrate the relation
      // filter never reaches those statements. `upsert`'s UPDATE arm is the one
      // that keeps the original `where` on BOTH substrates — so this is the
      // statement in the unique-where family that asks a MySQL UPDATE to read
      // the table it is mutating, and the only place the derived-table wrapper
      // is exercised from a unique selector. On MySQL the shapes below FAIL with
      // ERROR 1093 if the wrapper is not composed; on PostgreSQL and SQLite they
      // are the same predicate without it.
      test("upsert's update arm carries a to-many self-relation filter", async () => {
        const c = requireClient(client);
        expect(
          await c.employee.upsert({
            where: { id: "e2", reports: { some: { name: "kid" } } },
            create: { id: "e9", name: "unused", managerId: null },
            update: { name: "promoted" },
            select: { id: true, name: true },
          })
        ).toEqual({ id: "e2", name: "promoted" });
        expect(await employeeNames()).toEqual(["boss", "promoted", "kid"]);
      });

      test("upsert's update arm carries a to-one self-relation filter", async () => {
        const c = requireClient(client);
        expect(
          await c.employee.upsert({
            where: { id: "e3", manager: { is: { name: "mid" } } },
            create: { id: "e9", name: "unused", managerId: null },
            update: { name: "confirmed" },
            select: { id: true, name: true },
          })
        ).toEqual({ id: "e3", name: "confirmed" });
        expect(await employeeNames()).toEqual(["boss", "mid", "confirmed"]);
      });

      test("an excluding self-relation filter takes the create arm instead", async () => {
        const c = requireClient(client);
        // `boss` manages `mid`, not `kid`, so the filter excludes the row the
        // discriminator names and the CREATE arm runs on its own data.
        expect(
          await c.employee.upsert({
            where: { id: "e1", reports: { some: { name: "kid" } } },
            create: { id: "e4", name: "created", managerId: "e1" },
            update: { name: "never" },
            select: { id: true, name: true },
          })
        ).toEqual({ id: "e4", name: "created" });
        expect(await employeeNames()).toEqual([
          "boss",
          "mid",
          "kid",
          "created",
        ]);
      });

      test("update by a self-relation-filtered unique where locates or declines", async () => {
        const c = requireClient(client);
        expect(
          await c.employee.update({
            where: { id: "e2", reports: { some: { name: "kid" } } },
            data: { name: "promoted" },
            select: { name: true },
          })
        ).toEqual({ name: "promoted" });
        // `kid` manages nobody: the filter excludes it, and nothing is written.
        await expect(
          c.employee.update({
            where: { id: "e3", reports: { some: {} } },
            data: { name: "unreachable" },
          })
        ).rejects.toBeInstanceOf(NotFoundError);
        expect(await employeeNames()).toEqual(["boss", "promoted", "kid"]);
      });

      test("delete by a self-relation-filtered unique where removes one row", async () => {
        const c = requireClient(client);
        // `kid` is the only employee with no reports.
        expect(
          await c.employee.delete({
            where: { id: "e3", reports: { none: {} } },
            select: { name: true },
          })
        ).toEqual({ name: "kid" });
        await expect(
          c.employee.delete({ where: { id: "e1", reports: { none: {} } } })
        ).rejects.toBeInstanceOf(NotFoundError);
        expect(await employeeNames()).toEqual(["boss", "mid"]);
      });
    });
  });
}

function requireClient(
  client: RelationFilterMutationClient | undefined
): RelationFilterMutationClient {
  if (!client) {
    throw new Error(
      "Relation-filter mutation test client was not initialized."
    );
  }
  return client;
}

export const relationFilterMutationContract = defineContract({
  id: "drivers.relation-filter-mutation",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runRelationFilterMutationBehavior,
});
