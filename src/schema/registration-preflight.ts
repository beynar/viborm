import type { Model } from "./model";
import type { SchemaValidationIssue } from "./validation/types";

/**
 * Prove that every model object in one registration batch has one schema key.
 *
 * The model's hydrated name is the lifetime claim. The local map covers the
 * still-unhydrated batch, so `{ alpha: shared, beta: shared }` is refused before
 * hydration writes either name. Repeating the same object under the same key is
 * deliberately idempotent.
 */
export function preflightModelRegistrationIdentity(
  registrations: Iterable<readonly [string, Model<any>]>
): SchemaValidationIssue | undefined {
  const claimedInThisPass = new Map<Model<any>, string>();
  for (const [modelKey, model] of registrations) {
    const claimed = model["~"].names.ts ?? claimedInThisPass.get(model);
    if (claimed !== undefined && claimed !== modelKey) {
      return {
        code: "M003",
        message: `Model registered as '${claimed}' cannot also be registered as '${modelKey}'; one model object binds one schema key`,
        severity: "error",
        model: modelKey,
      };
    }
    claimedInThisPass.set(model, modelKey);
  }
  return undefined;
}
