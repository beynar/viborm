/**
 * `extension(name, ...parts)`: the one way an extension is written. Each part
 * is built by a function imported from `viborm` (`call`, `unit`, `rule`,
 * `defaults`, `args`, `methods`, `fields`, `disclosure`) and carries the host
 * parts that run it, so a program holds the code of the parts it builds and
 * nothing else. The value is applied by `client.$extends(value)`.
 */

import type { Schema } from "@client/types";
import type { SchemaRegistryLookup } from "@validation/types";
import { isFunction, isRecord } from "@validation/value-guards";
import { type ExtensionPart, partSet } from "./chain";
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
import type { ControlDeclaration } from "./controls";
import { extensionError, type RuntimeExtensionDefinition } from "./definition";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The members one extension is applied with, written by its parts against
 * one schema. `finish` runs once every part wrote: what a part decides from
 * what the others wrote (an argument a rule reads as its mode).
 */
export type DefinitionDraft = Mutable<RuntimeExtensionDefinition> & {
  readonly finish: (() => void)[];
  /** Every argument the extension declares, before it is placed. */
  args?: Record<string, ArgSpec>;
};

/** One argument as `args` read it: the control the controls host places. */
export type ArgSpec = ControlDeclaration;

/**
 * What one built part is: the host parts that run it, and what it writes on
 * the definition its extension is applied with. Until each part carries its
 * own state, it writes the members the host parts read.
 */
export interface PartBuild {
  readonly host: readonly ExtensionPart[];
  readonly write: (draft: DefinitionDraft, schema: Schema) => void;
}

/**
 * One built part: what `call`, `rule` and the others return, typed by its
 * builder and read here by its two fields. Being plain data, a part built by
 * one copy of the package is applied by another.
 */
export function builtPart(
  host: readonly ExtensionPart[],
  write: PartBuild["write"]
): Part<AnyTarget, EmptyFacts>;
export function builtPart(
  host: readonly ExtensionPart[],
  write: PartBuild["write"]
): object {
  const part: PartBuild = { host, write };
  return Object.freeze(part);
}

const isBuilt = (part: unknown): part is PartBuild =>
  isRecord(part) && Array.isArray(part.host) && isFunction(part.write);

/** What `client.$extends` reads of an extension value. */
export interface AppliedExtension {
  readonly name: string;
  readonly append: (
    chain: ResolvedExtensionChain | undefined,
    schema: Schema,
    registry?: SchemaRegistryLookup<Schema>
  ) => ResolvedExtensionChain;
}

/**
 * An extension: a non-empty name and its parts, in order. At most eight: a
 * limit of the types (each part is typed against those before it), which
 * the runtime does not repeat. The definition its
 * parts write is built once per schema, so every client of a schema applies
 * the same values (what the host admits once per schema stays admitted).
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
  const builds = parts.map((part) => {
    if (!isBuilt(part))
      extensionError(
        `Extension "${name}" takes parts built by viborm's part builders.`,
        name
      );
    return part;
  });
  const set = partSet(builds.flatMap((build) => build.host));
  const written = new WeakMap<Schema, RuntimeExtensionDefinition>();
  const definitionFor = (schema: Schema): RuntimeExtensionDefinition => {
    let definition = written.get(schema);
    if (definition === undefined) {
      const draft: DefinitionDraft = { name, finish: [] };
      for (const build of builds) build.write(draft, schema);
      for (const finish of draft.finish) finish();
      const { finish: _done, args: _placed, ...members } = draft;
      definition = members;
      written.set(schema, definition);
    }
    return definition;
  };
  const applied: AppliedExtension = {
    name,
    append: (chain, schema, registry) =>
      set.append(chain, definitionFor(schema), schema, registry),
  };
  return Object.freeze(applied);
}

/** Whether `value` is an extension value `$extends` can apply. */
export const isAppliedExtension = (value: unknown): value is AppliedExtension =>
  typeof value === "object" &&
  value !== null &&
  "append" in value &&
  typeof value.append === "function";
