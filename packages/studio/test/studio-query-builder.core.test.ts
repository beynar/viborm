import { expect, test } from "vitest";
import type { StudioField, StudioModel } from "../src/schema";
import {
  aggregatable,
  aggregateOf,
  argsOf,
  codeOf,
  computedColumn,
  emptyDraft,
  type QueryDraft,
  tableOf,
} from "../ui/src/lib/query-builder";
import { type Condition, filterWhere, grouped } from "../ui/src/lib/values";

const field = (
  name: string,
  type: StudioField["type"],
  extra: Partial<StudioField> = {}
): StudioField => ({
  name,
  column: name,
  type,
  nullable: false,
  list: false,
  id: false,
  unique: false,
  searchable: type === "string",
  optional: false,
  updatable: true,
  ...extra,
});

const user: StudioModel = {
  name: "user",
  table: "user",
  icon: "user",
  key: { fields: ["id"] },
  fields: [
    field("id", "int", { id: true }),
    field("email", "string", { unique: true }),
    field("karma", "bigint"),
  ],
  relations: [
    {
      name: "posts",
      cardinality: "many",
      targets: ["post"],
      storage: "foreignKey",
      owner: false,
      fields: [],
      references: [],
    },
  ],
};
const models = [user];
const draft = (change: Partial<QueryDraft> = {}): QueryDraft => ({
  ...emptyDraft(user),
  ...change,
});

test("rows: conditions, an order, a page, columns and relations", () => {
  expect(
    argsOf(
      user,
      models,
      "findMany",
      draft({
        conditions: [
          { id: 1, field: "email", operator: "contains", value: "ada" },
          // Waiting for its value: left out.
          { id: 2, field: "karma", operator: "gt", value: "" },
          { id: 3, field: "karma", operator: "isNull", value: "" },
        ],
        combinator: "OR",
        sort: [
          { id: 1, field: "karma", desc: true },
          { id: 2, field: "", desc: false },
        ],
        skip: 5,
        columns: ["email"],
        include: ["posts"],
      })
    )
  ).toEqual({
    where: { OR: [{ email: { contains: "ada" } }, { karma: null }] },
    orderBy: [{ karma: "desc" }],
    take: 20,
    skip: 5,
    select: { email: true, posts: true },
  });
  expect(
    argsOf(user, models, "findFirst", draft({ include: ["posts"] }))
  ).toEqual({ include: { posts: true } });
  expect(argsOf(user, models, "count", draft())).toEqual({});
});

test("one row by a unique column, typed", () => {
  expect(
    argsOf(
      user,
      models,
      "findUnique",
      draft({ key: { field: "id", value: " 7 " } })
    )
  ).toEqual({ where: { id: 7 } });
  expect(() =>
    argsOf(user, models, "findUnique", draft({ key: { field: "", value: "" } }))
  ).toThrow("Choose the column");
  expect(() => argsOf(user, models, "findUnique", draft())).toThrow(
    "Write the id"
  );
});

test("values computed over the rows, and per group", () => {
  const computed: QueryDraft["computed"] = [
    { id: 1, fn: "_count", field: "" },
    { id: 2, fn: "_count", field: "email" },
    { id: 3, fn: "_avg", field: "karma" },
    { id: 4, fn: "_sum", field: "" },
  ];
  expect(argsOf(user, models, "aggregate", draft({ computed }))).toEqual({
    _count: { _all: true, email: true },
    _avg: { karma: true },
  });
  expect(
    argsOf(
      user,
      models,
      "aggregate",
      draft({ computed: [computed[1]!, computed[0]!] })
    )
  ).toEqual({ _count: { email: true, _all: true } });
  expect(
    argsOf(
      user,
      models,
      "groupBy",
      draft({
        by: ["email"],
        computed: [computed[0]!],
        // An order on a column the groups do not share is left out.
        sort: [
          { id: 1, field: "email", desc: false },
          { id: 2, field: "karma", desc: true },
        ],
      })
    )
  ).toEqual({
    by: ["email"],
    _count: true,
    orderBy: [{ email: "asc" }],
    take: 20,
  });
  expect(() => argsOf(user, models, "groupBy", draft())).toThrow(
    "Choose the columns"
  );
});

test("the call as the application writes it", () => {
  expect(codeOf("user", "count", {})).toBe("await client.user.count();");
  expect(codeOf("user", "findMany", { take: 2, "a-b": 1 })).toBe(
    'await client.user.findMany({\n  take: 2,\n  "a-b": 1\n});'
  );
});

test("results as table rows", () => {
  expect(tableOf(null)).toEqual({ columns: [], rows: [] });
  expect(tableOf({ id: 1 })).toEqual({ columns: ["id"], rows: [{ id: 1 }] });
  expect(
    tableOf([
      { role: "a", _count: 2, _sum: { karma: "5" }, posts: [1] },
      { role: "b", _count: 1, _sum: { karma: null }, profile: null },
      7,
    ])
  ).toEqual({
    columns: ["role", "_count", "_sum.karma", "posts", "profile", "value"],
    rows: [
      { role: "a", _count: 2, "_sum.karma": "5", posts: [1] },
      { role: "b", _count: 1, "_sum.karma": null, profile: null },
      { value: 7 },
    ],
  });
});

test("computed columns read as numbers, or as the column they are the extreme of", () => {
  const joined = field("joinedAt", "datetime");
  const dated = { ...user, fields: [...user.fields, joined] };
  expect(computedColumn(dated, "_count")).toEqual({
    label: "count",
    numeric: true,
  });
  expect(computedColumn(dated, "_count._all")?.label).toBe("count");
  expect(computedColumn(dated, "_avg.karma")).toEqual({
    label: "average · karma",
    numeric: true,
  });
  expect(computedColumn(dated, "_max.joinedAt")).toEqual({
    label: "maximum · joinedAt",
    numeric: false,
    field: joined,
  });
  expect(computedColumn(dated, "_min.karma")?.numeric).toBe(true);
  expect(computedColumn(undefined, "_min.gone")?.numeric).toBe(true);
  expect(computedColumn(dated, "email")).toBeUndefined();
});

test("numbers read with their thousands apart", () => {
  expect(grouped(8_500_000_059_500)).toBe(
    "8\u202f500\u202f000\u202f059\u202f500"
  );
  expect(grouped("-1234567.891")).toBe("-1\u202f234\u202f567.891");
  expect(grouped("999")).toBe("999");
  expect(grouped("abc")).toBe("abc");
  expect(grouped(null)).toBe("null");
});

test("a lookup by key reads no condition, even one that cannot be read", () => {
  expect(
    argsOf(
      user,
      models,
      "findUnique",
      draft({
        conditions: [{ id: 1, field: "id", operator: "gt", value: "abc" }],
        key: { field: "id", value: "7" },
      })
    )
  ).toEqual({ where: { id: 7 } });
  expect(() =>
    argsOf(
      user,
      models,
      "findMany",
      draft({
        conditions: [{ id: 1, field: "id", operator: "gt", value: "abc" }],
      })
    )
  ).toThrow();
});

test("an empty text is a value; an empty number or list is not yet", () => {
  const where = (condition: Omit<Condition, "id">) =>
    argsOf(
      user,
      models,
      "count",
      draft({ conditions: [{ id: 1, ...condition }] })
    );
  expect(where({ field: "email", operator: "equals", value: "" })).toEqual({
    where: { email: { equals: "" } },
  });
  expect(where({ field: "email", operator: "in", value: " " })).toEqual({});
  expect(where({ field: "karma", operator: "equals", value: "" })).toEqual({});
  expect(where({ field: "gone", operator: "equals", value: "x" })).toEqual({});
});

test("a count reads any column, a list's too; sums and extremes only theirs", () => {
  const tagged = {
    ...user,
    fields: [...user.fields, field("tags", "string", { list: true })],
  };
  const names = (fn: Parameters<typeof aggregatable>[1]) =>
    aggregatable(tagged, fn).map((entry) => entry.name);
  expect(names("_count")).toEqual(["id", "email", "karma", "tags"]);
  expect(names("_sum")).toEqual(["id", "karma"]);
  expect(names("_max")).toEqual(["id", "email", "karma"]);
  expect(aggregateOf("_avg")?.label).toBe("average");
  expect(aggregateOf("median")).toBeUndefined();
});

test("groups join their conditions their own way: all, any or none, nested", () => {
  const where = filterWhere(
    user,
    models,
    [
      { id: 1, field: "email", operator: "contains", value: "ada" },
      {
        id: 2,
        group: true,
        combinator: "OR",
        conditions: [
          { id: 1, field: "karma", operator: "gt", value: "10" },
          {
            id: 2,
            group: true,
            combinator: "NOT",
            conditions: [
              { id: 1, field: "email", operator: "contains", value: "test" },
              { id: 2, field: "id", operator: "equals", value: "3" },
            ],
          },
        ],
      },
      // A group holding only a condition waiting for its value says nothing.
      {
        id: 3,
        group: true,
        combinator: "AND",
        conditions: [{ id: 1, field: "id", operator: "gt", value: "" }],
      },
      { id: 4, group: true, combinator: "OR", conditions: [] },
    ],
    "AND"
  );
  expect(where).toEqual({
    count: 4,
    where: {
      AND: [
        { email: { contains: "ada" } },
        {
          OR: [
            { karma: { gt: "10" } },
            {
              NOT: [{ email: { contains: "test" } }, { id: { equals: 3 } }],
            },
          ],
        },
      ],
    },
  });
  // None of one condition, at the top.
  expect(
    filterWhere(
      user,
      models,
      [{ id: 1, field: "id", operator: "equals", value: "1" }],
      "NOT"
    )
  ).toEqual({ count: 1, where: { NOT: [{ id: { equals: 1 } }] } });
  expect(filterWhere(user, models, [], "OR")).toEqual({
    count: 0,
    where: undefined,
  });
});
