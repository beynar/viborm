/**
 * Default omit as a chain meets it: recognized by its `request`, applied
 * under its own name, and carried by every later chain. Brought by
 * `defaultOmit()` and by what applies definitions written as object literals.
 */
import type { ExtensionPart } from "@extensions/chain";
import {
  assertOfficialExtensionAdmission,
  withoutIdentity,
} from "@extensions/identity";
import {
  getOfficialDefaultOmitChainCapability,
  registerOfficialDefaultOmitChain,
} from "./default-omit-chain";
import {
  getOfficialDefaultOmitRequestCapability,
  OFFICIAL_DEFAULT_OMIT_NAME,
} from "./default-omit-extension";

export const defaultOmitIdentity: ExtensionPart = {
  carry: true,
  admit(application) {
    const { definition } = application;
    const incoming = getOfficialDefaultOmitRequestCapability(
      definition.request
    );
    assertOfficialExtensionAdmission({
      definitionName: definition.name,
      officialName: OFFICIAL_DEFAULT_OMIT_NAME,
      label: "default omit",
      hasIdentity: incoming !== undefined,
      // The generic duplicate-name check owns default-omit duplication after
      // instrumentation admission, preserving hostile hybrid error precedence.
      isAlreadyPresent: false,
      duplicateMessage: `Extension "${OFFICIAL_DEFAULT_OMIT_NAME}" is already present on this client.`,
    });
    if (incoming !== undefined)
      application.definition = withoutIdentity(definition, "request");
  },
  seal({ next, chain, declared }) {
    const official =
      getOfficialDefaultOmitRequestCapability(declared.request) ??
      getOfficialDefaultOmitChainCapability(chain);
    if (official !== undefined)
      registerOfficialDefaultOmitChain(next, official);
  },
};
