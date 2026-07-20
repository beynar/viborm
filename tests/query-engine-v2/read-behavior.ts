import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createV2RoutedClient } from "./v2-client-proxy";

/**
 * The read family (PLAN P4 item 1) as single read steps, across the driver
 * matrix. Each read is dual-run through V1 and the V2-routed engine reading one
 * seeded database, asserting byte-identical results including row ordering,
 * null/empty-set handling, aggregates over empty sets, groupBy with
 * having/orderBy, distinct, and take/skip. The routing spy proves each read was
 * actually served by V2 (not a silent V1 fallback). Dedicated table names keep
 * the shared-database driver suites (MySQL/pg) collision-free.
 */
export const readSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string().nullable(),
      email: s.string(),
      age: s.int().nullable(),
      posts: s.oneToMany(() => post),
    })
    .map("read_v2_users");

  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      content: s.string().nullable(),
      published: s.boolean().default(false),
      views: s.int().default(0),
      authorId: s.string(),
      author: s
        .manyToOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("read_v2_posts");

  return { user, post };
})();

const readUserRows = [
  { id: "u1", email: "alice@test.com", name: "Alice", age: 25 },
  { id: "u2", email: "bob@test.com", name: "Bob", age: 30 },
  { id: "u3", email: "charlie@test.com", name: "Charlie", age: 35 },
];
const readPostRows = [
  {
    id: "p1",
    title: "Post 1",
    content: "Content 1",
    published: true,
    views: 100,
    authorId: "u1",
  },
  {
    id: "p2",
    title: "Post 2",
    content: "Content 2",
    published: false,
    views: 50,
    authorId: "u1",
  },
  {
    id: "p3",
    title: "Post 3",
    content: "Content 3",
    published: true,
    views: 200,
    authorId: "u2",
  },
];

async function seedReads(client: {
  user: { createMany(args: { data: unknown[] }): PromiseLike<unknown> };
  post: { createMany(args: { data: unknown[] }): PromiseLike<unknown> };
}): Promise<void> {
  await client.user.createMany({ data: readUserRows });
  await client.post.createMany({ data: readPostRows });
}

type ReadClient = Record<
  string,
  Record<string, (args?: Record<string, unknown>) => unknown>
>;

interface ReadScenario {
  readonly name: string;
  readonly run: (client: ReadClient) => unknown;
  /** The read operation the routing spy must record for this scenario. */
  readonly routed: string;
}

/**
 * Comprehensive read scenarios exercised by both the per-driver matrix and the
 * fresh-instance dual-run oracle: ordering, null/empty sets, aggregates over an
 * empty set, groupBy with having/orderBy, distinct, and take/skip.
 */
export const READ_SCENARIOS: readonly ReadScenario[] = [
  {
    name: "findMany all, ordered",
    routed: "findMany",
    run: (c) => c.post!.findMany!({ orderBy: { id: "asc" } }),
  },
  {
    name: "findMany where + orderBy desc",
    routed: "findMany",
    run: (c) =>
      c.post!.findMany!({
        where: { published: true },
        orderBy: { views: "desc" },
      }),
  },
  {
    name: "findMany select projection",
    routed: "findMany",
    run: (c) =>
      c.post!.findMany!({
        select: { id: true, title: true },
        orderBy: { id: "asc" },
      }),
  },
  {
    name: "findMany include relation",
    routed: "findMany",
    run: (c) =>
      c.user!.findMany!({
        include: { posts: { orderBy: { id: "asc" } } },
        orderBy: { id: "asc" },
      }),
  },
  {
    name: "findMany distinct",
    routed: "findMany",
    run: (c) =>
      c.post!.findMany!({
        distinct: ["published"],
        orderBy: [{ published: "asc" }, { id: "asc" }],
      }),
  },
  {
    name: "findMany take",
    routed: "findMany",
    run: (c) => c.post!.findMany!({ orderBy: { views: "desc" }, take: 2 }),
  },
  {
    name: "findMany skip",
    routed: "findMany",
    run: (c) => c.post!.findMany!({ orderBy: { views: "desc" }, skip: 1 }),
  },
  {
    name: "findMany take + skip",
    routed: "findMany",
    run: (c) =>
      c.post!.findMany!({ orderBy: { views: "desc" }, take: 1, skip: 1 }),
  },
  {
    name: "findMany negative take (from the end)",
    routed: "findMany",
    run: (c) => c.post!.findMany!({ orderBy: { views: "asc" }, take: -2 }),
  },
  {
    name: "findMany empty result set",
    routed: "findMany",
    run: (c) => c.post!.findMany!({ where: { title: "nope" } }),
  },
  {
    name: "findFirst ordered",
    routed: "findFirst",
    run: (c) => c.post!.findFirst!({ orderBy: { views: "desc" } }),
  },
  {
    name: "findFirst no match is null",
    routed: "findFirst",
    run: (c) => c.post!.findFirst!({ where: { title: "nope" } }),
  },
  {
    name: "findUnique found",
    routed: "findUnique",
    run: (c) => c.user!.findUnique!({ where: { id: "u1" } }),
  },
  {
    name: "findUnique missing is null",
    routed: "findUnique",
    run: (c) => c.user!.findUnique!({ where: { id: "missing" } }),
  },
  {
    name: "findUniqueOrThrow found",
    routed: "findUniqueOrThrow",
    run: (c) => c.user!.findUniqueOrThrow!({ where: { id: "u2" } }),
  },
  {
    name: "findUniqueOrThrow missing throws",
    routed: "findUniqueOrThrow",
    run: (c) => c.user!.findUniqueOrThrow!({ where: { id: "missing" } }),
  },
  {
    name: "findFirstOrThrow missing throws",
    routed: "findFirstOrThrow",
    run: (c) => c.post!.findFirstOrThrow!({ where: { title: "nope" } }),
  },
  {
    name: "count all",
    routed: "count",
    run: (c) => c.post!.count!({}),
  },
  {
    name: "count where",
    routed: "count",
    run: (c) => c.post!.count!({ where: { published: true } }),
  },
  {
    name: "aggregate over rows",
    routed: "aggregate",
    run: (c) =>
      c.post!.aggregate!({
        _count: true,
        _sum: { views: true },
        _avg: { views: true },
        _min: { views: true },
        _max: { views: true },
      }),
  },
  {
    name: "aggregate over an empty set",
    routed: "aggregate",
    run: (c) =>
      c.post!.aggregate!({
        where: { title: "nope" },
        _count: true,
        _sum: { views: true },
        _avg: { views: true },
        _min: { views: true },
        _max: { views: true },
      }),
  },
  {
    name: "groupBy single field with count/sum",
    routed: "groupBy",
    run: (c) =>
      c.post!.groupBy!({
        by: ["authorId"],
        _count: { _all: true },
        _sum: { views: true },
        orderBy: { authorId: "asc" },
      }),
  },
  {
    name: "groupBy with having",
    routed: "groupBy",
    run: (c) =>
      c.post!.groupBy!({
        by: ["authorId"],
        _sum: { views: true },
        having: { views: { _sum: { gt: 100 } } },
        orderBy: { authorId: "asc" },
      }),
  },
  {
    name: "groupBy multi-field ordered",
    routed: "groupBy",
    run: (c) =>
      c.post!.groupBy!({
        by: ["authorId", "published"],
        _count: { _all: true },
        orderBy: [{ authorId: "asc" }, { published: "asc" }],
      }),
  },
  {
    name: "exist true",
    routed: "exist",
    run: (c) => c.post!.exist!({ where: { published: true } }),
  },
  {
    name: "exist false",
    routed: "exist",
    run: (c) => c.post!.exist!({ where: { title: "nope" } }),
  },
];

interface ErrorShape {
  name: string;
  message: string;
  code?: string | number;
}

function normalizeError(error: unknown): ErrorShape {
  if (!(error instanceof Error)) throw error;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  const stable =
    typeof code === "string" || typeof code === "number" ? code : undefined;
  return stable === undefined
    ? { name: error.name, message: error.message }
    : { name: error.name, code: stable, message: error.message };
}

async function settle(
  work: () => unknown
): Promise<{ value?: unknown; error?: ErrorShape }> {
  try {
    return { value: await work() };
  } catch (thrown) {
    return { error: normalizeError(thrown) };
  }
}

function makeReadClient(driver: AnyDriver) {
  return createClient({ schema: readSchema, driver });
}
type ReadClientInstance = ReturnType<typeof makeReadClient>;

export function runReadBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  /**
   * The V2 arm's driver. Both arms share the SAME seeded database (reads never
   * mutate, so V1 and V2 reading one dataset is a stricter parity check than two
   * seeded copies, and it works for shared-database drivers too). Supply this only
   * to run the V2 arm in a different mode against the same data — e.g. a
   * forced-batch driver bound to the V1 driver's underlying database.
   */
  readonly createV2Driver?: () => AnyDriver;
}): void {
  describe(`${options.name} reads (V2 vs V1)`, () => {
    let v1: ReadClientInstance | undefined;
    let distinctV2Driver: AnyDriver | undefined;
    let routed: ReturnType<typeof createV2RoutedClient> | undefined;

    beforeAll(async () => {
      const v1Driver = options.createDriver();
      v1 = makeReadClient(v1Driver);
      await push(v1, { force: true });
      await seedReads(v1);

      // Default the V2 arm to V1's own driver so both read one seeded database;
      // a supplied factory shares that database in a different substrate mode.
      distinctV2Driver = options.createV2Driver?.();
      routed = createV2RoutedClient({
        schema: readSchema,
        client: v1 as unknown as ReadClient,
        driver: distinctV2Driver ?? v1Driver,
      });
    });

    afterAll(async () => {
      await v1?.$disconnect();
    });

    for (const scenario of READ_SCENARIOS) {
      test(scenario.name, { timeout: 30_000 }, async () => {
        const before = routed!.routes.length;
        const expected = await settle(() =>
          scenario.run(v1 as unknown as ReadClient)
        );
        const actual = await settle(() =>
          scenario.run(routed!.client as unknown as ReadClient)
        );

        // The whole read was served by V2 (not a silent V1 fallback).
        const recorded = routed!.routes.slice(before);
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({
          operation: scenario.routed,
          engine: "v2",
        });

        expect(actual.error).toEqual(expected.error);
        expect(actual.value).toEqual(expected.value);
      });
    }
  });
}
