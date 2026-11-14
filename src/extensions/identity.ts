/**
 * What an official extension recognized by identity checks as it is applied:
 * its name, and that it is applied once. Each official extension brings its
 * own check with its parts; the chain names none of them.
 */
import { extensionError, type RuntimeExtensionDefinition } from "./definition";

export function assertOfficialExtensionAdmission(options: {
  readonly definitionName: string;
  readonly officialName: string;
  readonly label: string;
  readonly hasIdentity: boolean;
  readonly isAlreadyPresent: boolean;
  readonly duplicateMessage: string;
}): void {
  if (options.hasIdentity && options.isAlreadyPresent) {
    extensionError(options.duplicateMessage, options.definitionName);
  }
  if (options.hasIdentity && options.definitionName !== options.officialName) {
    extensionError(
      `The official ${options.label} extension name must be "${options.officialName}".`,
      options.definitionName
    );
  }
  if (!options.hasIdentity && options.definitionName === options.officialName) {
    extensionError(
      `Extension name "${options.officialName}" is reserved for the official ${options.label} extension.`,
      options.definitionName
    );
  }
}

/**
 * An official extension's member that is its identity rather than a handler
 * (the cache's `query`) leaves the definition the other parts read.
 */
export function withoutIdentity(
  definition: RuntimeExtensionDefinition,
  member: "query"
): RuntimeExtensionDefinition {
  const { [member]: _identity, ...ordinaryDefinition } = definition;
  return Object.freeze(ordinaryDefinition);
}
