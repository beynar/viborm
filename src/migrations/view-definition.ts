/**
 * The definition of one declared view, for the snapshot the serializer
 * writes: its body compiled from the declared query, its identity, and what
 * it reads.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import type { AnyModel } from "../schema/model";
import type { ResolvedRelationIndex } from "../schema/validation/relation-resolution";
import type { MigrationDriver } from "./drivers/base";

export interface ViewDefinition {
  /** Parameter-free SELECT in the driver's dialect: the view's body, without the wrapper and marker. */
  readonly sql: string;
  /** The view's identity: 40 lowercase hex characters (plan §3.2). */
  readonly hash: string;
  /** Physical names of the tables and views the body reads, sorted, each once. */
  readonly dependsOn: readonly string[];
}

/** What the serializer holds when it asks for a view's definition. */
export interface ViewDefinitionContext {
  /** The schema's models and views, by key, hydrated. */
  readonly models: Readonly<Record<string, AnyModel>>;
  /** The resolved relation index the snapshot is serialized over. */
  readonly relations: ResolvedRelationIndex;
  /** The migration driver the snapshot is for (its dialect, target and namespace). */
  readonly migrationDriver: MigrationDriver;
}

export function viewDefinition(
  view: AnyModel,
  _context: ViewDefinitionContext
): ViewDefinition {
  throw new MigrationError(
    `The view "${view["~"].names.ts ?? view["~"].names.sql}" cannot be migrated yet: the compiler of view definitions is not wired.`,
    VibORMErrorCode.FEATURE_NOT_SUPPORTED,
    { meta: { feature: "view" } }
  );
}
