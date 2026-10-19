// The actor contract of viborm/permissions (plan §4.2 K2(e)): who calls is a
// `viborm/validation` object schema, and every path a policy reads of it is one
// of its entries. The schema is walked once, at `permissions()`, into the finite tree
// of its paths; a path the tree does not hold is refused where the policy is
// compiled, so a misspelt guard can never fold false at every call.

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ClientInitializationError } from "../errors";
import { errorCause } from "../errors/diagnostic-safety";
import { type VibSchema, v } from "../validation";

/** The paths below one actor value: named keys, or any key of a record. */
interface Paths {
  readonly keys?: ReadonlyMap<string, Paths>;
  readonly any?: Paths;
  readonly item?: Paths;
  readonly optional: boolean;
  readonly nullable: boolean;
  readonly uncertain: boolean;
}

/** The members of a validation schema the walk reads. */
interface Walked {
  readonly type?: string;
  readonly entries?: Readonly<Record<string, unknown>>;
  readonly options?: NonNullable<Parameters<typeof v.object>[1]> & {
    readonly schema?: unknown;
  };
  readonly acceptsUndefined?: boolean;
  readonly wrapped?: unknown;
  readonly value?: unknown;
  readonly item?: unknown;
}

/** Schemas a path passes through without naming a key. */
const WRAPPERS = new Set(["optional", "nullable", "lazyRef"]);

export function refuse(
  message: string,
  model?: string,
  cause?: unknown
): never {
  throw new ClientInitializationError(`viborm/permissions: ${message}`, {
    meta: { extension: "viborm.permissions", ...(model && { model }) },
    ...(cause !== undefined && { cause: errorCause(cause) }),
  });
}

/** Nullability follows the structural schema; no validator is executed here. */
function mayBeNull(input: unknown, synthetic: WeakSet<object>): boolean {
  const { type, options, value, wrapped } = input as Walked;
  if (
    type === "nullable" ||
    options?.nullable === true ||
    (type === "json" && options?.array !== true)
  )
    return true;
  if (
    options?.schema !== undefined ||
    (options?.transform !== undefined && !synthetic.has(input as object))
  )
    return true;
  if (type === "literal") return value === null;
  if (type === "union" && Array.isArray(options))
    return options.some((member) => mayBeNull(member, synthetic));
  if (type === "optional" || type === "lazyRef")
    return mayBeNull(wrapped, synthetic);
  return type === "transform" || type === "pipe";
}

/** bindingSchema already resolved thunks and refused cycles. */
function walk(input: unknown, at: string, synthetic: WeakSet<object>): Paths {
  let schema = input;
  let optional = false;
  let nullable = false;
  let uncertain = false;
  for (;;) {
    const { type, wrapped, options, acceptsUndefined } = schema as Walked;
    optional ||= acceptsUndefined === true || options?.optional === true;
    nullable ||= mayBeNull(schema, synthetic);
    uncertain ||=
      (options?.transform !== undefined && !synthetic.has(schema as object)) ||
      options?.schema !== undefined ||
      type === "transform" ||
      type === "pipe";
    if (type === undefined || !WRAPPERS.has(type)) break;
    schema = wrapped;
  }
  const { type, entries, options, value, item } = schema as Walked;
  if (type !== "object" && type !== "record" && type !== "array")
    return { optional, nullable, uncertain };
  let paths: Paths;
  if (type === "array")
    paths = {
      optional,
      nullable,
      uncertain,
      item: walk(item, `${at}[]`, synthetic),
    };
  else if (type === "record")
    paths = {
      optional,
      nullable,
      uncertain,
      any: walk(value, `${at}.*`, synthetic),
    };
  else {
    if (options?.strict === false)
      refuse(
        `the actor schema admits unknown keys at "${at}": a path it does not declare would be read`
      );
    paths = {
      optional,
      nullable,
      uncertain,
      keys: new Map(
        Object.entries(entries!)
          .filter(([key]) => !options?.omit?.includes(key))
          .map(([key, entry]) => [
            key,
            walk(entry, at === "actor" ? key : `${at}.${key}`, synthetic),
          ])
      ),
    };
  }
  return options?.array
    ? { optional, nullable, uncertain, item: paths }
    : paths;
}

/** One actor declaration's path vocabulary and binding boundary. */
export interface ActorContract {
  readonly hasPath: (path: string) => boolean;
  readonly availabilityPath: (path: string | undefined) => string | undefined;
  readonly schema: StandardSchemaV1;
}

/** Normalize structural actor objects once; native validation owns parsing. */
function bindingSchema(
  input: unknown,
  memo = new WeakMap<object, VibSchema>(),
  open = new Set<object>(),
  at = "actor",
  synthetic = new WeakSet<object>()
): VibSchema {
  const schema = (typeof input === "function" ? input() : input) as VibSchema &
    Walked & {
      readonly key?: VibSchema<string, string>;
      readonly default?: unknown;
      readonly schema?: unknown;
      readonly actions?: readonly {
        readonly type: "transform";
        readonly transform: (value: unknown) => unknown;
      }[];
    };
  const held = memo.get(schema);
  if (held !== undefined) return held;
  if (open.has(schema))
    refuse(
      `the actor schema is recursive at "${at}": its paths are not finite`
    );
  open.add(schema);
  const child = (value: unknown, path = at) =>
    bindingSchema(value, memo, open, path, synthetic);
  let result: VibSchema = schema;
  if (schema.type === "object") {
    const { transform, refuse: refusal, ...options } = schema.options ?? {};
    const sparse = options.partial !== false && options.atLeast === undefined;
    // Native required-object parsing is dense. Keep the original sparse
    // shape at the user callbacks and output boundary: absent optionals must
    // not become undefined-valued properties (including in cache identities).
    const prune = (value: unknown): Record<string, unknown> => {
      // The native parser owns this fresh object; preserve its identity for
      // refuse, transform and the result, without touching caller input.
      const parsed = value as Record<string, unknown>;
      for (const key of Object.keys(parsed))
        if (parsed[key] === undefined) delete parsed[key];
      return parsed;
    };
    result = v.object(
      Object.fromEntries(
        Object.entries(schema.entries!).map(([key, value]) => [
          key,
          child(value, at === "actor" ? key : `${at}.${key}`),
        ])
      ),
      {
        ...options,
        partial: false,
        refuse: sparse && refusal ? (value) => refusal(prune(value)) : refusal,
        transform: sparse
          ? (value) => {
              // Refuse already saw the pruned object. Its mutations survive,
              // even if it deliberately introduced an undefined property.
              const parsed = refusal ? value : prune(value);
              return transform ? transform(parsed) : parsed;
            }
          : transform,
      }
    );
    if (sparse && transform === undefined) synthetic.add(result);
  } else if (schema.type === "optional")
    result = v.optional(child(schema.wrapped), schema.default);
  else if (schema.type === "nullable")
    result = v.nullable(child(schema.wrapped));
  else if (schema.type === "lazyRef") result = child(schema.wrapped);
  else if (schema.type === "array") result = v.array(child(schema.item));
  else if (schema.type === "record")
    result = v.record(schema.key!, child(schema.value));
  else if (schema.type === "union" && Array.isArray(schema.options))
    result = v.union(schema.options.map((member) => child(member)));
  else if (schema.type === "pipe")
    result = v.pipe(child(schema.schema), ...schema.actions!);
  // These wrappers delegate undefined correctly, but their ordinary object
  // metadata does not publish it. Actor objects require this fact before
  // choosing whether to run a member's validator on a missing key.
  const acceptsUndefined = (value: VibSchema): boolean => {
    const shape = value as VibSchema & {
      acceptsUndefined?: boolean;
      value?: unknown;
    };
    return (
      shape.acceptsUndefined === true ||
      (shape.type === "literal" && shape.value === undefined)
    );
  };
  if (
    result !== schema &&
    ((schema.type === "union" &&
      Array.isArray(schema.options) &&
      schema.options.some((member) => acceptsUndefined(child(member)))) ||
      (schema.type === "pipe" && acceptsUndefined(child(schema.schema))) ||
      (schema.type === "nullable" && acceptsUndefined(child(schema.wrapped))))
  )
    Object.defineProperty(result, "acceptsUndefined", { value: true });
  open.delete(schema);
  memo.set(schema, result);
  return result;
}

/**
 * The one actor contract supplies both the finite policy path vocabulary and
 * the schema used at binding. Actor objects require their non-optional fields;
 * normalizing structural schemas leaves union selection, defaults, transforms
 * and array/record traversal with their existing native validators.
 */
export function actorContract(schema: unknown): ActorContract {
  if ((schema as Walked | undefined)?.type !== "object")
    refuse("the actor must be a viborm/validation object schema (v.object)");
  const synthetic = new WeakSet<object>();
  const normalized = bindingSchema(
    schema,
    new WeakMap(),
    new Set(),
    "actor",
    synthetic
  );
  const root = walk(normalized, "actor", synthetic);
  return {
    hasPath(path) {
      let at: Paths | undefined = root;
      for (const key of path.split(".")) {
        at = at.keys?.get(key) ?? at.any;
        if (at === undefined) return false;
      }
      return true;
    },
    availabilityPath(path) {
      let at: Paths | undefined = root;
      let uncertain: string | undefined;
      const keys = path === undefined ? [] : path.split(".");
      for (let index = 0; index < keys.length; index++) {
        if (at.uncertain) return path;
        if (at.any !== undefined) return path; // A record need not contain a key.
        at = at.keys?.get(keys[index]!);
        if (at === undefined) return path;
        if (at.optional || at.nullable || at.uncertain)
          uncertain = keys.slice(0, index + 1).join(".");
      }
      return uncertain;
    },
    schema: normalized,
  };
}

/** Whether `T` is one of `Seen`, both ways: a structural subtype is not the same object. */
type IsSeen<T, Seen> = true extends (
  Seen extends unknown
    ? [T] extends [Seen]
      ? [Seen] extends [T]
        ? true
        : false
      : false
    : never
)
  ? true
  : false;

/**
 * Every dotted path of an actor value: a key, or a key and a path below it; a
 * record's keys are any string. The object types already walked stop the walk,
 * so a recursive type ends without a depth number (plan §11.2 F8).
 */
export type ActorPaths<T, Seen = never> = T extends readonly unknown[]
  ? never
  : T extends object
    ? IsSeen<T, Seen> extends true
      ? never
      : string extends keyof T
        ? string
        : {
            [K in keyof T & string]-?:
              | K
              | `${K}.${ActorPaths<NonNullable<T[K]>, Seen | T>}`;
          }[keyof T & string]
    : never;

/**
 * The actor a binding takes: what its schema parses to, read only, where an
 * entry whose value may be `undefined` may also be left out (an optional
 * entry's output keeps its key; `v.object`'s input type makes every key
 * optional).
 */
export type ActorFacts<T> = T extends readonly (infer Item)[]
  ? readonly ActorFacts<Item>[]
  : T extends Date | ((...args: never[]) => unknown)
    ? T
    : T extends object
      ? {
          readonly [K in keyof T as undefined extends T[K]
            ? never
            : K]: ActorFacts<T[K]>;
        } & {
          readonly [K in keyof T as undefined extends T[K]
            ? K
            : never]?: ActorFacts<T[K]>;
        }
      : T;
