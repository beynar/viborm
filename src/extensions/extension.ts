/**
 * `extension(name, ...parts)`: the one way an extension is written. Each part
 * is built by a function imported from `viborm` (`call`, `unit`, `rule`,
 * `defaults`, `args`, `methods`, `fields`, `disclosure`) and carries the host
 * parts that run it, so a program holds the code of the parts it builds and
 * nothing else. The value is applied by `client.$extends(value)`.
 */

import type { Schema } from "@client/types";
import type { SchemaRegistryLookup } from "@validation/types";
import { type ExtensionPart, partSet } from "./chain";
import type { ResolvedExtensionChain } from "./chain-state";
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

/** What each built part is, by the value its builder returned. */
const built = new WeakMap<object, PartBuild>();

/** One built part, opaque to its author: what `call`, `rule` and the others return. */
export function builtPart(
  host: readonly ExtensionPart[],
  write: PartBuild["write"]
): object {
  const part = Object.freeze({});
  built.set(part, { host, write });
  return part;
}

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
 * An extension: a non-empty name and its parts, in order. The definition its
 * parts write is built once per schema, so every client of a schema applies
 * the same values (what the host admits once per schema stays admitted).
 */
export function extension(name: string, ...parts: unknown[]): unknown {
  if (typeof name !== "string" || name.trim().length === 0)
    extensionError("An extension's name must be a non-empty string.");
  const builds = parts.map((part) => {
    const build =
      typeof part === "object" && part !== null ? built.get(part) : undefined;
    if (build === undefined)
      extensionError(
        `Extension "${name}" takes parts built by viborm's part builders.`,
        name
      );
    return build;
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
