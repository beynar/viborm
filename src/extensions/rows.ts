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
  CallValues,
  ModelDomain,
  RowDomain,
} from "@query-engine/raptor3/shared/row-scope";
import { type Input, memo } from "@query-engine/raptor3/shared/schema";
import type { AnyModel } from "@schema/model";
import {
  type AdmittedLayer,
  admitLayer,
  type RuleLayer,
  type VerbsBound,
} from "./admission";
import type { AdmittedArgs } from "./arguments";
import { rebind, refuseUndeclared } from "./call-rows";
import type {
  CallRowsBinding,
  ExtensionPart,
  ResolvedArgs,
  ResolvedExtensionChain,
} from "./chain";
import { type PreparedDomain, prepareCall } from "./row-domain";

const NO_VALUES: AdmittedArgs = Object.freeze({});

/** Calls' shared facts, by the value of one closed argument, then the next. */
interface Shared {
  readonly next: Map<unknown, Shared>;
  rows?: CallRows;
}

/**
 * The chain's `required` declarations as one test, by argument and model:
 * asked only where a value a predicate reads is absent.
 */
const requiredOn =
  (declared: ResolvedArgs | undefined): CallValues["required"] =>
  (argument, model) => {
    const on = declared?.all.find(({ name }) => name === argument)?.required;
    return on === true || on?.includes(model) === true;
  };

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
 * prepared once for every call: where one of them reads a call value, each
 * call carries its values beside the shared domain, an argument with a
 * default at its default where the call passes none.
 */
export class RowsBinding implements CallRowsBinding {
  readonly #kept: ResolvedExtensionChain["kept"];
  readonly #stamps: ResolvedExtensionChain["stamps"];
  /** Some predicate reads a call value: every call carries its values. */
  readonly #parametric: boolean;
  readonly #required: CallValues["required"];
  /** The value of each argument with a default: what a call that passes none takes. */
  readonly #fallback: Readonly<Record<string, unknown>> | undefined;
  /** The facts of a call that deletes physically. */
  readonly #physical: CallRows;
  /** The facts of a call whose deletes keep their rows. */
  readonly #tombstoning: CallRows;
  /**
   * The arguments the predicates read, where each takes one of closed
   * values (`oneOf`) and none reads the instant: calls that pass the same
   * values share one facts object, and so one read view, as many as the
   * values combine.
   */
  readonly #closed: readonly string[] | undefined;
  /** The facts calls share, by the value of each closed argument in turn. */
  readonly #shared: Shared = { next: new Map() };
  readonly #sharedKept: Shared = { next: new Map() };
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
    // An entry given lazily's predicates are not known yet: its calls
    // carry their values.
    this.#parametric =
      lazy || layers.some(({ references }) => references.length > 0);
    const read = new Set(layers.flatMap(({ references }) => references));
    const declared = chain.args?.all ?? [];
    // An entry given lazily may read any argument, known once it is read.
    const defaulted = declared.filter(
      ({ name, default: fallback }) =>
        fallback !== undefined && (lazy || read.has(name))
    );
    this.#closed =
      lazy ||
      chain.stamps?.named === true ||
      ![...read].every((name) =>
        declared.some(
          (argument) => argument.name === name && "oneOf" in argument
        )
      )
        ? undefined
        : [...read].filter((name) => name !== undefined);
    this.#fallback =
      this.#parametric && defaulted.length > 0
        ? Object.freeze(
            Object.fromEntries(
              defaulted.map(({ name, default: fallback }) => [name, fallback])
            )
          )
        : undefined;
    const layered = layers.find((layer) => layer.layered)?.layered;
    const { kept, stamps, defaultOrder: order } = chain;
    this.#kept = kept;
    this.#stamps = stamps;
    this.#required = requiredOn(chain.args);
    const domain: RowDomain = Object.freeze({
      root: modelDomain(layers, "root", filters),
      related: modelDomain(layers, "related", filters),
      ...verbs,
      ...(confine.size > 0 && { confine, bound }),
      ...(layered && { layered }),
      ...(this.#fallback && { fallback: this.#fallback }),
      ...(order && { order: new Map(Object.entries(order)) }),
    });
    this.#physical = Object.freeze({
      domain,
      ...(stamps && { stamps: stamps.all }),
      prepare,
    });
    this.#tombstoning =
      kept === undefined
        ? this.#physical
        : Object.freeze({ ...this.#physical, tombstones: kept });
  }
  /**
   * What a call's predicates read: its arguments, each one with a default at
   * it where the call passes none, and, where they differ from the
   * defaults, the defaults too (`CallValues.defaults`).
   */
  #values(values: AdmittedArgs | undefined, shared?: true): CallValues {
    let given = values ?? NO_VALUES;
    const fallback = this.#fallback;
    let departs = false;
    if (fallback !== undefined)
      for (const name in fallback)
        if (Object.hasOwn(given, name))
          departs ||= !Object.is(given[name], fallback[name]);
        else given = { ...fallback, ...given };
    const required = this.#required;
    return Object.freeze({
      args: given,
      required,
      ...(shared && { shared }),
      ...(departs && {
        defaults: Object.freeze({
          args: { ...given, ...fallback },
          required,
        }),
      }),
    });
  }
  /**
   * One call's row facts, from the arguments it admitted, and whether it
   * deletes physically ({@link Kept.removes}). When its predicates read a
   * call value, the call carries its arguments, each one with a default at
   * it where the call passes none; when a stamp names one, the call's values
   * are put in.
   */
  call(model: string, values: AdmittedArgs | undefined): CallRows {
    const kept = this.#kept;
    const facts =
      kept?.removes(model, values) === true
        ? this.#physical
        : this.#tombstoning;
    const parametric = this.#parametric;
    const stamps = this.#stamps;
    const stamped = stamps?.named === true;
    if (!(parametric || stamped)) return facts;
    const closed = this.#closed;
    if (closed === undefined)
      return Object.freeze({
        ...facts,
        ...(parametric && { values: this.#values(values) }),
        ...(stamped && { stamps: stamps.of(values) }),
      });
    let node = facts === this.#physical ? this.#shared : this.#sharedKept;
    for (const name of closed) {
      const value = values?.[name];
      let next = node.next.get(value);
      if (next === undefined)
        node.next.set(value, (next = { next: new Map() }));
      node = next;
    }
    node.rows ??= Object.freeze({
      ...facts,
      values: this.#values(values, true),
    });
    return node.rows;
  }
}

/** The call facts of a chain whose parts filter, keep or judge rows. */
export const bindRows = (chain: ResolvedExtensionChain): RowsBinding =>
  new RowsBinding(chain);

/**
 * `rule`: one extension's layer admitted where it is applied (once per
 * schema whose scalars admit with the engine's own schemas), the arguments
 * its predicates read checked against the chain's (an entry given lazily's
 * when it is first read), and the chain's call facts bound again.
 */
export function layerPart(layer: RuleLayer): ExtensionPart {
  return {
    join(application) {
      const { name, next, schema, registry } = application;
      const admitted = admitLayer(layer, schema, name, registry);
      refuseUndeclared(application, admitted.references);
      next.rules = Object.freeze([...(next.rules ?? []), admitted]);
      next.bindRows = bindRows;
    },
    seal(application) {
      rebind(application, bindRows);
    },
  };
}
