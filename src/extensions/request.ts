/**
 * The keys of a call's arguments that decide its result's shape, and the
 * types of what a first moment reads and patches.
 */
import type { Operations } from "@client/types";

/**
 * The keys of a call's arguments that decide its result's shape: the one
 * list of them. A first moment's `c.set` refuses each (`call.ts`), and the
 * types of what it reads and patches leave out those its operation has.
 */
const RESULT_SHAPE_KEYS = [
  "select",
  "include",
  "omit",
  "_count",
  "_avg",
  "_sum",
  "_min",
  "_max",
  "by",
] as const;

/** What `c.set` tests a patch's keys against. */
export const SHAPE_KEYS: ReadonlySet<string> = /* @__PURE__ */ new Set(
  RESULT_SHAPE_KEYS
);

type ResultShapeKey = (typeof RESULT_SHAPE_KEYS)[number];

/**
 * Which of those keys each operation has: a future projection spelling
 * extends the list and this table, and the patch types follow.
 */
interface ResultShapeKeysByOperation
  extends Record<Operations, ResultShapeKey> {
  findFirst: "select" | "include" | "omit";
  findMany: "select" | "include" | "omit";
  findUnique: "select" | "include" | "omit";
  findUniqueOrThrow: "select" | "include" | "omit";
  findFirstOrThrow: "select" | "include" | "omit";
  create: "select" | "include" | "omit";
  update: "select" | "include" | "omit";
  delete: "select" | "include" | "omit";
  upsert: "select" | "include" | "omit";
  createMany: "select" | "omit";
  updateMany: "select" | "omit";
  deleteMany: "select" | "omit";
  count: "select";
  aggregate: "_count" | "_avg" | "_sum" | "_min" | "_max";
  groupBy: "by" | "_count" | "_avg" | "_sum" | "_min" | "_max";
  exist: never;
}

type ResultShapeKeyFor<Operation extends Operations> =
  ResultShapeKeysByOperation[Operation];

/** The operation input visible to an ordinary request transform. */
export type RequestTransformInput<
  Operation extends Operations,
  Input extends object,
> = Omit<Input, ResultShapeKeyFor<Operation>>;

/**
 * A shallow patch over the non-projection input. The optional `never`
 * properties make protected keys fail structurally, including held values.
 */
export type RequestTransformPatch<
  Operation extends Operations,
  Input extends object,
> = Partial<RequestTransformInput<Operation, Input>> & {
  readonly [Key in ResultShapeKeyFor<Operation>]?: never;
};
