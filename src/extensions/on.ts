/**
 * `target(...)`: the models and operations a `call` or an `around` concerns,
 * and the named operation sets `target` and an argument's `.on(...)` take.
 * (`target`, not `on`: `on` is the hooks of `viborm/on`.) A selection is plain
 * data; the part that reads it resolves it against the schema it is joined
 * to. The types refuse an operation or a model a client does not have.
 */
import type {
  CacheableOperations,
  MutationOperations,
  Operations,
} from "@client/types";
import { ROUTED_OPERATIONS } from "@query-engine/routed-operations";
import type {
  AnyTarget,
  DeleteOperations,
  ModelName,
  OperationSet,
  SelectingOperations,
  Selection,
} from "./contract";
import { type WatchPart, watchPart } from "./watch-part";

/** What `target(...)` returns at runtime, and what an operation set is. */
export interface SelectionValue {
  /** The models named; every model when absent. */
  readonly models?: readonly string[] | undefined;
  /** The operations named; every operation when absent. */
  readonly operations?: readonly Operations[] | undefined;
  /** What watches the writes named, when a set that brings it named them. */
  readonly watch?: WatchPart | undefined;
}

function set<O extends Operations>(
  operations: readonly O[],
  watch?: WatchPart
): OperationSet<O>;
function set(operations: readonly Operations[], watch?: WatchPart): unknown {
  return { operations, watch };
}

/** Every operation a model has. */
export const MODEL_OPERATIONS: ReadonlySet<string> = ROUTED_OPERATIONS;

/** Every read. */
export const reads = /* @__PURE__ */ set<CacheableOperations>([
  "findMany",
  "findUnique",
  "findFirst",
  "findUniqueOrThrow",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "exist",
]);
/** Every write: a `call` or an `around` on them may `watch` its rows and be `settled`. */
export const writes = /* @__PURE__ */ set<MutationOperations>(
  [
    "create",
    "update",
    "delete",
    "upsert",
    "createMany",
    "updateMany",
    "deleteMany",
  ],
  watchPart
);
/** `delete` and `deleteMany`. */
export const deletes = /* @__PURE__ */ set<DeleteOperations>(
  ["delete", "deleteMany"],
  watchPart
);
/** Every operation that selects rows: all but `create` and `createMany`. */
export const selecting = /* @__PURE__ */ set<SelectingOperations>([
  "findMany",
  "findUnique",
  "findFirst",
  "findUniqueOrThrow",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "exist",
  "update",
  "delete",
  "upsert",
  "updateMany",
  "deleteMany",
]);
/** Every model operation, and no raw statement. */
export const models = /* @__PURE__ */ set<Operations>([
  "findMany",
  "findUnique",
  "findFirst",
  "findUniqueOrThrow",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "exist",
  "create",
  "update",
  "delete",
  "upsert",
  "createMany",
  "updateMany",
  "deleteMany",
]);

/**
 * A `Selection` or an `OperationSet` as it is at runtime: the value
 * `target(...)` or a set returned. Their types carry what only the compiler
 * reads (the client a selection is typed against), so this one assertion
 * crosses from those types to the value.
 */
export const selectionOf = (value: unknown): SelectionValue | undefined =>
  value as SelectionValue | undefined;

/** The operations of a set, of a list, or of one name. */
export const operationsOf = (
  value: unknown
): readonly Operations[] | undefined =>
  typeof value === "string"
    ? // One name, which the overloads typed as an operation.
      [value as Operations]
    : Array.isArray(value)
      ? value
      : selectionOf(value)?.operations;

/**
 * One model (or several), these operations (every one when absent). First:
 * an editor completes a string argument from the first signature.
 */
export function target<
  T extends AnyTarget,
  const M extends ModelName<T> = ModelName<T>,
  const O extends Operations = Operations,
>(
  models: M | readonly M[],
  operations?: O | readonly O[] | OperationSet<O>
): Selection<T, M, O>;
/** Every model, these operations: `target(reads)`. */
export function target<T extends AnyTarget, O extends Operations>(
  operations: OperationSet<O>
): Selection<T, ModelName<T>, O>;
export function target(first: unknown, operations?: unknown): unknown {
  // An operation set alone: every model, those operations.
  if (typeof first === "object" && !Array.isArray(first)) return first;
  return {
    models: typeof first === "string" ? [first] : first,
    operations: operationsOf(operations),
    // A set's own; a list or a name has none.
    watch: selectionOf(operations)?.watch,
  };
}
