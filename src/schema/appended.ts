/**
 * Marks a field validator whose value, left out of a create, an extension
 * appends (`orderingKey` from viborm/ordering): a schema-only check
 * (`validateOperationPayload`) takes such a field as provided, as the
 * extension's client does, instead of filling and validating its default.
 * A registry symbol, so two copies of the package agree.
 */
export const APPENDED: unique symbol = Symbol.for("viborm.appended");

/** Does `validator` carry {@link APPENDED}? */
export const isAppended = (validator: unknown): boolean =>
  typeof validator === "object" &&
  validator !== null &&
  (validator as { readonly [APPENDED]?: unknown })[APPENDED] === true;
