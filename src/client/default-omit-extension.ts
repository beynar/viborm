import { ClientInitializationError } from "@errors";
import type { ResolvedExtensionChain } from "@extensions/chain";
import { extensionCause } from "@extensions/definition";
import type {
  GenericRequestHandler,
  OfficialGenericRequestHandler,
} from "@extensions/request";
import { isFunction, isRecord } from "@validation/value-guards";
import type { ClientOmitConfig, ExactClientOmitConfig } from "./omit";
import type { Schema } from "./types";

export const OFFICIAL_DEFAULT_OMIT_NAME = "viborm.defaultOmit";

declare const officialDefaultOmitConfig: unique symbol;

/** The authenticated request identity carrying one exact static omit witness. */
export type OfficialDefaultOmitRequestContribution<Config> =
  OfficialGenericRequestHandler & {
    readonly [officialDefaultOmitConfig]: Config;
    bind(thisArg: unknown): GenericRequestHandler;
  };

/** The official value accepted by the dedicated `$extends` admission branch. */
export type OfficialDefaultOmitExtension<Config extends object = object> = {
  readonly name: typeof OFFICIAL_DEFAULT_OMIT_NAME;
  readonly request: OfficialDefaultOmitRequestContribution<Config>;
};

export interface OfficialDefaultOmitCapability {
  readonly config: ClientOmitConfig<Schema>;
}

const capabilitiesByRequest = new WeakMap<
  CallableFunction,
  OfficialDefaultOmitCapability
>();
const capabilitiesByChain = new WeakMap<
  ResolvedExtensionChain,
  OfficialDefaultOmitCapability
>();

function configurationError(message: string, cause?: unknown): never {
  throw new ClientInitializationError(message, {
    cause: cause === undefined ? undefined : extensionCause(cause),
  });
}

function ownKeys(value: object, label: string): PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch (cause) {
    configurationError(
      `Default omit ${label} members could not be inspected.`,
      cause
    );
  }
}

function readOwn(
  value: Record<string, unknown>,
  key: string,
  label: string
): unknown {
  try {
    return value[key];
  } catch (cause) {
    configurationError(
      `Default omit ${label} member "${key}" could not be read.`,
      cause
    );
  }
}

function isConfigurationRecord(
  value: unknown,
  label: string
): value is Record<string, unknown> {
  try {
    return isRecord(value);
  } catch (cause) {
    configurationError(`Default omit ${label} could not be inspected.`, cause);
  }
}

function snapshotConfig(value: unknown): ClientOmitConfig<Schema> {
  if (!isConfigurationRecord(value, "configuration")) {
    configurationError("Default omit configuration must be an object.");
  }
  const snapshot: Record<
    string,
    Readonly<Record<string, true>>
  > = Object.create(null);
  for (const modelKey of ownKeys(value, "configuration")) {
    if (typeof modelKey !== "string") {
      configurationError(
        "Default omit configuration contains a non-string model key."
      );
    }
    const entry = readOwn(value, modelKey, "configuration");
    if (!isConfigurationRecord(entry, `configuration.${modelKey}`)) {
      configurationError(
        `Default omit configuration member "${modelKey}" must be an object.`
      );
    }
    const fields: Record<string, true> = Object.create(null);
    for (const fieldKey of ownKeys(entry, `configuration.${modelKey}`)) {
      if (typeof fieldKey !== "string") {
        configurationError(
          `Default omit configuration member "${modelKey}" contains a non-string field key.`
        );
      }
      if (readOwn(entry, fieldKey, `configuration.${modelKey}`) !== true) {
        configurationError(
          `Default omit configuration member "${modelKey}.${fieldKey}" must be true.`
        );
      }
      fields[fieldKey] = true;
    }
    snapshot[modelKey] = Object.freeze(fields);
  }
  return Object.freeze(snapshot);
}

export type DefaultOmitBinder<S extends Schema> = <
  const Config extends ClientOmitConfig<S>,
>(
  config: Config & NoInfer<ExactClientOmitConfig<Config, S>>
) => OfficialDefaultOmitExtension<Config & object>;

/** Create VibORM's fixed-name schema-bound default-omit extension. */
export function defaultOmit<S extends Schema>(): DefaultOmitBinder<S>;
export function defaultOmit(): unknown {
  return (config: unknown): unknown => {
    const capability = Object.freeze({ config: snapshotConfig(config) });
    const request: GenericRequestHandler = () => ({});
    capabilitiesByRequest.set(request, capability);
    return Object.freeze({
      name: OFFICIAL_DEFAULT_OMIT_NAME,
      request,
    });
  };
}

export function getOfficialDefaultOmitRequestCapability(
  request: unknown
): OfficialDefaultOmitCapability | undefined {
  return isFunction(request) ? capabilitiesByRequest.get(request) : undefined;
}

export function getOfficialDefaultOmitChainCapability(
  chain: ResolvedExtensionChain | undefined
): OfficialDefaultOmitCapability | undefined {
  return chain === undefined ? undefined : capabilitiesByChain.get(chain);
}

export function registerOfficialDefaultOmitChain(
  chain: ResolvedExtensionChain,
  capability: OfficialDefaultOmitCapability
): void {
  capabilitiesByChain.set(chain, capability);
}
