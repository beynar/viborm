import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { windowUserPostSchema } from "../fixtures/user-post-schema";
import { seedWindowUserPosts } from "../fixtures/user-post-seed";

const schema = windowUserPostSchema;

type WindowClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type WindowClient = VibORMClient<WindowClientConfig>;

export interface CountAggregateWindowBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

export function runCountAggregateWindowBehavior({
  driverName,
  createDriver,
}: CountAggregateWindowBehaviorOptions) {
  describe(`${driverName} count/aggregate input windows`, () => {
    let client: WindowClient | undefined;

    beforeEach(async () => {
      client = createClient({
        schema,
        driver: createDriver(),
      });
      await push(client, { force: true });
      await seedWindowUserPosts(client);
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    test("count applies ordered cursor input window", async () => {
      const result = await requireClient(client).user.count({
        orderBy: { id: "desc" },
        cursor: { id: "u3" },
        skip: 1,
        take: 10,
      });

      expect(result).toBe(2);
    });

    test("aggregate applies ordered cursor input window", async () => {
      const result = await requireClient(client).post.aggregate({
        orderBy: { id: "desc" },
        cursor: { id: "p3" },
        skip: 1,
        take: 2,
        _count: true,
        _sum: { views: true },
      });

      expect(result._count).toBe(2);
      expect(result._sum.views).toBe(150);
    });

    test("count applies negative take input window", async () => {
      const result = await requireClient(client).user.count({
        orderBy: { id: "asc" },
        cursor: { id: "u3" },
        skip: 1,
        take: -2,
      });

      expect(result).toBe(2);
    });

    test("aggregate applies negative take input window", async () => {
      const result = await requireClient(client).post.aggregate({
        orderBy: { id: "asc" },
        cursor: { id: "p3" },
        skip: 1,
        take: -2,
        _count: true,
        _sum: { views: true },
      });

      expect(result._count).toBe(2);
      expect(result._sum.views).toBe(150);
    });

    test("selected count uses the input window", async () => {
      const result = await requireClient(client).user.count({
        select: { _all: true, id: true },
        orderBy: { id: "desc" },
        cursor: { id: "u3" },
        skip: 1,
        take: 2,
      });

      expect(result).toEqual({ _all: 2, id: 2 });
    });

    test("aggregate _count object form counts non-null values per field", async () => {
      const c = requireClient(client);
      // Give field-level counts a NULL to skip: _all sees the row, the
      // nullable columns do not.
      await c.user.create({
        data: { id: "u4", name: null, email: "dana@test.com", age: null },
      });

      const result = await c.user.aggregate({
        _count: { _all: true, name: true, age: true },
      });

      expect(result._count).toEqual({ _all: 4, name: 3, age: 3 });
    });

    test("aggregate _count object form applies the input window", async () => {
      const result = await requireClient(client).post.aggregate({
        orderBy: { id: "asc" },
        skip: 1,
        take: 2,
        _count: { _all: true, id: true },
      });

      expect(result._count).toEqual({ _all: 2, id: 2 });
    });

    test("count honors supported relation order in input window", async () => {
      const result = await requireClient(client).post.count({
        orderBy: { author: { name: "desc" } },
        take: 1,
      });

      expect(result).toBe(1);
    });

    test("aggregate honors supported relation order in input window", async () => {
      const result = await requireClient(client).post.aggregate({
        orderBy: { author: { name: "desc" } },
        take: 1,
        _count: true,
        _sum: { views: true },
      });

      expect(result._count).toBe(1);
      expect(result._sum.views).toBe(200);
    });

    test("unsupported to-many scalar relation order fails closed", async () => {
      await expect(
        requireClient(client).user.count({
          // @ts-expect-error runtime validation rejects to-many scalar order
          orderBy: { posts: { title: "asc" } },
          take: 1,
        })
      ).rejects.toThrow();

      await expect(
        requireClient(client).user.aggregate({
          // @ts-expect-error runtime validation rejects to-many scalar order
          orderBy: { posts: { title: "asc" } },
          take: 1,
          _count: true,
        })
      ).rejects.toThrow();
    });
  });
}

function requireClient(client: WindowClient | undefined): WindowClient {
  if (!client) {
    throw new Error("Driver behavior test client was not initialized.");
  }
  return client;
}
