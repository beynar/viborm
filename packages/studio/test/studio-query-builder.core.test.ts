import { expect, test } from "vitest";
import type { StudioField, StudioModel } from "../src/schema";
import {
  argsOf,
  codeOf,
  computedColumn,
  emptyDraft,
  type QueryDraft,
  tableOf,
} from "../ui/src/lib/query-builder";
import { grouped } from "../ui/src/lib/values";

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
