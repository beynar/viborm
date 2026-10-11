// biome-ignore-all lint/suspicious/noMisplacedAssertion: the assertion helpers are invoked only from registered tests.
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { UnsupportedOperationError, ValidationError } from "@errors";
import { s } from "@schema";
import { AnyNull, DbNull, JsonNull } from "@schema/json-null";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * Which CLASS a refusal is, through the public client on a real database.
 *
 * A caller-input mistake is `ValidationError` V4001 carrying the path of the
 * operator that is wrong — never `V9001` ("a bug; please report it") or a
 * database `V2001`. A recursive projection whose output outgrows its budget is
 * a result-size refusal, `UnsupportedOperationError` V8003, that names the
 * operation the caller actually ran and the budget it exceeded.
 *
 * World: one category tree, a root with 100 children of 120 grandchildren
 * each — 12,100 descendants, past the default budget of 10,000 output
 * occurrences while a plain two-level include reads the same rows.
 */

const CHILDREN = 100;
const GRANDCHILDREN = 120;
const DESCENDANTS = CHILDREN + CHILDREN * GRANDCHILDREN;
const DEFAULT_BUDGET = 10_000;
const BUDGET_REFUSAL = /maxOccurrences must be a positive safe integer/;
const NAMES_NOTHING = /needs at least one truthy value/;
const EMPTY_BY = /at least one field/;
const OUTSIDE_BY = /must be included in 'by'/;
const SENTINEL_UNDER_PATH = /cannot combine 'path' with the \w+Null sentinel/;
const SENTINEL_AS_FILTER = /DbNull is an operand, not a JSON filter/;

function refusalSchema() {
  const category = s.model({
    id: s.int().id(),
    name: s.string(),
    parentId: s.int().nullable(),
    parent: s
      .toOne(() => category)
      .fields("parentId")
      .references("id"),
    children: s.toMany(() => category),
  });
  const account = s.model({
    id: s.int().id(),
    email: s.string().unique(),
    role: s.enum(["USER", "ADMIN"]).default("USER"),
    meta: s.json().nullable(),
  });
  return { category, account };
}

function categoryRows() {
  const rows: { id: number; name: string; parentId: number | null }[] = [
    { id: 1, name: "root", parentId: null },
  ];
  let id = 2;
  for (let child = 0; child < CHILDREN; child += 1) {
    const childId = id++;
    rows.push({ id: childId, name: `c${childId}`, parentId: 1 });
    for (let grandchild = 0; grandchild < GRANDCHILDREN; grandchild += 1) {
      rows.push({ id, name: `g${id}`, parentId: childId });
      id += 1;
    }
  }
  return rows;
}

/** Every occurrence of a decoded `children` tree, the root's own excluded. */
function countOccurrences(nodes: unknown): number {
  if (!Array.isArray(nodes)) return 0;
  let total = 0;
  for (const node of nodes) {
    total += 1 + countOccurrences((node as { children?: unknown }).children);
  }
  return total;
}

async function refusalOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to be refused");
}

/** A V4001 whose issue is reported at `path`, with no internal key leaking. */
function expectCallerInputRefusal(
  error: unknown,
  operation: string,
  path: string,
  message: RegExp
) {
  expect(error).toBeInstanceOf(ValidationError);
  const refusal = error as ValidationError;
  expect(refusal.code).toBe("V4001");
  expect(refusal.operation).toBe(operation);
  expect(refusal.issues).toHaveLength(1);
  expect(refusal.issues[0]!.path).toBe(path);
  expect(refusal.issues[0]!.message).toMatch(message);
  expect(refusal.message).not.toContain("kind");
}

/** The result-size refusal: V8003, the operation the caller ran, the budget. */
function expectBudgetRefusal(error: unknown, operation: string, limit: number) {
  expect(error).toBeInstanceOf(UnsupportedOperationError);
  const refusal = error as UnsupportedOperationError;
  expect(refusal.code).toBe("V8003");
  expect(refusal.message).toContain(`'${operation}'`);
  expect(refusal.message).toContain(`${limit}`);
  expect(refusal.meta).toMatchObject({
    operation,
    relation: "children",
    feature: "recursive output budget",
  });
}

export function runRefusalClassificationBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}) {
  describe(`${options.name}: refusal classification`, () => {
    const schema = refusalSchema();
    let client: ReturnType<
      typeof createClient<
        typeof schema,
        { schema: typeof schema; driver: AnyDriver }
      >
    >;

    beforeAll(async () => {
      client = createClient({ schema, driver: options.createDriver() });
      await syncLiveSchema(client);
      const rows = categoryRows();
      for (let start = 0; start < rows.length; start += 2000) {
        await client.category.createMany({
          data: rows.slice(start, start + 2000),
        });
      }
      await client.account.createMany({
        data: [
          { id: 1, email: "a@x", meta: DbNull },
          { id: 2, email: "b@x", role: "ADMIN", meta: { a: null } },
        ],
      });
    }, 120_000);

    afterAll(async () => {
      await client.$disconnect();
    });

    describe("the recursive output budget", () => {
      test("a plain two-level include reads every row the budget refuses", async () => {
        const root = await client.category.findUnique({
          where: { id: 1 },
          select: {
            id: true,
            children: {
              select: { id: true, children: { select: { id: true } } },
            },
          },
        });
        expect(countOccurrences(root?.children)).toBe(DESCENDANTS);
      });

      test("an over-budget projection is a V8003 naming the operation that ran", async () => {
        const select = {
          id: true,
          children: { recurse: true, select: { id: true } },
        } as const;
        expectBudgetRefusal(
          await refusalOf(() =>
            client.category.findUnique({ where: { id: 1 }, select })
          ),
          "findUnique",
          DEFAULT_BUDGET
        );
        expectBudgetRefusal(
          await refusalOf(() =>
            client.category.findFirst({ where: { id: 1 }, select })
          ),
          "findFirst",
          DEFAULT_BUDGET
        );
        expectBudgetRefusal(
          await refusalOf(() =>
            client.category.findMany({
              where: { id: 1 },
              select: {
                id: true,
                children: { recurse: { depth: false }, select: { id: true } },
              },
            })
          ),
          "findMany",
          DEFAULT_BUDGET
        );
      });

      test("recurse.maxOccurrences raises the budget for one projection", async () => {
        const root = await client.category.findUnique({
          where: { id: 1 },
          select: {
            id: true,
            children: {
              recurse: { depth: false, maxOccurrences: DESCENDANTS },
              select: { id: true },
            },
          },
        });
        expect(countOccurrences(root?.children)).toBe(DESCENDANTS);
      });

      test("recurse.maxOccurrences lowers the budget for one projection", async () => {
        const limit = CHILDREN;
        expectBudgetRefusal(
          await refusalOf(() =>
            client.category.findUnique({
              where: { id: 1 },
              select: {
                id: true,
                children: {
                  recurse: { depth: 2, maxOccurrences: limit },
                  select: { id: true },
                },
              },
            })
          ),
          "findUnique",
          limit
        );
        // Exactly at the budget is admitted: the children alone are 100.
        const shallow = await client.category.findUnique({
          where: { id: 1 },
          select: {
            id: true,
            children: {
              recurse: { depth: 1, maxOccurrences: limit },
              select: { id: true },
            },
          },
        });
        expect(countOccurrences(shallow?.children)).toBe(CHILDREN);
      });

      test("a budget that is not a positive safe integer is a V4001 at its path", async () => {
        for (const maxOccurrences of [
          0,
          -1,
          1.5,
          Number.MAX_SAFE_INTEGER + 1,
        ]) {
          expectCallerInputRefusal(
            await refusalOf(() =>
              client.category.findUnique({
                where: { id: 1 },
                select: {
                  id: true,
                  children: {
                    recurse: { maxOccurrences },
                    select: { id: true },
                  },
                },
              })
            ),
            "findUnique",
            "select.children.recurse.maxOccurrences",
            BUDGET_REFUSAL
          );
        }
      });
    });

    describe("caller-input refusals", () => {
      test("a JSON null sentinel under a `path` is a V4001 at its filter", async () => {
        expectCallerInputRefusal(
          await refusalOf(() =>
            client.account.findMany({
              where: { meta: { path: ["a"], equals: JsonNull } },
            })
          ),
          "findMany",
          "where.meta",
          SENTINEL_UNDER_PATH
        );
        // The path is the operator's own, however deep the filter sits.
        expectCallerInputRefusal(
          await refusalOf(() =>
            client.account.findMany({
              where: { NOT: { meta: { path: ["a"], equals: DbNull } } },
            })
          ),
          "findMany",
          "where.NOT.meta",
          SENTINEL_UNDER_PATH
        );
        // A path scopes its `not` too, in both spellings.
        for (const not of [JsonNull, { equals: AnyNull }]) {
          expectCallerInputRefusal(
            await refusalOf(() =>
              client.account.findMany({ where: { meta: { path: ["a"], not } } })
            ),
            "findMany",
            "where.meta",
            SENTINEL_UNDER_PATH
          );
        }
        // `equals: null` under a path is the JSON null there, and a sentinel
        // without a path addresses the whole column.
        await expect(
          client.account.findMany({
            where: { meta: { path: ["a"], equals: null } },
            select: { id: true },
          })
        ).resolves.toEqual([{ id: 2 }]);
        await expect(
          client.account.findMany({
            where: { meta: { equals: DbNull } },
            select: { id: true },
          })
        ).resolves.toEqual([{ id: 1 }]);
      });

      test("a JSON null sentinel in the field's own position is a V4001 there", async () => {
        expectCallerInputRefusal(
          await refusalOf(() =>
            // @ts-expect-error a sentinel is an operand, not a filter
            client.account.findMany({ where: { meta: DbNull } })
          ),
          "findMany",
          "where.meta",
          SENTINEL_AS_FILTER
        );
      });

      test("groupBy with an empty `by` is a V4001 at `by`", async () => {
        expectCallerInputRefusal(
          await refusalOf(() => client.account.groupBy({ by: [] })),
          "groupBy",
          "by",
          EMPTY_BY
        );
      });

      test("groupBy ordering by a field outside `by` is a V4001 at `orderBy`", async () => {
        expectCallerInputRefusal(
          await refusalOf(() =>
            client.account.groupBy({
              by: ["role"],
              orderBy: { email: "asc" },
            })
          ),
          "groupBy",
          "orderBy.email",
          OUTSIDE_BY
        );
        expectCallerInputRefusal(
          await refusalOf(() =>
            client.account.groupBy({
              by: ["role"],
              orderBy: [{ role: "asc" }, { email: "desc" }],
            })
          ),
          "groupBy",
          "orderBy.1.email",
          OUTSIDE_BY
        );
        // A grouped field and an aggregate ordering stay admitted.
        await expect(
          client.account.groupBy({
            by: ["role"],
            _count: { _all: true },
            orderBy: [{ role: "asc" }, { _count: { email: "desc" } }],
          })
        ).resolves.toHaveLength(2);
      });

      test("groupBy `having` on a field outside `by` is a V4001 at its path", async () => {
        const cases: [unknown, string][] = [
          [
            await refusalOf(() =>
              client.account.groupBy({ by: ["role"], having: { email: "a@x" } })
            ),
            "having.email",
          ],
          [
            await refusalOf(() =>
              client.account.groupBy({
                by: ["role"],
                having: { OR: [{ role: "USER" }, { email: "a@x" }] },
              })
            ),
            "having.OR.1.email",
          ],
          [
            await refusalOf(() =>
              client.account.groupBy({
                by: ["role"],
                having: { NOT: { email: "a@x" } },
              })
            ),
            "having.NOT.email",
          ],
          [
            await refusalOf(() =>
              client.account.groupBy({
                by: ["role"],
                having: { AND: [{ NOT: [{ email: "a@x" }] }] },
              })
            ),
            "having.AND.0.NOT.0.email",
          ],
        ];
        for (const [error, path] of cases)
          expectCallerInputRefusal(error, "groupBy", path, OUTSIDE_BY);
        // A grouped field and an aggregate condition stay admitted.
        await expect(
          client.account.groupBy({
            by: ["role"],
            having: { role: "USER", email: { _count: { gt: 0 } } },
          })
        ).resolves.toEqual([{ role: "USER" }]);
      });

      test("`select: { _count: true }` on a model with no to-many relation is a V4001 at `select`", async () => {
        // `account` owns no to-many relation, so the count names nothing.
        expectCallerInputRefusal(
          await refusalOf(() =>
            client.account.findMany({ select: { _count: true } })
          ),
          "findMany",
          "select",
          NAMES_NOTHING
        );
        expectCallerInputRefusal(
          await refusalOf(() =>
            client.category.findFirst({
              select: { parent: { select: { _count: { select: {} } } } },
            })
          ),
          "findFirst",
          "select.parent.select",
          NAMES_NOTHING
        );
        // Beside a field it still publishes no `_count`, as in 1.1.0.
        await expect(
          client.account.findUnique({
            where: { id: 1 },
            select: { id: true, _count: true },
          })
        ).resolves.toEqual({ id: 1 });
      });

      test("a bulk write with `select: {}` is a V4001 at `select`", async () => {
        expectCallerInputRefusal(
          await refusalOf(() =>
            client.account.createMany({
              data: [{ id: 3, email: "c@x" }],
              select: {},
            })
          ),
          "createMany",
          "select",
          NAMES_NOTHING
        );
        expectCallerInputRefusal(
          await refusalOf(() =>
            client.account.updateMany({
              where: { id: 1 },
              data: { role: "ADMIN" },
              select: {},
            })
          ),
          "updateMany",
          "select",
          NAMES_NOTHING
        );
        expectCallerInputRefusal(
          await refusalOf(() =>
            client.account.deleteMany({ where: { id: 99 }, select: {} })
          ),
          "deleteMany",
          "select",
          NAMES_NOTHING
        );
        // Nothing was written by the refused calls.
        await expect(client.account.count()).resolves.toBe(2);
        await expect(
          client.account.findUnique({
            where: { id: 1 },
            select: { role: true },
          })
        ).resolves.toEqual({ role: "USER" });
      });
    });
  });
}
