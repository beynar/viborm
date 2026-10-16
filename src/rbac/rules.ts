// The schema-independent predicate language of viborm/rbac. Applications
// name their own fields, actor paths and authorization conventions.

/** A `where` over a model's relations and the actor's facts, held as data. */
export type Where = { readonly [key: string]: unknown };
/** A `where`, or a function of the requested action and model, even when inherited. */
export type Rule = Where | ((action: string, model: PolicyModel) => Rule);

/** What a rule function reads of the model it is evaluated at. */
export interface PolicyModel {
  readonly name: string;
  /** Its actions, in declaration order (none for a model the policy does not list). */
  readonly actions: readonly string[];
}

/** A `where` no row satisfies. Internal compiler identity, not a public helper. */
export const FALSE: Where = Object.freeze({ OR: Object.freeze([]) });
