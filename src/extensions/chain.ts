/**
 * The one mechanism that hosts extensions. A chain is the ordered list of the
 * extensions applied to a client, with what the parts each was built from
 * wrote on it. The chain knows no member: an extension value carries its
 * parts (`extension.ts`), each part reads what its builder wrote and writes
 * its own state, and a program that builds no part of a kind holds no code
 * of that kind.
 */
import type { Schema } from "@client/types";
import type { SchemaRegistryLookup } from "@validation/types";
import type { ResolvedExtensionChain } from "./chain-state";
import { extensionError, type RuntimeExtensionDefinition } from "./definition";

export type * from "./chain-state";

type Draft = {
  -readonly [K in keyof ResolvedExtensionChain]: ResolvedExtensionChain[K];
};

/** One application of one definition: what a part reads and writes. */
export interface Application {
  /** The definition as its parts wrote it: what an `admit` recognizes. */
  readonly declared: RuntimeExtensionDefinition;
  /** The definition as the parts read it: a part's `admit` may replace it. */
  definition: RuntimeExtensionDefinition;
  /** The chain the definition is applied to. */
  readonly chain: ResolvedExtensionChain | undefined;
  /** The chain being built: each part writes its own state on it. */
  readonly next: Draft;
  /** Who owns the handlers appended: the extension and its own controls. */
  owner: { readonly name: string; readonly controls?: readonly string[] };
  readonly schema: Schema;
  readonly registry?: SchemaRegistryLookup<Schema>;
}

/**
 * One part an extension is built from. Its phases run for every part of the
 * definition before the next phase starts, so a part never depends on the
 * order the parts were named in.
 */
export interface ExtensionPart {
  /** The members of a definition this part reads: said for the reader only. */
  readonly members?: readonly string[];
  /** The parts this one needs beside it, brought with it. */
  readonly uses?: readonly ExtensionPart[];
  /**
   * Run again at every later application to the chain, whatever the later
   * definition was built with: what must follow the chain, not a definition.
   */
  readonly carry?: boolean;
  /** Refuse the definition, or replace it, before its name is checked. */
  readonly admit?: (application: Application) => void;
  /** Write what the other parts of the same definition read. */
  readonly declare?: (application: Application) => void;
  readonly join?: (application: Application) => void;
  /** Once every part has joined. */
  readonly seal?: (application: Application) => void;
}

/** The parts an extension was built with, and what applies it to a chain. */
export interface PartSet {
  readonly parts: readonly ExtensionPart[];
  readonly append: (
    chain: ResolvedExtensionChain | undefined,
    definition: RuntimeExtensionDefinition,
    schema: Schema,
    registry?: SchemaRegistryLookup<Schema>
  ) => ResolvedExtensionChain;
}

/** The parts named, with the ones they use, each once. */
export function partSet(parts: readonly ExtensionPart[]): PartSet {
  const all = new Set<ExtensionPart>();
  const add = (part: ExtensionPart): void => {
    if (all.has(part)) return;
    all.add(part);
    for (const used of part.uses ?? []) add(used);
  };
  for (const part of parts) add(part);
  const set: PartSet = Object.freeze({
    parts: Object.freeze([...all]),
    append: (chain, definition, schema, registry) =>
      appendWith(set, chain, definition, schema, registry),
  });
  return set;
}

function appendWith(
  set: PartSet,
  chain: ResolvedExtensionChain | undefined,
  definition: RuntimeExtensionDefinition,
  schema: Schema,
  registry: SchemaRegistryLookup<Schema> | undefined
): ResolvedExtensionChain {
  const parts = chain?.carried
    ? [...new Set([...chain.carried, ...set.parts])]
    : set.parts;
  const { name } = definition;
  const next: Draft = { ...chain, extensions: chain?.extensions ?? [] };
  const application: Application = {
    declared: definition,
    definition,
    chain,
    next,
    owner: { name },
    schema,
    registry,
  };
  for (const part of parts) part.admit?.(application);
  if (chain?.extensions.some((extension) => extension.name === name)) {
    extensionError(
      `Extension "${name}" is already present on this client.${definition.duplicate ?? ""}`,
      name
    );
  }
  next.extensions = Object.freeze([
    ...next.extensions,
    Object.freeze({ name }),
  ]);
  const carried = parts.filter((part) => part.carry === true);
  if (carried.length > 0) next.carried = Object.freeze(carried);
  for (const part of parts) part.declare?.(application);
  for (const part of parts) part.join?.(application);
  for (const part of parts) part.seal?.(application);
  return Object.freeze(next);
}
