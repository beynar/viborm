/**
 * What one extension is applied with: the members its parts write, one per
 * host part, as the host parts read them. Written by the builders of
 * `extension.ts` and its parts, never by an author: an extension is written
 * with `extension(name, ...parts)`.
 */
import type { ClientOmitConfig } from "@client/omit";
import type { Schema } from "@client/types";
import { ClientInitializationError, type DiagnosticDisclosure } from "@errors";
import { errorCause } from "../errors/diagnostic-safety";
import type { AdmittedRows } from "./admission";
import type { CallEntry } from "./call";
import type {
  ControlsContribution,
  DataContribution,
  DeletionContribution,
  OrderContribution,
} from "./controls";
import type {
  RuntimeClientMethodContribution,
  RuntimeModelMethodContribution,
} from "./methods";
import type { OfficialObservationCapability } from "./official-facts";
import type { RuntimeQueryContribution } from "./query";
import type { RuntimeResultContribution } from "./result";

type RuntimeExtensionFunction = (...args: never[]) => unknown;

export interface RuntimeExtensionDefinition {
  readonly name: string;
  /** Each `call` and `around` part, in the order the extension names them. */
  readonly calls?: readonly CallEntry[];
  readonly query?: RuntimeQueryContribution;
  readonly statement?: RuntimeExtensionFunction;
  readonly observe?: RuntimeExtensionFunction;
  /** What `observe` is handed facts for. */
  readonly observes?: OfficialObservationCapability;
  readonly written?: RuntimeExtensionFunction;
  readonly retry?: RuntimeExtensionFunction;
  readonly route?: RuntimeExtensionFunction;
  readonly transaction?: RuntimeExtensionFunction;
  readonly client?: RuntimeClientMethodContribution;
  readonly model?: RuntimeModelMethodContribution;
  readonly controls?: ControlsContribution;
  /** As admitted against the schema the extension is applied to. */
  readonly rows?: AdmittedRows;
  readonly deletion?: DeletionContribution;
  readonly data?: DataContribution;
  readonly order?: OrderContribution;
  readonly result?: RuntimeResultContribution;
  /** The fields `defaults` leaves out of every result by default. */
  readonly omit?: ClientOmitConfig<Schema>;
  /** What an error of a call may carry (`disclosure`). */
  readonly disclosure?: DiagnosticDisclosure;
  /**
   * What the refusal of a second application of this extension adds: how
   * one application, or another extension, does what the author wanted.
   */
  readonly duplicate?: string;
}

export type ControlLiteral = string | number | boolean;

export function extensionError(message: string, extension?: string): never {
  throw new ClientInitializationError(message, {
    meta: extension ? { extension } : undefined,
  });
}

/** A record's own keys, for what reads a member the rows host admits. */
export function readOwnKeys(
  value: Record<string, unknown>,
  extension?: string
): PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch (cause) {
    throw new ClientInitializationError(
      extension
        ? `Extension "${extension}" members could not be inspected.`
        : "Client extension members could not be inspected.",
      { cause: errorCause(cause), meta: extension ? { extension } : undefined }
    );
  }
}

/** One member of a record, for what reads a member the rows host admits. */
export function readOwn(
  value: Record<string, unknown>,
  key: string,
  extension?: string
): unknown {
  try {
    return value[key];
  } catch (cause) {
    throw new ClientInitializationError(
      extension
        ? `Extension "${extension}" member "${key}" could not be read.`
        : `Client extension member "${key}" could not be read.`,
      { cause: errorCause(cause), meta: extension ? { extension } : undefined }
    );
  }
}
