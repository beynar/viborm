/**
 * The one mechanism that hosts extensions. A chain is the ordered list of the
 * extensions applied to a client, with what the parts each was built from
 * wrote on it. The chain knows no member and no part: an extension value is
 * its name and its parts (`extension.ts`), each part carries its own state
 * and writes it on the chain, and a program that builds no part of a kind
 * holds no code of that kind.
 */
import type { Schema } from "@client/types";
import { ClientInitializationError } from "@errors";
import type { SchemaRegistryLookup } from "@validation/types";
import type { ResolvedExtensionChain } from "./chain-state";

export type * from "./chain-state";

type Draft = {
  -readonly [K in keyof ResolvedExtensionChain]: ResolvedExtensionChain[K];
};

/**
 * One application of one extension: what its parts read and write. Two
 * parts of one extension meet here and only here: what one writes in
 * `declare` the others read in `join` (the extension's own arguments, on
 * `next` and `owner`; one rule layer for its `rule` parts, in `shared`).
 */
export interface Application {
  /** The extension's name. */
  readonly name: string;
  /** The chain the extension is applied to. */
  readonly chain: ResolvedExtensionChain | undefined;
  /** The chain being built: each part writes its own state on it. */
  readonly next: Draft;
  /** Who owns the handlers appended: the extension and its own arguments. */
  owner: { readonly name: string; readonly args?: readonly string[] };
  readonly schema: Schema;
  readonly registry?: SchemaRegistryLookup<Schema>;
  /**
   * Run `part` with the others, once: what a word written in a part needs
   * beside it (`keep` the kept rows, `omitted` the omission). Its phases
   * from the current one on run.
   */
  readonly bring: (part: ExtensionPart) => void;
  /** What the extension's parts made, per schema (`shared`). */
  readonly made: WeakMap<Schema, Made>;
}

/** What one extension's parts made of one schema, as its models were then. */
interface Made {
  readonly models: Schema;
  readonly values: Map<object, unknown>;
}

/**
 * One part an extension is built from, with its own state. Its phases run
 * for every part of the extension before the next phase starts, so a part
 * never depends on the order the parts were named in.
 */
export interface ExtensionPart {
  /** Write what the other parts of the same extension read. */
  readonly declare?: (application: Application) => void;
  readonly join?: (application: Application) => void;
  /** Once every part has joined. */
  readonly seal?: (application: Application) => void;
}

const PHASES = ["declare", "join", "seal"] as const;

export function extensionError(message: string, extension?: string): never {
  throw new ClientInitializationError(message, {
    meta: extension ? { extension } : undefined,
  });
}

/**
 * `chain` with one extension appended by the parts named, by the parts they
 * use and by those their words bring, each once.
 */
export function appendParts(
  named: readonly ExtensionPart[],
  chain: ResolvedExtensionChain | undefined,
  name: string,
  schema: Schema,
  made: WeakMap<Schema, Made>,
  registry?: SchemaRegistryLookup<Schema>
): ResolvedExtensionChain {
  if (chain?.extensions.some((extension) => extension.name === name))
    extensionError(
      `Extension "${name}" is already present on this client.`,
      name
    );
  // Insertion order: a part brought while a phase runs is reached by it.
  const parts = new Set(named);
  const next: Draft = {
    ...chain,
    extensions: [...(chain?.extensions ?? []), { name }],
  };
  const application: Application = {
    name,
    chain,
    next,
    owner: { name },
    schema,
    registry,
    bring: (part) => {
      parts.add(part);
    },
    made,
  };
  for (const phase of PHASES)
    for (const part of parts) part[phase]?.(application);
  return next;
}

/**
 * What the extension's parts make of this schema, by the key each part
 * chose, made once per schema: every client of a schema applies the same
 * values, so what is admitted once stays admitted. A schema object that
 * gained or swapped a model since is another schema.
 */
export function shared<T>(
  { made, schema }: Application,
  key: object,
  make: () => T
): T {
  let known = made.get(schema);
  const names = Object.keys(schema);
  if (
    known === undefined ||
    names.length !== Object.keys(known.models).length ||
    names.some((name) => known!.models[name] !== schema[name])
  ) {
    known = { models: { ...schema }, values: new Map() };
    made.set(schema, known);
  }
  const { values } = known;
  if (!values.has(key)) values.set(key, make());
  // What `make` returned for this key, by the key's owner's contract.
  return values.get(key) as T;
}
