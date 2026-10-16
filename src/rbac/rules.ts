// The schema-independent predicate language of viborm/rbac. Applications
// name their own fields, actor paths and authorization conventions.

/** A `where` over a model's relations and the actor's facts, held as data. */
export type Where = { readonly [key: string]: unknown };
/** A `where`, or one per action and model (R1). */
export type Rule = Where | ((action: string, model: PolicyModel) => Rule);

/** What a rule function reads of the model it is evaluated at. */
export interface PolicyModel {
  readonly name: string;
  /** Its actions, in declaration order (none for a model the policy does not list). */
  readonly actions: readonly string[];
  /** The policy's `levels`, lowest first. */
  readonly levels: readonly string[];
  /** Whether it uses the policy's levels rather than an explicit action graph. */
  readonly leveled: boolean;
  /** ↑a: the actions that are `action` (one of `actions`) or imply it. */
  above(action: string): readonly string[];
  /** The model a relation of it reaches. */
  related(relation: string): PolicyModel | undefined;
}

/** A `where` no row satisfies. Internal compiler identity, not a public helper. */
export const FALSE: Where = Object.freeze({ OR: Object.freeze([]) });
