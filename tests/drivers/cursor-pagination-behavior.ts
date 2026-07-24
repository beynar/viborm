import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const cursorSchema = {
  cursorItem: s
    .model({
      alternate: s.string().unique(),
      id: s.string().id(),
      bucket: s.string(),
      rank: s.int().nullable(),
    })
    .map("cursor_order_items"),
};

const membershipSchema = {
  membership: s
    .model({
      orgId: s.string(),
      memberId: s.string(),
      email: s.string(),
      tenantId: s.string(),
      role: s.string(),
    })
    .id(["orgId", "memberId"])
    .unique(["email", "tenantId"])
    .map("cursor_order_memberships"),
};

type CursorClientConfig = VibORMConfig & {
  schema: typeof cursorSchema;
  driver: AnyDriver;
};

type CursorClient = VibORMClient<CursorClientConfig>;

type Direction = "asc" | "desc";
type NullPlacement = "first" | "last";

type PredicateCase = {
  label: string;
  direction: Direction;
  nulls: NullPlacement;
  cursorId: string;
  expectedAfter: string[];
};

const rows = [
  { id: "d", alternate: "alt-3", bucket: "x", rank: 1 },
  { id: "b", alternate: "alt-5", bucket: "x", rank: null },
  { id: "f", alternate: "alt-1", bucket: "y", rank: 2 },
  { id: "a", alternate: "alt-6", bucket: "x", rank: null },
  { id: "e", alternate: "alt-2", bucket: "y", rank: 2 },
  { id: "c", alternate: "alt-4", bucket: "x", rank: 1 },
];

const predicateCases: PredicateCase[] = [
  {
    label: "asc nulls first after null",
    direction: "asc",
    nulls: "first",
    cursorId: "a",
    expectedAfter: ["b", "c", "d", "e", "f"],
  },
  {
    label: "asc nulls last after null",
    direction: "asc",
    nulls: "last",
    cursorId: "a",
    expectedAfter: ["b"],
  },
  {
    label: "desc nulls first after null",
    direction: "desc",
    nulls: "first",
    cursorId: "a",
    expectedAfter: ["b", "e", "f", "c", "d"],
  },
  {
    label: "desc nulls last after null",
    direction: "desc",
    nulls: "last",
    cursorId: "a",
    expectedAfter: ["b"],
  },
  {
    label: "asc nulls first after non-null",
    direction: "asc",
    nulls: "first",
    cursorId: "d",
    expectedAfter: ["e", "f"],
  },
  {
    label: "asc nulls last after non-null",
    direction: "asc",
    nulls: "last",
    cursorId: "d",
    expectedAfter: ["e", "f", "a", "b"],
  },
  {
    label: "desc nulls first after non-null",
    direction: "desc",
    nulls: "first",
    cursorId: "d",
    expectedAfter: [],
  },
  {
    label: "desc nulls last after non-null",
    direction: "desc",
    nulls: "last",
    cursorId: "d",
    expectedAfter: ["a", "b"],
  },
];

export interface CursorPaginationBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

export function runCursorPaginationBehavior({
  driverName,
  createDriver,
}: CursorPaginationBehaviorOptions) {
  describe(`${driverName} total cursor pagination`, () => {
    let client: CursorClient | undefined;

    beforeEach(async () => {
      client = createClient({
        schema: cursorSchema,
        driver: createDriver(),
      });
      await push(client, { force: true });
      await client.cursorItem.createMany({ data: rows });
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    test.each(predicateCases)("$label", async (predicateCase) => {
      const result = await requireClient(client).cursorItem.findMany({
        cursor: { id: predicateCase.cursorId },
        orderBy: [
          {
            rank: {
              sort: predicateCase.direction,
              nulls: predicateCase.nulls,
            },
          },
          { id: "asc" },
        ],
        skip: 1,
        take: 20,
      });

      expect(result.map(({ id }) => id)).toEqual(predicateCase.expectedAfter);
    });

    test("bare directions use one portable null default", async () => {
      const c = requireClient(client);
      const ascending = await c.cursorItem.findMany({
        orderBy: { rank: "asc" },
        take: 20,
      });
      const descending = await c.cursorItem.findMany({
        orderBy: { rank: "desc" },
        take: 20,
      });

      expect(ascending.map(({ id }) => id)).toEqual([
        "c",
        "d",
        "e",
        "f",
        "a",
        "b",
      ]);
      expect(descending.map(({ id }) => id)).toEqual([
        "a",
        "b",
        "e",
        "f",
        "c",
        "d",
      ]);
    });

    test("cursor inclusion, skip, default order, and backward take share one boundary", async () => {
      const c = requireClient(client);
      const inclusive = await c.cursorItem.findMany({
        cursor: { id: "c" },
        take: 2,
      });
      const exclusive = await c.cursorItem.findMany({
        cursor: { id: "c" },
        skip: 1,
        take: 1,
      });
      const backward = await c.cursorItem.findMany({
        cursor: { id: "c" },
        skip: 1,
        take: -2,
      });

      expect(inclusive.map(({ id }) => id)).toEqual(["c", "d"]);
      expect(exclusive.map(({ id }) => id)).toEqual(["d"]);
      expect(backward.map(({ id }) => id)).toEqual(["a", "b"]);
    });

    test("first page and alternate-unique cursor share the canonical ID tie-break", async () => {
      const firstPage = await requireClient(client).cursorItem.findMany({
        orderBy: { rank: { sort: "asc", nulls: "last" } },
        take: 2,
      });
      const cursor = firstPage.at(-1);
      if (!cursor) {
        throw new Error("Expected a non-empty first cursor page");
      }

      const secondPage = await requireClient(client).cursorItem.findMany({
        cursor: { alternate: cursor.alternate },
        orderBy: { rank: { sort: "asc", nulls: "last" } },
        skip: 1,
        take: 2,
      });

      expect(firstPage.map(({ id }) => id)).toEqual(["c", "d"]);
      expect(secondPage.map(({ id }) => id)).toEqual(["e", "f"]);
    });

    test("mixed directions preserve key precedence", async () => {
      const result = await requireClient(client).cursorItem.findMany({
        cursor: { id: "d" },
        orderBy: [{ bucket: "asc" }, { rank: { sort: "desc", nulls: "last" } }],
        skip: 1,
        take: 3,
      });

      expect(result.map(({ id }) => id)).toEqual(["a", "b", "e"]);
    });

    test("compound alternate cursor keeps canonical compound-ID precedence", async () => {
      const membershipClient = createClient({
        schema: membershipSchema,
        driver: createDriver(),
      });
      await push(membershipClient, { force: true });
      try {
        await membershipClient.membership.createMany({
          data: [
            {
              orgId: "org-1",
              memberId: "member-3",
              email: "c@example.com",
              tenantId: "tenant-1",
              role: "member",
            },
            {
              orgId: "org-1",
              memberId: "member-1",
              email: "a@example.com",
              tenantId: "tenant-1",
              role: "member",
            },
            {
              orgId: "org-1",
              memberId: "member-4",
              email: "d@example.com",
              tenantId: "tenant-1",
              role: "member",
            },
            {
              orgId: "org-1",
              memberId: "member-2",
              email: "b@example.com",
              tenantId: "tenant-1",
              role: "member",
            },
          ],
        });

        const result = await membershipClient.membership.findMany({
          cursor: {
            email_tenantId: {
              email: "b@example.com",
              tenantId: "tenant-1",
            },
          },
          orderBy: { role: "asc" },
          skip: 1,
          take: 2,
        });

        expect(result.map(({ email }) => email)).toEqual([
          "c@example.com",
          "d@example.com",
        ]);
      } finally {
        await membershipClient.$disconnect();
      }
    });

    test("forward and backward windows are symmetric", async () => {
      const c = requireClient(client);
      const forward = await c.cursorItem.findMany({
        cursor: { id: "d" },
        orderBy: [{ rank: { sort: "asc", nulls: "last" } }, { id: "asc" }],
        skip: 1,
        take: 2,
      });
      const backward = await c.cursorItem.findMany({
        cursor: { id: "e" },
        orderBy: [{ rank: { sort: "asc", nulls: "last" } }, { id: "asc" }],
        skip: 1,
        take: -2,
      });

      expect(forward.map(({ id }) => id)).toEqual(["e", "f"]);
      expect(backward.map(({ id }) => id)).toEqual(["c", "d"]);
    });

    test("distinct ranking preserves reverse cursor skip and take", async () => {
      const result = await requireClient(client).cursorItem.findMany({
        distinct: ["id"],
        cursor: { id: "e" },
        orderBy: { rank: { sort: "asc", nulls: "last" } },
        skip: 1,
        take: -2,
      });

      expect(result.map(({ id }) => id)).toEqual(["c", "d"]);
    });

    test("concatenated pages equal the one-shot total order", async () => {
      const c = requireClient(client);
      const expected = await c.cursorItem.findMany({
        orderBy: [
          { bucket: "asc" },
          { rank: { sort: "desc", nulls: "last" } },
          { id: "asc" },
        ],
      });
      const visited: string[] = [];
      let cursorId: string | undefined;
      let remainingPages = rows.length;

      while (remainingPages > 0) {
        remainingPages -= 1;
        const page = cursorId
          ? await c.cursorItem.findMany({
              cursor: { id: cursorId },
              orderBy: [
                { bucket: "asc" },
                { rank: { sort: "desc", nulls: "last" } },
              ],
              skip: 1,
              take: 2,
            })
          : await c.cursorItem.findMany({
              orderBy: [
                { bucket: "asc" },
                { rank: { sort: "desc", nulls: "last" } },
              ],
              take: 2,
            });

        if (page.length === 0) {
          break;
        }

        visited.push(...page.map(({ id }) => id));
        const last = page.at(-1);
        if (!last) {
          throw new Error("Expected a non-empty cursor page");
        }
        cursorId = last.id;
      }

      expect(visited).toEqual(expected.map(({ id }) => id));
      expect(new Set(visited).size).toBe(rows.length);
    });

    test("missing cursor consistently returns an empty window", async () => {
      const result = await requireClient(client).cursorItem.findMany({
        cursor: { id: "missing" },
        orderBy: { rank: { sort: "asc", nulls: "last" } },
        take: 2,
      });

      expect(result).toEqual([]);
    });

    test("count and aggregate consume the same null-aware cursor window", async () => {
      const c = requireClient(client);
      const count = await c.cursorItem.count({
        cursor: { id: "d" },
        orderBy: { rank: { sort: "asc", nulls: "last" } },
        skip: 1,
        take: 2,
      });
      const aggregate = await c.cursorItem.aggregate({
        cursor: { id: "d" },
        orderBy: { rank: { sort: "asc", nulls: "last" } },
        skip: 1,
        take: 2,
        _count: true,
        _sum: { rank: true },
      });

      expect(count).toBe(2);
      expect(aggregate._count).toBe(2);
      expect(aggregate._sum.rank).toBe(4);
    });
  });
}

function requireClient(client: CursorClient | undefined): CursorClient {
  if (!client) {
    throw new Error("Client not initialized");
  }
  return client;
}
