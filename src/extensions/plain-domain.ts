/**
 * The call facts of a chain whose parts order and stamp rows but neither
 * filter, keep nor judge any (`order`, `data`): a domain that answers every
 * question as one with no layer does, so neither the prepared domain, its
 * layers, the mode table nor what admits predicates comes with them. Once a
 * part of the chain filters or keeps rows, its own binding reads the order
 * and the stamps too.
 */
import type {
  PreparedSelector,
  Queries,
} from "@query-engine/raptor3/shared/query";
import type {
  CallRows,
  CallScope,
  ModelDomain,
  RowDomain,
} from "@query-engine/raptor3/shared/row-scope";
import { type Input, memo } from "@query-engine/raptor3/shared/schema";
import type { PreparedGuardFailure } from "@query-engine/types";
import type { AnyModel } from "@schema/model";
import type { CallRowsBinding, ResolvedExtensionChain } from "./chain-state";
import type { AdmittedControls } from "./controls";
import type { PreparedDomain } from "./row-domain";
import type { Stamps } from "./stamps";

/**
 * What a write of `operation` says when the row it would leave is refused:
 * `nested`, the verb and the relation it is written through.
 */
export function writeRefusal(
  operation: string,
  nested?: readonly [verb: string, relation: string]
): PreparedGuardFailure {
  return nested
    ? {
        kind: "nestedWrite",
        relation: nested[1],
        message: `Cannot ${nested[0]} relation '${nested[1]}': the record it writes is not permitted.`,
        raceable: false,
      }
    : {
        kind: "forbidden",
        message: `${operation} produced a row that is not permitted.`,
        raceable: false,
      };
}

/**
 * A domain with no layer, prepared for one engine view: it restricts no row,
 * judges and projects nothing, and holds the chain's order. It prepares a
 * predicate as the view does, for whoever asks.
 */
export class PlainDomain implements PreparedDomain {
  readonly rows: RowDomain;
  readonly queries: Queries;
  readonly defaults = this;
  readonly judge = undefined;
  readonly project = undefined;
  #view: Queries | undefined;
  constructor(rows: RowDomain, queries: Queries) {
    this.rows = rows;
    this.queries = queries;
  }
  prepare(model: AnyModel, input: Input): PreparedSelector {
    return this.queries.prepareSelector(model, input);
  }
  conjunction(): null {
    return null;
  }
  /** One read view for every call: a plain call carries no value to read. */
  reads(): Queries {
    return (this.#view ??= this.queries.under(this));
  }
  selector(): undefined {
    return undefined;
  }
  bound(): undefined {
    return undefined;
  }
  restrictsLinkWrite(): boolean {
    return false;
  }
  refusal(
    operation: string,
    _model: AnyModel,
    _judgement?: unknown,
    nested?: readonly [verb: string, relation: string]
  ): PreparedGuardFailure {
    return writeRefusal(operation, nested);
  }
  refuseHiddenLinkRow(): void {
    // No row is hidden and no field gated: every link reads as it is.
  }
}

/** Each plain domain, prepared once per query owner, as a filtered one is. */
const prepared = new WeakMap<Queries, WeakMap<RowDomain, PlainDomain>>();

function preparePlain(
  this: CallRows,
  queries: Queries,
  instant: () => Date
): CallScope {
  const domain = memo(
    memo(prepared, queries, () => new WeakMap()),
    this.domain,
    () => new PlainDomain(this.domain, queries)
  );
  return { rows: this, domain, defaults: domain, instant };
}

/** No model is restricted. */
const NONE: ModelDomain = new Map();

/** The facts every call of a plain chain shares; its stamps are its own where they name a control. */
class PlainBinding implements CallRowsBinding {
  readonly #facts: CallRows;
  readonly #stamps: Stamps | undefined;
  constructor({ order, stamps }: ResolvedExtensionChain) {
    const domain: RowDomain = Object.freeze({
      root: NONE,
      related: NONE,
      ...(order && { order: new Map(Object.entries(order)) }),
    });
    this.#stamps = stamps;
    this.#facts = Object.freeze({
      domain,
      defaults: domain,
      ...(stamps && { stamps: stamps.all }),
      prepare: preparePlain,
    });
  }
  call(_model: string, controls: AdmittedControls | undefined): CallRows {
    const stamps = this.#stamps;
    return stamps?.named
      ? Object.freeze({ ...this.#facts, stamps: stamps.of(controls) })
      : this.#facts;
  }
}

/** The call facts of a chain that only orders and stamps rows. */
export const bindPlain = (chain: ResolvedExtensionChain): CallRowsBinding =>
  new PlainBinding(chain);
