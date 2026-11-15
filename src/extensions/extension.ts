/**
 * `extension(name, ...parts)`: the one way an extension is written. Each part
 * is built by a function imported from `viborm` (`call`, `unit`, `rule`,
 * `defaults`, `args`, `methods`, `fields`, `disclosure`) and is the
 * `ExtensionPart` that joins the chain with its own state, so a program
 * holds the code of the parts it builds and nothing else. The value is
 * applied by `client.$extends(value)`.
 */

import type { Schema } from "@client/types";
import type { SchemaRegistryLookup } from "@validation/types";
import { isRecord } from "@validation/value-guards";
import { appendParts, type ExtensionPart, extensionError } from "./chain";
import type { ResolvedExtensionChain } from "./chain-state";
import type {
  AnyFacts,
  AnyTarget,
  EmptyFacts,
  Extension,
  MergeAll,
  Part,
  With,
} from "./contract";

/** What `client.$extends` reads of an extension value. */
interface AppliedExtension {
  readonly name: string;
  readonly append: (
    chain: ResolvedExtensionChain | undefined,
    schema: Schema,
    registry?: SchemaRegistryLookup<Schema>
  ) => ResolvedExtensionChain;
}

/**
 * Whether `part` is one a builder made: a phase to run. Neither a builder
 * passed uncalled (`call` for `call(fn)`) nor an object of the old contract
 * (`{ query }`) is.
 */
const isPart = (part: unknown): part is ExtensionPart =>
  isRecord(part) &&
  (typeof part.declare === "function" ||
    typeof part.join === "function" ||
    typeof part.seal === "function");

/**
 * An extension: a non-empty name and its parts, in order. At most eight: a
 * limit of the types (each part is typed against those before it), which
 * the runtime does not repeat.
 */
export function extension<
  T extends AnyTarget,
  F1 extends AnyFacts = EmptyFacts,
  F2 extends AnyFacts = EmptyFacts,
  F3 extends AnyFacts = EmptyFacts,
  F4 extends AnyFacts = EmptyFacts,
  F5 extends AnyFacts = EmptyFacts,
  F6 extends AnyFacts = EmptyFacts,
  F7 extends AnyFacts = EmptyFacts,
  F8 extends AnyFacts = EmptyFacts,
>(
  name: string,
  p1?: Part<T, F1>,
  p2?: Part<With<T, F1>, F2>,
  p3?: Part<With<With<T, F1>, F2>, F3>,
  p4?: Part<With<With<With<T, F1>, F2>, F3>, F4>,
  p5?: Part<With<With<With<With<T, F1>, F2>, F3>, F4>, F5>,
  p6?: Part<With<With<With<With<With<T, F1>, F2>, F3>, F4>, F5>, F6>,
  p7?: Part<With<With<With<With<With<With<T, F1>, F2>, F3>, F4>, F5>, F6>, F7>,
  p8?: Part<
    With<With<With<With<With<With<With<T, F1>, F2>, F3>, F4>, F5>, F6>, F7>,
    F8
  >
): Extension<T, MergeAll<F1, F2, F3, F4, F5, F6, F7, F8>>;
export function extension(name: string, ...parts: unknown[]): unknown {
  if (typeof name !== "string" || name.trim().length === 0)
    extensionError("An extension's name must be a non-empty string.");
  if (!parts.every(isPart))
    extensionError(
      `Extension "${name}" takes parts built by viborm's part builders.`,
      name
    );
  const made = new WeakMap();
  const applied: AppliedExtension = {
    name,
    append: (chain, schema, registry) =>
      appendParts(parts, chain, name, schema, made, registry),
  };
  return Object.freeze(applied);
}

/** Whether `value` is an extension value `$extends` can apply. */
export const isAppliedExtension = (value: unknown): value is AppliedExtension =>
  typeof value === "object" &&
  value !== null &&
  "append" in value &&
  typeof value.append === "function";
