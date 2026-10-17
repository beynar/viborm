// The actor contract of viborm/permissions (plan §4.2 K2(e)): who calls is a
// `viborm/validation` object schema, and every path a policy reads of it is one
// of its entries. The schema is walked once, at `permissions()`, into the finite tree
// of its paths; a path the tree does not hold is refused where the policy is
// compiled, so a misspelt guard can never fold false at every call.

import { ClientInitializationError } from "../errors";

/** The paths below one actor value: named keys, or any key of a record. */
interface Paths {
  readonly keys?: ReadonlyMap<string, Paths>;
  readonly any?: Paths;
}

/** The members of a validation schema the walk reads. */
interface Walked {
  readonly type?: string;
  readonly entries?: Readonly<Record<string, unknown>>;
  readonly options?: { readonly strict?: boolean };
  readonly wrapped?: unknown;
  readonly value?: unknown;
}

/** Schemas a path passes through without naming a key. */
const WRAPPERS = new Set(["optional", "nullable", "lazyRef"]);

export function refuse(message: string, model?: string): never {
  throw new ClientInitializationError(`viborm/permissions: ${message}`, {
    meta: { extension: "viborm.permissions", ...(model && { model }) },
  });
}

function walk(input: unknown, at: string, open: Set<unknown>): Paths {
  let schema = input;
  for (;;) {
    // An entry may be a thunk, a circular reference's spelling.
    if (typeof schema === "function") schema = schema();
    const { type, wrapped } = schema as Walked;
    if (type === undefined || !WRAPPERS.has(type)) break;
    schema = wrapped;
  }
  const { type, entries, options, value } = schema as Walked;
  if (type !== "object" && type !== "record") return {};
  if (open.has(schema))
    refuse(
      `the actor schema is recursive at "${at}": its paths are not finite`
    );
  open.add(schema);
  let paths: Paths;
  if (type === "record") paths = { any: walk(value, `${at}.*`, open) };
  else {
    if (options?.strict === false)
      refuse(
        `the actor schema admits unknown keys at "${at}": a path it does not declare would be read`
      );
    paths = {
      keys: new Map(
        Object.entries(entries!).map(([key, entry]) => [
          key,
          walk(entry, at === "actor" ? key : `${at}.${key}`, open),
        ])
      ),
    };
  }
  open.delete(schema);
  return paths;
}

/** The actor schema's paths, or the refusal of a schema they cannot be read from. */
export function actorPaths(schema: unknown): (path: string) => boolean {
  if ((schema as Walked | undefined)?.type !== "object")
    refuse("the actor must be a viborm/validation object schema (v.object)");
  const root = walk(schema, "actor", new Set());
  return (path) => {
    let at: Paths | undefined = root;
    for (const key of path.split(".")) {
      at = at.keys?.get(key) ?? at.any;
      if (at === undefined) return false;
    }
    return true;
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
