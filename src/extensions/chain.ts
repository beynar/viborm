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
  readonly definition: RuntimeExtensionDefinition;
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
  /** The parts this one needs beside it, brought with it. */
  readonly uses?: readonly ExtensionPart[];
  /** Write what the other parts of the same definition read. */
  readonly declare?: (application: Application) => void;
  readonly join?: (application: Application) => void;
  /** Once every part has joined. */
  readonly seal?: (application: Application) => void;
}

const PHASES = ["declare", "join", "seal"] as const;

/**
 * `chain` with one definition appended by the parts named, and by the parts
 * they use, each once.
 */
export function appendParts(
  named: readonly ExtensionPart[],
  chain: ResolvedExtensionChain | undefined,
  definition: RuntimeExtensionDefinition,
  schema: Schema,
  registry?: SchemaRegistryLookup<Schema>
): ResolvedExtensionChain {
  const parts = new Set<ExtensionPart>();
  const add = (part: ExtensionPart): void => {
    if (parts.has(part)) return;
    parts.add(part);
    for (const used of part.uses ?? []) add(used);
  };
  for (const part of named) add(part);
  const { name } = definition;
  if (chain?.extensions.some((extension) => extension.name === name))
    extensionError(
      `Extension "${name}" is already present on this client.`,
      name
    );
  const next: Draft = {
    ...chain,
    extensions: Object.freeze([
      ...(chain?.extensions ?? []),
      Object.freeze({ name }),
    ]),
  };
  const application: Application = {
    definition,
    chain,
    next,
    owner: { name },
    schema,
    registry,
  };
  for (const phase of PHASES)
    for (const part of parts) part[phase]?.(application);
  return Object.freeze(next);
}
