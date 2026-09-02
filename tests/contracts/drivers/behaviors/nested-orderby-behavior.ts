import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { s } from "@schema";
import { defineContract } from "@tests/contracts/contract";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const TO_MANY_ORDER_BY_REJECTION_PATTERN = /posts|to-many|_count|orderBy/i;

const company = s
  .model({
    id: s.string().id(),
    name: s.string(),
    teams: s.toMany(() => team),
  })
  .map("nested_order_companies");

const team = s
  .model({
    id: s.string().id(),
    name: s.string(),
    companyId: s.string().nullable(),
    company: s
      .toOne(() => company)
      .fields("companyId")
      .references("id"),
    members: s.toMany(() => user),
  })
  .map("nested_order_teams");

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    teamId: s.string().nullable(),
    team: s
      .toOne(() => team)
      .fields("teamId")
      .references("id"),
    posts: s.toMany(() => post).name("author"),
    reviewedPosts: s.toMany(() => post).name("reviewer"),
  })
  .map("nested_order_users");

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string().nullable(),
    reviewerId: s.string().nullable(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id")
      .name("author"),
    reviewer: s
      .toOne(() => user)
      .fields("reviewerId")
      .references("id")
      .name("reviewer"),
  })
  .map("nested_order_posts");

const category = s
  .model({
    id: s.string().id(),
    name: s.string(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => category)
      .fields("parentId")
      .references("id"),
    children: s.toMany(() => category),
  })
  .map("nested_order_categories");

const schema = { company, team, user, post, category };

type NestedOrderByClientConfig = VibORMConfig<typeof schema>;

type NestedOrderByClient = VibORMClient<NestedOrderByClientConfig>;

export interface NestedOrderByBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

const orderByCompanyNameAsc = {
  reviewer: {
    team: {
      company: {
        name: { sort: "asc", nulls: "last" },
      },
    },
  },
} as const;

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((row) => row.id);
}

export function runNestedOrderByBehavior({
  driverName,
  createDriver,
}: NestedOrderByBehaviorOptions) {
  describe(`${driverName} nested relation orderBy behavior`, () => {
    let client: NestedOrderByClient;

    beforeEach(async () => {
      client = createClient({ schema, driver: createDriver() });
      await syncLiveSchema(client);

      await client.company.createMany({
        data: [
          { id: "company-alpha", name: "Alpha" },
          { id: "company-beta", name: "Beta" },
        ],
      });

      await client.team.createMany({
        data: [
          {
            id: "team-alpha",
            name: "Alpha Team",
            companyId: "company-alpha",
          },
          { id: "team-beta", name: "Beta Team", companyId: "company-beta" },
          {
            id: "team-no-company",
            name: "No Company Team",
            companyId: null,
          },
        ],
      });

      await client.user.createMany({
        data: [
          { id: "user-author", name: "Author", teamId: "team-beta" },
          {
            id: "user-reviewer-alpha",
            name: "Reviewer Alpha",
            teamId: "team-alpha",
          },
          {
            id: "user-reviewer-beta",
            name: "Reviewer Beta",
            teamId: "team-beta",
          },
          {
            id: "user-reviewer-no-company",
            name: "Reviewer No Company",
            teamId: "team-no-company",
          },
          {
            id: "user-reviewer-no-team",
            name: "Reviewer No Team",
            teamId: null,
          },
        ],
      });

      await client.post.createMany({
        data: [
          {
            id: "post-alpha-a",
            title: "Alpha A",
            authorId: "user-author",
            reviewerId: "user-reviewer-alpha",
          },
          {
            id: "post-alpha-b",
            title: "Alpha B",
            authorId: "user-author",
            reviewerId: "user-reviewer-alpha",
          },
          {
            id: "post-beta",
            title: "Beta",
            authorId: "user-author",
            reviewerId: "user-reviewer-beta",
          },
          {
            id: "post-no-author",
            title: "No Author",
            authorId: null,
            reviewerId: "user-reviewer-beta",
          },
          {
            id: "post-no-company",
            title: "No Company",
            authorId: "user-author",
            reviewerId: "user-reviewer-no-company",
          },
          {
            id: "post-no-reviewer",
            title: "No Reviewer",
            authorId: "user-author",
            reviewerId: null,
          },
          {
            id: "post-no-team",
            title: "No Team",
            authorId: "user-author",
            reviewerId: "user-reviewer-no-team",
          },
        ],
      });

      await client.category.createMany({
        data: [
          { id: "cat-root-alpha", name: "Alpha", parentId: null },
          { id: "cat-root-zulu", name: "Zulu", parentId: null },
        ],
      });
      await client.category.createMany({
        data: [
          {
            id: "cat-parent-alpha",
            name: "Parent Alpha",
            parentId: "cat-root-alpha",
          },
          {
            id: "cat-parent-zulu",
            name: "Parent Zulu",
            parentId: "cat-root-zulu",
          },
        ],
      });
      await client.category.createMany({
        data: [
          {
            id: "cat-leaf-alpha",
            name: "Leaf Alpha",
            parentId: "cat-parent-alpha",
          },
          {
            id: "cat-leaf-zulu",
            name: "Leaf Zulu",
            parentId: "cat-parent-zulu",
          },
        ],
      });
    });

    afterEach(async () => {
      await client.$disconnect();
    });

    test("orders root rows by a two-hop to-one chain", async () => {
      const posts = await client.post.findMany({
        orderBy: [
          {
            reviewer: {
              team: {
                name: { sort: "asc", nulls: "last" },
              },
            },
          },
          { id: "asc" },
        ],
        select: { id: true },
      });

      expect(ids(posts)).toEqual([
        "post-alpha-a",
        "post-alpha-b",
        "post-beta",
        "post-no-author",
        "post-no-company",
        "post-no-reviewer",
        "post-no-team",
      ]);
    });

    test("orders root rows by a three-hop to-one chain", async () => {
      const posts = await client.post.findMany({
        orderBy: [orderByCompanyNameAsc, { id: "asc" }],
        select: { id: true },
      });

      expect(ids(posts)).toEqual([
        "post-alpha-a",
        "post-alpha-b",
        "post-beta",
        "post-no-author",
        "post-no-company",
        "post-no-reviewer",
        "post-no-team",
      ]);
    });

    test("runs the sorting docs three-hop author chain example", async () => {
      const posts = await client.post.findMany({
        orderBy: {
          author: {
            team: {
              company: { name: "asc" },
            },
          },
        },
        select: { id: true },
      });

      expect(new Set(ids(posts))).toEqual(
        new Set([
          "post-alpha-a",
          "post-alpha-b",
          "post-beta",
          "post-no-author",
          "post-no-company",
          "post-no-reviewer",
          "post-no-team",
        ])
      );
    });

    test("places null relation-chain rows according to explicit nulls", async () => {
      const posts = await client.post.findMany({
        orderBy: [
          {
            reviewer: {
              team: {
                company: {
                  name: { sort: "asc", nulls: "first" },
                },
              },
            },
          },
          { id: "asc" },
        ],
        select: { id: true },
      });

      expect(ids(posts)).toEqual([
        "post-no-company",
        "post-no-reviewer",
        "post-no-team",
        "post-alpha-a",
        "post-alpha-b",
        "post-beta",
        "post-no-author",
      ]);
    });

    test("orders a self-relation chain by parent.parent.name", async () => {
      const categories = await client.category.findMany({
        orderBy: [
          {
            parent: {
              parent: {
                name: { sort: "asc", nulls: "last" },
              },
            },
          },
          { id: "asc" },
        ],
        select: { id: true },
      });

      expect(ids(categories)).toEqual([
        "cat-leaf-alpha",
        "cat-leaf-zulu",
        "cat-parent-alpha",
        "cat-parent-zulu",
        "cat-root-alpha",
        "cat-root-zulu",
      ]);
    });

    test("rejects ordering through a to-many relation mid-chain", async () => {
      await expect(
        client.post.findMany({
          orderBy: {
            reviewer: {
              posts: { _count: "asc" },
            },
          } as never,
          select: { id: true },
        })
      ).rejects.toThrow(TO_MANY_ORDER_BY_REJECTION_PATTERN);
    });

    test("combines nested orderBy with take, skip, and scalar tiebreakers", async () => {
      const posts = await client.post.findMany({
        orderBy: [orderByCompanyNameAsc, { title: "desc" }, { id: "asc" }],
        skip: 1,
        take: 3,
        select: { id: true },
      });

      expect(ids(posts)).toEqual([
        "post-alpha-a",
        "post-no-author",
        "post-beta",
      ]);
    });

    test("orders included to-many rows by a nested relation chain", async () => {
      const author = await client.user.findUnique({
        where: { id: "user-author" },
        include: {
          posts: {
            orderBy: [orderByCompanyNameAsc, { title: "desc" }, { id: "asc" }],
            skip: 1,
            take: 3,
            select: { id: true },
          },
        },
      });

      expect(author).not.toBeNull();
      expect(author && ids(author.posts)).toEqual([
        "post-alpha-a",
        "post-beta",
        "post-no-team",
      ]);
    });
  });
}

export const nestedOrderByContract = defineContract({
  id: "drivers.nested-order-by",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runNestedOrderByBehavior,
});
