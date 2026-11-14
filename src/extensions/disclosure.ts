/**
 * `disclosure`: what a failure the core builds may carry beyond its class,
 * code and correlation (the SQL, its parameters, the provider's own text, the
 * line that wrote the call). The part writes the policy on the chain and the
 * core reads `chain.disclosure` where it builds an error, naming no one.
 * Without the part, a failure discloses none of it. A later extension's
 * policy replaces an earlier one's.
 */
import type { DiagnosticDisclosure } from "@errors";
import type { ExtensionPart } from "./chain";

export function disclosurePart(policy: DiagnosticDisclosure): ExtensionPart {
  return {
    join({ next }) {
      next.disclosure = policy;
    },
  };
}
