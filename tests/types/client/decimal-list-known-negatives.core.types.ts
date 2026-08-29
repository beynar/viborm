import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { createClient } from "@src/index";
import { describe, expectTypeOf, test } from "vitest";

const entry = s.model({
  id: s.string().id(),
  count: s.int(),
  amounts: s.decimal({ precision: 10, scale: 2 }).array(),
  counts: s.int().array(),
});

const publicDecimalListNegativeProbes = () => {
  const client = createClient({
    schema: { entry },
    driver: new PGliteDriver(),
  });

  client.entry.findMany({
    where: {
      // @ts-expect-error - a decimal list has no scalar in filter
      amounts: { equals: [], in: ["1"] },
    },
  });
  client.entry.findMany({
    where: {
      // @ts-expect-error - a decimal list has no scalar notIn filter
      amounts: { equals: [], notIn: ["1"] },
    },
  });
  client.entry.findMany({
    where: {
      // @ts-expect-error - a decimal list has no numeric lt filter
      amounts: { equals: [], lt: "1" },
    },
  });
  client.entry.findMany({
    where: {
      // @ts-expect-error - a decimal list has no numeric lte filter
      amounts: { equals: [], lte: "1" },
    },
  });
  client.entry.findMany({
    where: {
      // @ts-expect-error - a decimal list has no numeric gt filter
      amounts: { equals: [], gt: "1" },
    },
  });
  client.entry.findMany({
    where: {
      // @ts-expect-error - a decimal list has no numeric gte filter
      amounts: { equals: [], gte: "1" },
    },
  });
  client.entry.findMany({
    where: {
      // @ts-expect-error - recursive not inherits the closed list surface
      amounts: { not: { has: "1", gt: "2" } },
    },
  });

  client.entry.update({
    where: { id: "entry", amounts: { has: "1" } },
    data: {
      // @ts-expect-error - decimal lists have no increment update
      amounts: { set: [], increment: "1" },
    },
  });
  client.entry.update({
    where: { id: "entry" },
    data: {
      // @ts-expect-error - decimal lists have no decrement update
      amounts: { set: [], decrement: "1" },
    },
  });
  client.entry.update({
    where: { id: "entry" },
    data: {
      // @ts-expect-error - decimal lists have no multiply update
      amounts: { set: [], multiply: "2" },
    },
  });
  client.entry.update({
    where: { id: "entry" },
    data: {
      // @ts-expect-error - decimal lists have no divide update
      amounts: { set: [], divide: "2" },
    },
  });

  client.entry.groupBy({
    by: ["id"],
    having: {
      // @ts-expect-error - list having exposes only _count
      amounts: {
        _count: { gt: 0 },
        _avg: { gt: "1" },
      },
    },
    // @ts-expect-error - grouped _min cannot project a decimal list
    _min: { count: true, amounts: true },
    orderBy: [
      // @ts-expect-error - aggregate ordering retains a non-decimal list as never
      { _max: { count: "asc", counts: "desc" } },
      { _count: { amounts: "asc", counts: "desc" } },
    ],
  });

  client.entry.aggregate({
    // @ts-expect-error - a decimal list cannot be projected by _sum
    _sum: { count: true, amounts: true },
  });

  client.entry.findMany({
    // @ts-expect-error - a decimal list cannot be cursor identity
    cursor: { id: "entry", amounts: [] },
  });
};

describe("public decimal-list known-negative surfaces", () => {
  test("the probes enter through public client calls", () => {
    expectTypeOf(publicDecimalListNegativeProbes).toBeFunction();
  });
});
