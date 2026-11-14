/**
 * `target(...)`: the models and operations a `call` or an `around` concerns,
 * and the named operation sets `target` and an argument's `.on(...)` take.
 * (`target`, not `on`: `on` is the hooks of `viborm/on`.) A selection is plain
 * data; the part that reads it resolves it against the schema it is joined
 * to.
 */
import type { Operations } from "@client/types";
import type { ExtensionPart } from "./chain";
import type {
  AnyTarget,
  DeleteOperations,
  ModelName,
  OperationSet,
  ReadOperations,
  SelectingOperations,
  Selection,
  WriteOperations,
} from "./contract";
import { watchPart } from "./watch-part";

const SET = Symbol("viborm.operations");

/** An operation set at runtime: its operations, and what watches them. */
export interface OperationList {
  readonly [SET]: readonly Operations[];
  readonly watch?: ExtensionPart;
}

function set<O extends Operations>(
  operations: readonly O[],
  watch?: ExtensionPart
): OperationSet<O>;
function set(
  operations: readonly Operations[],
  watch?: ExtensionPart
): unknown {
  const list: OperationList = {
    [SET]: Object.freeze([...operations]),
    ...(watch === undefined ? {} : { watch }),
  };
  return Object.freeze(list);
}

const READS = [
  "findMany",
  "findUnique",
  "findFirst",
  "findUniqueOrThrow",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "exist",
] as const;
const WRITES = [
  "create",
  "update",
  "delete",
  "upsert",
  "createMany",
  "updateMany",
  "deleteMany",
] as const;

/** Every operation a model has. */
export const MODEL_OPERATIONS = [
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
] as const;

const isOperation = (value: unknown): value is Operations =>
  MODEL_OPERATIONS.some((operation) => operation === value);

/** Every read. */
export const reads = /* @__PURE__ */ set<ReadOperations>(READS);
/** Every write: a `call` on them may `watch` its rows and be `settled`. */
export const writes = /* @__PURE__ */ set<WriteOperations>(WRITES, watchPart);
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
export const models = /* @__PURE__ */ set<Operations>(MODEL_OPERATIONS);

/** The operations of a set, of a list, or of one name. */
export function operationsOf(
  value: unknown
): readonly Operations[] | undefined {
  if (value === undefined) return undefined;
  const named: unknown[] | undefined =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value
        : undefined;
  if (named !== undefined) {
    if (!named.every(isOperation))
      throw new TypeError("target() and .on() name model operations");
    return named;
  }
  const listed =
    typeof value === "object" && value !== null && SET in value
      ? value[SET]
      : undefined;
  return Array.isArray(listed) ? listed : undefined;
}

/** What `target(...)` returns at runtime. */
export interface SelectionValue {
  /** The models named; every model when absent. */
  readonly models?: readonly string[];
  /** The operations named; every operation when absent. */
  readonly operations?: readonly string[];
  /** What watches the writes named, when they were named by a set that brings it. */
  readonly watch?: ExtensionPart;
}

/** Every model, these operations: `target(reads)`. */
export function target<T extends AnyTarget, O extends Operations>(
  operations: OperationSet<O>
): Selection<T, ModelName<T>, O>;
/** One model (or several), these operations (every one when absent). */
export function target<
  T extends AnyTarget,
  const M extends ModelName<T> = ModelName<T>,
  const O extends Operations = Operations,
>(
  models: M | readonly M[],
  operations?: O | readonly O[] | OperationSet<O>
): Selection<T, M, O>;
export function target(first: unknown, operations?: unknown): unknown {
  const named = operationsOf(first);
  // An operation set alone: every model, those operations.
  if (named !== undefined && typeof first === "object" && !Array.isArray(first))
    return Object.freeze({ operations: named, ...watchOf(first) });
  const listed = operationsOf(operations);
  return Object.freeze({
    models: Object.freeze(typeof first === "string" ? [first] : [...named!]),
    ...(listed === undefined ? {} : { operations: Object.freeze([...listed]) }),
    ...watchOf(operations),
  });
}

/** What watches the writes of a set that brings it. */
function watchOf(value: unknown): { readonly watch?: ExtensionPart } {
  const watch =
    typeof value === "object" && value !== null && "watch" in value
      ? value.watch
      : undefined;
  return typeof watch === "object" && watch !== null
    ? { watch: watch as ExtensionPart }
    : {};
}

/** A selection `target(...)` built, read back where a part is written. */
export function selectionOf(
  value: object | undefined
): SelectionValue | undefined {
  if (value === undefined) return undefined;
  const models = "models" in value ? value.models : undefined;
  const operations = "operations" in value ? value.operations : undefined;
  const { watch } = watchOf(value);
  if (
    (models !== undefined && !Array.isArray(models)) ||
    (operations !== undefined && !Array.isArray(operations))
  )
    throw new TypeError("A part's selection is written with target(...)");
  return {
    ...(models === undefined ? {} : { models }),
    ...(operations === undefined ? {} : { operations }),
    ...(watch === undefined ? {} : { watch }),
  };
}
