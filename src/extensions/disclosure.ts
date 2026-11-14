/**
 * `disclosure({ sql?, parameters?, providerDetails?, callsite? })`: what an
 * error thrown by a call of the chain may carry. The core reads the chain's
 * policy where it builds an error, naming no extension; without this part,
 * an error discloses what it does by default.
 */
import type { DiagnosticDisclosure } from "@errors";
import type { ExtensionPart } from "./chain";
import type { AnyTarget, EmptyFacts, Part } from "./contract";
import { builtPart } from "./extension";

/** What one disclosure part allows, as an error reads it. */
export interface DisclosurePolicy {
  readonly sql?: boolean;
  readonly parameters?: boolean;
  readonly providerDetails?: boolean;
  readonly callsite?: boolean;
}

const disclosurePart: ExtensionPart = {
  // Only `disclosure()` brings this part, and it writes the policy.
  join({ next, definition }) {
    next.disclosure = definition.disclosure;
  },
};

/** What an error thrown by a call of the chain may carry. */
export function disclosure<T extends AnyTarget>(
  policy: DisclosurePolicy
): Part<T, EmptyFacts>;
export function disclosure(policy: DisclosurePolicy): unknown {
  const disclosed: DiagnosticDisclosure = Object.freeze({
    includeSql: policy.sql === true,
    includeParams: policy.parameters === true,
    includeProviderDetails: policy.providerDetails === true,
    includeCallsite: policy.callsite === true,
  });
  return builtPart([disclosurePart], (draft) => {
    draft.disclosure = disclosed;
  });
}
