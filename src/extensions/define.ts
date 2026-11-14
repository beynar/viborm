/**
 * The two ways a definition is built. Building one is what brings the code
 * that admits and runs extensions into a program: the client carries none of
 * it, so an application that applies no extension pays nothing for them.
 */
import type { Schema } from "@client/types";
import {
  type ClientExtension,
  type DefineExtensionBinder,
  type ExactExtensionDefinition,
  type ExtensionConfig,
  type ExtensionDefinitionInput,
  normalizeExtensionDefinition,
  type SchemaGenericExtensionDefinition,
} from "./definition";
import { withHost } from "./host";
import type { EmptyClientExtensionState } from "./methods";
import { withRows } from "./rows-runtime";

/**
 * Build an extension definition: it is checked, and what admits and runs
 * extensions, with what reads `rows`, `data`, `deletion` and `order`
 * declarations, comes into the program.
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
  withHost();
  // What a definition declares of rows is read by what this brings.
  withRows();
  if (definitions.length === 0) {
    return (schemaDefinition: ExtensionDefinitionInput) =>
      normalizeExtensionDefinition(schemaDefinition);
  }
  return normalizeExtensionDefinition(definitions[0]);
}

/**
 * `defineExtension()` for a definition made of handlers and methods only: it
 * does not bring what reads `rows`, `data`, `deletion` and `order`, so an
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
  withHost();
  return normalizeExtensionDefinition(definition);
}
