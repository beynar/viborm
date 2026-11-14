/**
 * The keys of a call's arguments that decide its result's shape, per
 * operation, and the types of what a first moment reads and patches: a
 * `call`'s `c.set` refuses those keys (`call.ts`).
 */
import type { Operations } from "@client/types";
import type { AdmittedControls } from "./controls";

type RuntimeRequestFunction = (...args: never[]) => unknown;
/** A first moment as a chain keeps it: one function for every call, or per model and operation. */
export type RuntimeRequestContribution =
  | RuntimeRequestFunction
  | Readonly<Record<string, Readonly<Record<string, RuntimeRequestFunction>>>>;

type ResultShapeKey =
  | "select"
  | "include"
  | "omit"
  | "_count"
  | "_avg"
  | "_sum"
  | "_min"
  | "_max"
  | "by";

const resultShapeKeys = <const Keys extends readonly ResultShapeKey[]>(
  ...keys: Keys
): Readonly<Keys> => Object.freeze(keys);

/**
 * The single operation-specific owner of request properties that determine the
 * public result type. A future projection spelling extends this table; runtime
 * detachment and the handler input/patch types then change together.
 */
export const RESULT_SHAPE_KEYS_BY_OPERATION = Object.freeze({
  findFirst: resultShapeKeys("select", "include", "omit"),
  findMany: resultShapeKeys("select", "include", "omit"),
  findUnique: resultShapeKeys("select", "include", "omit"),
  findUniqueOrThrow: resultShapeKeys("select", "include", "omit"),
  findFirstOrThrow: resultShapeKeys("select", "include", "omit"),
  create: resultShapeKeys("select", "include", "omit"),
  update: resultShapeKeys("select", "include", "omit"),
  delete: resultShapeKeys("select", "include", "omit"),
  upsert: resultShapeKeys("select", "include", "omit"),
  createMany: resultShapeKeys("select", "omit"),
  updateMany: resultShapeKeys("select", "omit"),
  deleteMany: resultShapeKeys("select", "omit"),
  count: resultShapeKeys("select"),
  aggregate: resultShapeKeys("_count", "_avg", "_sum", "_min", "_max"),
  groupBy: resultShapeKeys("by", "_count", "_avg", "_sum", "_min", "_max"),
  exist: resultShapeKeys(),
} satisfies Readonly<Record<Operations, readonly ResultShapeKey[]>>);

type ResultShapeKeyFor<Operation extends Operations> =
  (typeof RESULT_SHAPE_KEYS_BY_OPERATION)[Operation][number];

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

/** What the first moments of one call are told about the chain's controls. */
export interface RequestControls {
  /** Every control name on the chain: no patch may name one. */
  readonly names: ReadonlySet<string>;
  /** This call's admitted controls; each owner sees its own. */
  readonly admitted: AdmittedControls | undefined;
}
