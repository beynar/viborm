import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    posts: s.oneToMany(() => post),
  })
  .map("relation_filter_mutation_users");

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    published: s.boolean().default(false),
    authorId: s.string(),
    author: s
      .manyToOne(() => user)
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
      .manyToOne(() => employee)
      .fields("managerId")
      .references("id")
      .optional(),
    reports: s.oneToMany(() => employee),
  })
  .map("relation_filter_mutation_employees");

const schema = { user, post, employee };

type RelationFilterMutationClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type RelationFilterMutationClient =
  VibORMClient<RelationFilterMutationClientConfig>;

export interface RelationFilterMutationBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * Top-level updateMany/deleteMany with relation filters (some/every/none).
 * Guards against decorrelated EXISTS subqueries: an unqualified parent column
 * inside the subquery binds to the related table and affects the wrong rows.
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
      await push(client, { force: true });

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
