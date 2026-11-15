/**
 * What a resolved chain holds: the names of its extensions, and what each
 * part an extension was built from wrote on it. A part's state carries the
 * code that runs it (`chain.watch`, `chain.args`), so the
 * client asks the chain and imports nothing that runs extensions.
 */

import type { ChainOmit } from "@client/default-omit-chain";
import type { DiagnosticDisclosure } from "@errors";
import type {
  CallRows,
  ModelStamps,
} from "@query-engine/raptor3/shared/row-scope";
import type { Input } from "@query-engine/raptor3/shared/schema";
import type { Operation } from "@query-engine/types";
import type { AdmittedLayer } from "./admission";
import type { AdmittedArgs, ArgAdmission, ResolvedArg } from "./arguments";
import type { Coordination } from "./coordination";
import type { Kept } from "./kept";
import type { ExtensionMethodsState } from "./methods";
import type { Observation } from "./observation";
import type { AroundRunner, collect } from "./query";
import type { ResultFields } from "./result";
import type { Stamps } from "./stamps";
import type { CallHandlers, TargetedHandlers } from "./targeted";
import type { Watching } from "./written";

interface OwnedHandler<Handler extends CallableFunction = CallableFunction> {
  readonly extension: string;
  readonly handler: Handler;
}

/**
 * A `call` or `around` handler. The arguments its extension declares travel
 * with it: the only ones its context's `values` shows.
 */
export interface CallHandler<
  Handler extends CallableFunction = CallableFunction,
> extends OwnedHandler<Handler> {
  readonly args?: readonly string[];
}

export interface ResolvedExtension {
  readonly name: string;
}

/** A chain's arguments, the list one (model, operation) accepts, and what admits them. */
export interface ResolvedArgs {
  /** Every argument name on the chain: one name space. */
  readonly names: ReadonlySet<string>;
  /** Every argument on the chain, in application order: the lists' one source. */
  readonly all: readonly ResolvedArg[];
  /**
   * The arguments placed on one model's operation, in application order. Each
   * list is built the first time it is asked for and kept for the chain: a
   * client created per request asks for the one its call needs, never for
   * every operation of every model.
   */
  readonly placed: (model: string, operation: string) => readonly ResolvedArg[];
  /**
   * One call's arguments taken out of its arguments and admitted, against
   * the arguments placed on `placement` (the operation the caller named);
   * `undefined` when none is placed there.
   */
  readonly admit: (
    model: string,
    placement: string,
    operation: Operation,
    args: Record<string, unknown>,
    bound: AdmittedArgs | undefined
  ) => ArgAdmission | undefined;
  /**
   * One extension's own admitted arguments, as its handlers see them: on the
   * chain's arguments, so a part that reads them carries this only where an
   * extension declares some.
   */
  readonly owned: (
    admitted: AdmittedArgs | undefined,
    names: readonly string[]
  ) => AdmittedArgs;
  /**
   * A view's `$bind`: one extension's own arguments, bound over `previous`.
   * Absent on a chain that declares no `bound` argument.
   */
  readonly bind?: (
    extension: string,
    values: Readonly<Record<string, unknown>>,
    previous: AdmittedArgs | undefined
  ) => AdmittedArgs;
}

/**
 * One call's row facts, from the arguments it admitted: what the client asks
 * the chain, and what the parts that read rows, kept rows, data and order
 * bind (`rows.ts`, `plain-domain.ts`).
 */
export interface CallRowsBinding {
  call(model: string, values: AdmittedArgs | undefined): CallRows;
}

/**
 * Absent on an unextended client. Each member is written by the part that
 * reads it, and absent where no extension of the chain was built with that
 * part.
 */
export interface ResolvedExtensionChain {
  readonly extensions: readonly ResolvedExtension[];
  /**
   * How a call whose execution an extension wraps is run, and how an array
   * transaction admits its members: present on a chain with an `around`, a
   * part that watches writes or a `unit` part.
   */
  readonly coordination?: Coordination;
  /**
   * Where a part hears writes (a watch, a `unit` part): the collector each
   * transaction scope installs from its start (`transact`).
   */
  readonly collect?: typeof collect;
  readonly args?: ResolvedArgs;
  /**
   * Every extension's rule layer, as admitted: also a cached read's key, so
   * two chains whose rules differ never share an entry and two that declare
   * the same always do.
   */
  readonly rules?: readonly AdmittedLayer[];
  /** Per managed model, what its deletes write instead: a later entry replaces one. */
  readonly kept?: Kept;
  /** Per model, every extension's `data` fields: a later one wins a field. */
  readonly defaultData?: Readonly<Record<string, ModelStamps>>;
  /** `data` as a call writes it. */
  readonly stamps?: Stamps;
  /**
   * Per model, the order its reads take when the caller gives none: a later
   * extension's entry replaces an earlier one's. Also a cached read's key.
   */
  readonly defaultOrder?: Readonly<Record<string, readonly Input[]>>;
  /**
   * What binds the call facts once a part of the chain filters, keeps or
   * judges rows: they then read what every other part posed. Absent, a chain
   * that only orders and stamps rows binds them plain (`plain-domain.ts`).
   */
  readonly bindRows?: (chain: ResolvedExtensionChain) => CallRowsBinding;
  /**
   * Derived from `rules`, `kept`, `stamps` and `defaultOrder`: what each call's
   * arguments resolve to.
   */
  readonly callRows?: CallRowsBinding;
  readonly call?: CallHandlers;
  /** The second moments of `around` parts, as the runner calls them. */
  readonly around?: TargetedHandlers<AroundRunner>;
  /** The rewriting units, around each logical statement. */
  readonly rewrites?: Observation;
  /**
   * Every handler around a unit of real work, in chain order, and what runs
   * a unit under them: present when the chain holds one. A producer builds a
   * unit only where it is present.
   */
  readonly observation?: Observation;
  /** Every watch, in chain order: what watches a write call. */
  readonly watch?: Watching;
  /** Per model, every extension's computed fields, and what plans a call's. */
  readonly fields?: ResultFields;
  /** Every extension's client and model methods, and what binds a view's. */
  readonly methods?: ExtensionMethodsState;
  /** The fields every extension's `defaults` leaves out of results, per model. */
  readonly omit?: ChainOmit;
  /** What an error of a call may carry, as the last `disclosure` part says. */
  readonly disclosure?: DiagnosticDisclosure;
}
