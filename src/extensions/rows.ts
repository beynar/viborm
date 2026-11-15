/**
 * What applies a `rule`: each extension's layer admitted once per schema
 * (`admission.ts`) and bound once per application into one domain, whose
 * predicates read each call's values. A chain whose parts filter, keep or
 * judge rows binds its call facts here, with what its other parts posed: the
 * kept rows, the stamps and the order.
 */
import type { PreparedSelector } from "@query-engine/raptor3/shared/query";
import type {
  CallRows,
  ModelDomain,
  RowDomain,
} from "@query-engine/raptor3/shared/row-scope";
import { type Input, memo } from "@query-engine/raptor3/shared/schema";
import type { AnyModel } from "@schema/model";
import {
  type AdmittedLayer,
  admitLayer,
  type CallReads,
  nativeSchema,
  type RuleLayer,
  type VerbsBound,
} from "./admission";
import type { AdmittedArgs } from "./arguments";
import { rebind, refuseUndeclared } from "./call-rows";
import type {
  CallRowsBinding,
  ExtensionPart,
  ResolvedExtensionChain,
} from "./chain";
import { type PreparedDomain, prepareCall } from "./row-domain";

/**
 * One purpose's predicates per model, each at its layer's place in the
 * chain: the layer the engine reads it as.
 */
function modelDomain(
  layers: readonly AdmittedLayer[],
  purpose: "root" | "related",
  lazy: VerbsBound["filters"] | undefined
): ModelDomain {
  const built = new Map<string, readonly Input[] | null>();
  return {
    get: (model) =>
      memo(built, model, () => {
        let list: Input[] | null = null;
        for (const [layer, member] of layers.entries()) {
          // An entry given lazily holds its filters: read it now.
          const filters = member.models[model] ?? lazy?.(model, layer);
          const where = filters?.[purpose];
          if (where !== undefined) (list ??= [])[layer] = where;
        }
        return list;
      }) ?? undefined,
  };
}
/**
 * What an `excluded` layer states its own whole-table sets of a model hold
 * (`confine`), for one prepared domain: inside its own predicates a layer
 * reads nothing of itself, but a set the statement computes over a whole
 * table (a shared body, a reaching set) still holds only what it bounds.
 * `undefined` where none states one.
 */
function bound(domain: PreparedDomain) {
  const bounds = new Map<string, PreparedSelector | null>();
  return (
    model: AnyModel,
    excluded: readonly number[]
  ): PreparedSelector | undefined => {
    const name = model["~"].names.ts!;
    const inputs = domain.rows.confine?.get(name);
    if (inputs === undefined) return undefined;
    // Every excluded layer's: each only narrows, and one left out would let
    // another's widen what it bounds.
    return (
      memo(bounds, `${name} ${excluded}`, () =>
        domain.conjunction(
          model,
          excluded.map((layer) => {
            const input = inputs[layer];
            return [layer, input === undefined ? [] : [input]] as const;
          })
        )
      ) ?? undefined
    );
  };
}

/**
 * A chain's row facts, resolved once when an extension is applied: one
 * domain, with the chain's kept rows, stamps and order, so a call only looks
 * its facts up. The predicates hold the values they read as parameters,
 * prepared once for every call: where one of them reads a call value, what
 * the words that read it brought carries each call's values beside the
 * shared domain (`call-values.ts`).
 */
export class RowsBinding implements CallRowsBinding {
  readonly #kept: ResolvedExtensionChain["kept"];
  readonly #stamps: ResolvedExtensionChain["stamps"];
  /** The facts of a call that deletes physically. */
  readonly #physical: CallRows;
  /** The facts of a call whose deletes keep their rows. */
  readonly #tombstoning: CallRows;
  /** Where some predicate reads a call value: what puts the call's in. */
  readonly #values: ReturnType<CallReads["bind"]>["call"] | undefined;
  constructor(chain: ResolvedExtensionChain) {
    const layers = chain.rules ?? [];
    // The verbs, where some word brought what binds them.
    const host = layers.find((layer) => layer.host)?.host;
    const {
      lazy = false,
      filters,
      prepare = prepareCall,
      ...verbs
    } = host?.bind(chain) ?? {};
    const confine = new Map<string, Input[]>();
    for (const [layer, member] of layers.entries())
      for (const [model, where] of Object.entries(member.confine))
        memo(confine, model, () => [])[layer] = where;
    const { kept, stamps, defaultOrder: order } = chain;
    this.#kept = kept;
    this.#stamps = stamps;
    let domain: RowDomain = {
      root: modelDomain(layers, "root", filters),
      related: modelDomain(layers, "related", filters),
      ...verbs,
      ...(confine.size > 0 && { confine, bound }),
      ...(order && { order: new Map(Object.entries(order)) }),
    };
    // Where some predicate reads its call, what the words that read it
    // brought carries each call's values.
    const reads = layers
      .find((layer) => layer.reads)
      ?.reads?.bind(chain, lazy, domain);
    if (reads) domain = reads.domain;
    this.#values = reads?.call;
    this.#physical = {
      domain,
      ...(stamps && { stamps: stamps.all }),
      prepare,
    };
    this.#tombstoning =
      kept === undefined
        ? this.#physical
        : { ...this.#physical, tombstones: kept };
  }
  /**
   * One call's row facts, from the arguments it admitted, and whether it
   * deletes physically ({@link Kept.removes}); when a stamp names an
   * argument, the call's values are put in.
   */
  call(model: string, values: AdmittedArgs | undefined): CallRows {
    let facts =
      this.#kept?.removes(model, values) === true
        ? this.#physical
        : this.#tombstoning;
    const stamps = this.#stamps;
    if (stamps?.named === true) facts = { ...facts, stamps: stamps.of(values) };
    return this.#values?.(facts, values) ?? facts;
  }
}

/** The call facts of a chain whose parts filter, keep or judge rows. */
export const bindRows = (chain: ResolvedExtensionChain): RowsBinding =>
  new RowsBinding(chain);

/**
 * `rule`: one extension's layer admitted where it is applied, the arguments
 * its predicates read checked against the chain's (an entry given lazily's
 * when it is first read), and the chain's call facts bound again. The layer
 * is the extension's for one schema: admitted once where the schema's
 * scalars admit with the engine's own schemas (a field's own schema may
 * read its value differently on another call).
 */
export function layerPart(layer: RuleLayer): ExtensionPart {
  let native: boolean | undefined;
  let admitted: AdmittedLayer | undefined;
  return {
    join(application) {
      const { name, next, schema, registry } = application;
      const own = admitted ?? admitLayer(layer, schema, name, registry);
      if ((native ??= nativeSchema(schema))) admitted = own;
      refuseUndeclared(application, own.references);
      next.rules = [...(next.rules ?? []), own];
      next.bindRows = bindRows;
    },
    seal(application) {
      rebind(application, bindRows);
    },
  };
}
