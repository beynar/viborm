/**
 * Unpaged aggregates at scale, read off the plan of the statement they ran.
 *
 * An aggregate is order-blind: only a page (`take`, `skip`, `cursor`) needs
 * the key-ordered window. Shared by the SQLite and PGlite plan tests, which
 * seed {@link AGGREGATE_PLAN_ROWS} posts and ask their provider how it would
 * run each captured statement.
 */
import type { VibORMClient, VibORMConfig } from "@client/client";
import { s } from "@schema";
import type { Sql } from "@sql";

export const AGGREGATE_PLAN_ROWS = 100_000;
export const AGGREGATE_PLAN_AUTHORS = 1000;

const author = s.model({
  id: s.int().id().increment(),
  email: s.string().unique(),
  createdAt: s.dateTime().now(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.int().id().increment(),
  title: s.string(),
  views: s.int(),
  authorId: s.int(),
  author: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});
export const aggregatePlanSchema = { author, post };

type PlanClient = VibORMClient<VibORMConfig<typeof aggregatePlanSchema>>;

/** One aggregate read: its answer, the answer it must give, and its plans. */
export interface AggregatePlanRead {
  readonly label: string;
  readonly paged: boolean;
  readonly value: unknown;
  readonly expected: unknown;
  /** The plan of every statement the read ran, as `plan` describes it. */
  readonly plans: readonly string[][];
}

/**
 * Runs every unpaged aggregate verb and one paged control over the seeded rows
 * (post `n` has `views = n` and author `n % 1000 + 1`), with the plan of each
 * statement it ran.
 */
export async function aggregatePlanReads(
  client: PlanClient,
  plan: (statement: Sql) => Promise<string[]>
): Promise<AggregatePlanRead[]> {
  const statements: Sql[] = [];
  const observed = client.$extends({
    name: "aggregate-plan-witness",
    statement(context) {
      statements.push(context.statement);
      return context.statement;
    },
  });
  const reads: [string, () => Promise<unknown>, unknown][] = [
    ["count()", () => observed.post.count(), AGGREGATE_PLAN_ROWS],
    [
      "count({ where })",
      () => observed.post.count({ where: { authorId: 7 } }),
      AGGREGATE_PLAN_ROWS / AGGREGATE_PLAN_AUTHORS,
    ],
    [
      "aggregate({ _sum, where })",
      () =>
        observed.post.aggregate({
          _sum: { views: true },
          where: { views: { gt: AGGREGATE_PLAN_ROWS - 10 } },
        }),
      { _sum: { views: 10 * AGGREGATE_PLAN_ROWS - 45 } },
    ],
    [
      "exist({ where })",
      () => observed.post.exist({ where: { authorId: 999 } }),
      true,
    ],
    ["count({ take }) [paged]", () => observed.post.count({ take: 10 }), 10],
  ];
  const results: AggregatePlanRead[] = [];
  for (const [label, read, expected] of reads) {
    statements.length = 0;
    const value = await read();
    const plans: string[][] = [];
    for (const statement of [...statements]) plans.push(await plan(statement));
    results.push({
      label,
      paged: label.endsWith("[paged]"),
      value,
      expected,
      plans,
    });
  }
  return results;
}
