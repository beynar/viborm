/**
 * The ways a definition is built, until each extension names its parts
 * itself. Building one is what brings the code that admits and runs
 * extensions into a program: the definition carries its parts, and the
 * client carries none of them, so an application that applies no extension
 * pays nothing for them.
 */
import { cacheIdentity } from "@cache/identity";
import { defaultOmitIdentity } from "@client/default-omit-identity";
import type { Schema } from "@client/types";
import { type ExtensionPart, partSet, withParts } from "./chain";
import { controlsPart } from "./controls";
import {
  type ClientExtension,
  type DefineExtensionBinder,
  type ExactExtensionDefinition,
  type ExtensionConfig,
  type ExtensionDefinitionInput,
  normalizeExtensionDefinition,
  type SchemaGenericExtensionDefinition,
} from "./definition";
import { enableParts } from "./host-slot";
import { type EmptyClientExtensionState, methodsPart } from "./methods";
import { observePart } from "./observation";
import { queryPart } from "./query";
import { requestPart } from "./request";
import { resultPart } from "./result";
import { rowsPart } from "./rows-part";
import { statementPart } from "./statement";
import { unitPart } from "./units";
import { writtenPart } from "./written";

/** Every part a definition made of handlers and methods may need. */
const handlerParts = (): readonly ExtensionPart[] => [
  controlsPart,
  requestPart,
  queryPart,
  statementPart,
  observePart,
  writtenPart,
  unitPart,
  resultPart,
  methodsPart,
];

/**
 * Every part, and what recognizes the official extensions a definition
 * written as one object may be a copy of.
 */
const everyPart = (): readonly ExtensionPart[] => [
  cacheIdentity,
  defaultOmitIdentity,
  ...handlerParts(),
  rowsPart,
];

/**
 * Build an extension definition: it is checked, and it carries every part,
 * what reads `rows`, `data`, `deletion` and `order` declarations included.
 */
export function defineExtension<
  const Definition extends SchemaGenericExtensionDefinition,
>(
  definition: Definition &
    ExactExtensionDefinition<
      Definition,
      ExtensionConfig<Schema>,
      EmptyClientExtensionState
    >
): NoInfer<Definition>;
export function defineExtension<S extends Schema>(): DefineExtensionBinder<S>;
export function defineExtension(
  ...definitions: [] | [definition: ClientExtension]
): unknown {
  if (definitions.length === 0) {
    return (schemaDefinition: ExtensionDefinitionInput) =>
      withParts(normalizeExtensionDefinition(schemaDefinition), everyPart());
  }
  return withParts(normalizeExtensionDefinition(definitions[0]), everyPart());
}

/**
 * `defineExtension()` for a definition made of handlers and methods only: it
 * does not carry what reads `rows`, `data`, `deletion` and `order`, so an
 * extension that declares none of them weighs less. A definition that does
 * declare one is refused when it is applied.
 */
export function defineHooks<
  const Definition extends SchemaGenericExtensionDefinition,
>(
  definition: Definition &
    ExactExtensionDefinition<
      Definition,
      ExtensionConfig<Schema>,
      EmptyClientExtensionState
    >
): NoInfer<Definition>;
export function defineHooks(definition: ClientExtension): unknown {
  return withParts(normalizeExtensionDefinition(definition), handlerParts());
}

/**
 * A definition built with exactly `parts`: it carries them, and a program
 * that builds no other holds the code of those parts alone. What the
 * official extensions build with, until the parts are the contract.
 */
export const defineWith =
  (...parts: readonly ExtensionPart[]) =>
  <Definition extends object>(definition: Definition): Definition =>
    withParts(definition, parts);

/**
 * Brings the code that runs extensions into a program that passes object
 * literals to `$extends` and builds no definition with `defineExtension()` or
 * `defineHooks()`. Call it once.
 */
export function enableExtensions(): void {
  enableParts(partSet(everyPart()));
}
