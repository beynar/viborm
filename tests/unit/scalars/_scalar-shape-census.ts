/**
 * The SHAPE CENSUS of every scalar operation schema.
 *
 * One rendering per kind of the three variants a scalar field owns, spelled as
 * the exact tree the builders produce today: the union arms in order, each
 * object's entry keys IN INSERTION ORDER, and the schema `type` tag of every
 * operand. Nothing here asserts that a shape is right — the per-kind suites do
 * that. This is the EXACTNESS harness for the scalar-builder consolidation
 * (footprint workstream 2): fourteen hand-written builders collapse into one
 * parameterized family plus a per-kind descriptor, and the one thing that may
 * not change while they do is this census.
 *
 * Entry ORDER is part of the contract because it is observable: a payload with
 * two invalid operator keys reports the first one the object validator reaches,
 * and that is entry order. Today the order is an artifact of `.extend()`
 * appending `equals` after a module-level base; a rewrite that spells one
 * literal per kind would quietly reorder eight of them.
 */

import { s } from "@schema";
import type { ScalarState } from "@schema/scalars/common";
import { getScalarSchemas } from "@validation/scalars";

type AnyField = { "~": { state: ScalarState } };

/** One rendering of a schema tree: `type`, its entries in order, its arms. */
export const renderShape = (schema: unknown, depth = 0): string => {
  if (!schema || typeof schema !== "object") return String(schema);
  const node = schema as {
    type?: string;
    options?: readonly unknown[];
    entries?: Record<string, unknown>;
  };
  const type = node.type ?? "?";
  // Three levels reach every operand that differs between kinds; the fourth is
  // the recursive `not`, which `lazyRef` already names.
  if (depth >= 3) return type;
  if (type === "union" && node.options) {
    return `union[${node.options.map((option) => renderShape(option, depth + 1)).join(", ")}]`;
  }
  if (node.entries) {
    const body = Object.entries(node.entries)
      .map(([key, value]) => `${key}: ${renderShape(value, depth + 1)}`)
      .join(", ");
    return `${type}{${body}}`;
  }
  return type;
};

/** Every kind, plus the list arm and the two string domains that narrow it. */
export const scalarShapeCases = (): Record<string, ScalarState> => {
  const cases: Record<string, AnyField> = {
    int: s.int(),
    "int[]": s.int().array(),
    number: s.number(),
    "number[]": s.number().array(),
    bigInt: s.bigInt(),
    "bigInt[]": s.bigInt().array(),
    boolean: s.boolean(),
    "boolean[]": s.boolean().array(),
    string: s.string(),
    "string[]": s.string().array(),
    // A COMPACT id domain drops the four text predicates; a cuid keeps them.
    "string.uuid": s.string().uuid(),
    "string.cuid": s.string().cuid(),
    dateTime: s.dateTime(),
    "dateTime[]": s.dateTime().array(),
    date: s.date(),
    time: s.time(),
    decimal: s.decimal({ precision: 10, scale: 2 }),
    "decimal[]": s.decimal({ precision: 10, scale: 2 }).array(),
    enum: s.enum(["a", "b"]),
    "enum[]": s.enum(["a", "b"]).array(),
    json: s.json(),
    blob: s.blob(),
    vector: s.vector(),
    point: s.point(),
  };
  const states: Record<string, ScalarState> = {};
  for (const [name, field] of Object.entries(cases)) {
    states[name] = field["~"].state;
  }
  return states;
};

export type ShapeCensus = Record<
  string,
  { create: string; update: string; filter: string }
>;

export const buildScalarShapeCensus = (): ShapeCensus => {
  const census: ShapeCensus = {};
  for (const [name, state] of Object.entries(scalarShapeCases())) {
    const schemas = getScalarSchemas(state) as {
      create: unknown;
      update: unknown;
      filter: unknown;
    };
    census[name] = {
      create: renderShape(schemas.create),
      update: renderShape(schemas.update),
      filter: renderShape(schemas.filter),
    };
  }
  return census;
};

export const EXPECTED_SCALAR_SHAPE_CENSUS: ShapeCensus = {
  int: {
    create: "integer",
    update:
      "union[transform, object{set: integer, increment: integer, decrement: integer, multiply: integer, divide: integer}]",
    filter:
      "union[transform, object{in: integer, notIn: integer, lt: comparison_operand, lte: comparison_operand, gt: comparison_operand, gte: comparison_operand, equals: comparison_operand, not: union[transform, lazyRef]}]",
  },
  "int[]": {
    create: "integer",
    update:
      "union[transform, object{set: integer, push: union[transform, integer], unshift: union[transform, integer]}]",
    filter:
      "union[transform, object{has: integer, hasEvery: integer, hasSome: integer, isEmpty: boolean, equals: integer, not: union[transform, lazyRef]}]",
  },
  number: {
    create: "number",
    update:
      "union[transform, object{set: number, increment: number, decrement: number, multiply: number, divide: number}]",
    filter:
      "union[transform, object{in: number, notIn: number, lt: comparison_operand, lte: comparison_operand, gt: comparison_operand, gte: comparison_operand, equals: comparison_operand, not: union[transform, lazyRef]}]",
  },
  "number[]": {
    create: "number",
    update:
      "union[transform, object{set: number, push: union[transform, number], unshift: union[transform, number]}]",
    filter:
      "union[transform, object{has: number, hasEvery: number, hasSome: number, isEmpty: boolean, equals: number, not: union[transform, lazyRef]}]",
  },
  bigInt: {
    create: "bigint",
    update:
      "union[transform, object{set: bigint, increment: bigint, decrement: bigint, multiply: bigint, divide: bigint}]",
    filter:
      "union[transform, object{in: bigint, notIn: bigint, lt: comparison_operand, lte: comparison_operand, gt: comparison_operand, gte: comparison_operand, equals: comparison_operand, not: union[transform, lazyRef]}]",
  },
  "bigInt[]": {
    create: "bigint",
    update:
      "union[transform, object{set: bigint, push: union[transform, bigint], unshift: union[transform, bigint]}]",
    filter:
      "union[transform, object{has: bigint, hasEvery: bigint, hasSome: bigint, isEmpty: boolean, equals: bigint, not: union[transform, lazyRef]}]",
  },
  boolean: {
    create: "boolean",
    update: "union[transform, object{set: boolean}]",
    filter:
      "union[transform, object{equals: comparison_operand, not: union[transform, lazyRef]}]",
  },
  "boolean[]": {
    create: "boolean",
    update:
      "union[transform, object{set: boolean, push: union[transform, boolean], unshift: union[transform, boolean]}]",
    filter:
      "union[transform, object{has: boolean, hasEvery: boolean, hasSome: boolean, isEmpty: boolean, equals: boolean, not: union[transform, lazyRef]}]",
  },
  string: {
    create: "string",
    update: "union[transform, object{set: string}]",
    filter:
      "union[transform, object{in: string, notIn: string, contains: field_ref_or, startsWith: field_ref_or, endsWith: field_ref_or, mode: enum, equals: comparison_operand, lt: comparison_operand, lte: comparison_operand, gt: comparison_operand, gte: comparison_operand, not: union[transform, lazyRef]}]",
  },
  "string[]": {
    create: "string",
    update:
      "union[transform, object{set: string, push: union[transform, string], unshift: union[transform, string]}]",
    filter:
      "union[transform, object{has: string, hasEvery: string, hasSome: string, isEmpty: boolean, equals: string, not: union[transform, lazyRef]}]",
  },
  "string.uuid": {
    create: "string",
    update: "union[transform, object{set: string}]",
    filter:
      "union[transform, object{in: string, notIn: string, equals: comparison_operand, lt: comparison_operand, lte: comparison_operand, gt: comparison_operand, gte: comparison_operand, not: union[transform, lazyRef]}]",
  },
  "string.cuid": {
    create: "string",
    update: "union[transform, object{set: string}]",
    filter:
      "union[transform, object{in: string, notIn: string, contains: field_ref_or, startsWith: field_ref_or, endsWith: field_ref_or, mode: enum, equals: comparison_operand, lt: comparison_operand, lte: comparison_operand, gt: comparison_operand, gte: comparison_operand, not: union[transform, lazyRef]}]",
  },
  dateTime: {
    create: "iso_timestamp",
    update: "union[transform, object{set: iso_timestamp}]",
    filter:
      "union[transform, object{in: iso_timestamp, notIn: iso_timestamp, lt: comparison_operand, lte: comparison_operand, gt: comparison_operand, gte: comparison_operand, equals: comparison_operand, not: union[transform, lazyRef]}]",
  },
  "dateTime[]": {
    create: "iso_timestamp",
    update:
      "union[transform, object{set: iso_timestamp, push: union[transform, iso_timestamp], unshift: union[transform, iso_timestamp]}]",
    filter:
      "union[transform, object{has: iso_timestamp, hasEvery: iso_timestamp, hasSome: iso_timestamp, isEmpty: boolean, equals: iso_timestamp, not: union[transform, lazyRef]}]",
  },
  date: {
    create: "iso_date",
    update: "union[transform, object{set: iso_date}]",
    filter:
      "union[transform, object{in: iso_date, notIn: iso_date, lt: comparison_operand, lte: comparison_operand, gt: comparison_operand, gte: comparison_operand, equals: comparison_operand, not: union[transform, lazyRef]}]",
  },
  time: {
    create: "iso_time",
    update: "union[transform, object{set: iso_time}]",
    filter:
      "union[transform, object{in: iso_time, notIn: iso_time, lt: comparison_operand, lte: comparison_operand, gt: comparison_operand, gte: comparison_operand, equals: comparison_operand, not: union[transform, lazyRef]}]",
  },
  decimal: {
    create: "decimal",
    update:
      "union[transform, exact_one{set: decimal, increment: decimal, decrement: decimal, multiply: decimal, divide: decimal}]",
    filter:
      "union[transform, object{equals: comparison_operand, in: decimal, notIn: decimal, lt: comparison_operand, lte: comparison_operand, gt: comparison_operand, gte: comparison_operand, not: union[transform, lazyRef]}]",
  },
  "decimal[]": {
    create: "decimal",
    update:
      "union[transform, exact_one{set: decimal, push: union[transform, decimal], unshift: union[transform, decimal], increment: refused, decrement: refused, multiply: refused, divide: refused}]",
    filter:
      "union[transform, object{equals: decimal, has: decimal, hasEvery: decimal, hasSome: decimal, isEmpty: boolean, in: refused, notIn: refused, lt: refused, lte: refused, gt: refused, gte: refused, not: union[transform, lazyRef]}]",
  },
  enum: {
    create: "enum",
    update: "union[transform, object{set: enum}]",
    filter:
      "union[transform, object{equals: comparison_operand, in: enum, notIn: enum, lt: refused, lte: refused, gt: refused, gte: refused, not: union[transform, lazyRef]}]",
  },
  "enum[]": {
    create: "enum",
    update:
      "union[transform, object{set: enum, push: union[transform, enum], unshift: union[transform, enum]}]",
    filter:
      "union[transform, object{has: enum, hasEvery: enum, hasSome: enum, isEmpty: boolean, equals: enum, not: union[transform, lazyRef]}]",
  },
  json: {
    create: "json_write",
    update: "transform",
    filter:
      "object{equals: json_null_or, path: union[array, string], mode: enum, lt: union[number, string], lte: union[number, string], gt: union[number, string], gte: union[number, string], string_contains: string, string_starts_with: string, string_ends_with: string, array_contains: no_field_ref, array_starts_with: no_field_ref, array_ends_with: no_field_ref, not: json_null_or}",
  },
  blob: {
    create: "blob",
    update: "union[transform, object{set: blob}]",
    filter:
      "union[transform, object{equals: blob, in: blob, notIn: blob, not: union[transform, lazyRef]}]",
  },
  vector: {
    create: "vector",
    update: "union[transform, object{set: vector}]",
    filter:
      "union[transform, object{equals: vector, not: union[transform, lazyRef]}]",
  },
  point: {
    create: "point",
    update: "union[transform, object{set: point}]",
    filter:
      "union[transform, object{equals: point, distance: object{to: point, lt: number, lte: number, gt: number, gte: number}, within: geo_area, not: union[transform, lazyRef]}]",
  },
};
