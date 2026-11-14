/**
 * What applies a `rule`: each extension's layer admitted once per schema
 * (`admission.ts`) and bound once per application into what each
 * combination of its mode arguments' values selects. A chain whose parts
 * filter, keep or judge rows binds its call facts here, with what its other
 * parts posed: the kept rows, the stamps and the order.
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
import { type AdmittedLayer, admitLayer, type VerbsBound } from "./admission";
import { rebind, refuseUndeclared } from "./call-rows";
import type {
  CallRowsBinding,
  ExtensionPart,
  ResolvedControls,
  ResolvedExtensionChain,
} from "./chain";
import type { AdmittedControls } from "./controls";
import { type PreparedDomain, prepareCall } from "./row-domain";

/** What one combination of modes selects, with and without the tombstones. */
interface Combination {
  /** The call writes tombstones. */
  readonly tombstoning: CallRows;
  /** The call deletes physically. */
  readonly physical: CallRows;
}

type RequiredOn = CallValues["required"];

const NEVER_REQUIRED: RequiredOn = () => false;

const NO_CONTROLS: AdmittedControls = Object.freeze({});

/** The chain's `required` declarations as one test, by argument and model. */
function requiredOn(controls: ResolvedControls | undefined): RequiredOn {
  const required = new Map<string, true | ReadonlySet<string>>();
  for (const control of controls?.all ?? []) {
    if (control.required !== undefined)
      required.set(control.name, control.required);
  }
  if (required.size === 0) return NEVER_REQUIRED;
  return (control, model) => {
    const on = required.get(control);
    return on === true || on?.has(model) === true;
  };
}

/**
 * One purpose's predicates per model, for one mode of every layer, each at
 * its layer's place in the chain: the layer the engine reads it as.
 */
function modelDomain(
  layers: readonly AdmittedLayer[],
  modes: readonly string[],
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
          const where = filters?.[modes[layer]!]?.[purpose];
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
 * A chain's row facts, resolved once when an extension is applied: what
 * each combination of its layers' modes selects, built the first time a
 * call takes it, with the chain's kept rows, stamps and order, so a call
 * only looks its facts up. The predicates hold the values they read as
 * parameters, prepared once for every call: where one of them reads a call
 * value, each call carries its values beside the shared domains.
 */
export class RowsBinding implements CallRowsBinding {
  readonly #chain: ResolvedExtensionChain;
  readonly #layers: readonly AdmittedLayer[];
  /** What the domains hold beside the filters: verbs, confinements. */
  readonly #beside: Partial<RowDomain>;
  readonly #lazy: VerbsBound["filters"] | undefined;
  readonly #prepare: CallRows["prepare"];
  /** Some predicate reads a call value: every call carries its values. */
  readonly #parametric: boolean;
  readonly #order: ReadonlyMap<string, readonly Input[]> | undefined;
  readonly #required: RequiredOn;
  /** Per combination of the layers' modes, its key: each value, then NUL. */
  readonly #domains = new Map<string, RowDomain>();
  readonly #combinations = new Map<string, Combination>();
  /** The combination absent arguments select. */
  readonly #fallback: string;
  constructor(chain: ResolvedExtensionChain) {
    const layers = chain.rows ?? [];
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
    this.#lazy = filters;
    this.#prepare = prepare;
    this.#chain = chain;
    this.#layers = layers;
    const layered = layers.find((layer) => layer.layered)?.layered;
    this.#beside = {
      ...verbs,
      ...(confine.size > 0 && { confine, bound }),
      ...(layered && { layered }),
    };
    // An entry given lazily's predicates are not known yet: its calls
    // carry their values.
    this.#parametric =
      lazy || layers.some(({ references }) => references.length > 0);
    this.#order = chain.order && new Map(Object.entries(chain.order));
    this.#required = requiredOn(chain.controls);
    this.#fallback = this.#key(undefined);
  }
  /**
   * The combination `controls` select: each layer's mode, the value its
   * argument took, or its default where it took none of the mode's values.
   */
  #key(controls: AdmittedControls | undefined): string {
    let key = "";
    for (const { mode } of this.#layers) {
      const value = mode && controls?.[mode.name];
      const taken = mode?.values.find((name) => name === value);
      key += `${taken ?? mode?.fallback ?? ""}\u0000`;
    }
    return key;
  }
  /** What `combination` selects, one domain for every call that takes it. */
  #domain(combination: string): RowDomain {
    return memo(this.#domains, combination, () => {
      const modes = combination.split("\u0000");
      return Object.freeze({
        root: modelDomain(this.#layers, modes, "root", this.#lazy),
        related: modelDomain(this.#layers, modes, "related", this.#lazy),
        ...this.#beside,
        ...(this.#order && { order: this.#order }),
      });
    });
  }
  #combination(combination: string): Combination {
    const { kept, stamps } = this.#chain;
    const physical: CallRows = Object.freeze({
      domain: this.#domain(combination),
      defaults: this.#domain(this.#fallback),
      ...(stamps && { stamps: stamps.all }),
      prepare: this.#prepare,
    });
    return {
      physical,
      tombstoning:
        kept === undefined
          ? physical
          : Object.freeze({ ...physical, tombstones: kept }),
    };
  }
  /**
   * One call's row facts, from the arguments it admitted: the value each
   * layer's mode argument took (an absent one reads as its default), and
   * whether it deletes physically ({@link Kept.removes}). When its
   * predicates read a call value, the call carries its arguments; when a
   * stamp names one, the call's values are put in.
   */
  call(model: string, controls: AdmittedControls | undefined): CallRows {
    const key = this.#key(controls);
    // Looked up without a closure: every call of the chain passes here.
    let combination = this.#combinations.get(key);
    if (combination === undefined) {
      combination = this.#combination(key);
      this.#combinations.set(key, combination);
    }
    const { kept, stamps } = this.#chain;
    const facts =
      kept?.removes(model, controls) === true
        ? combination.physical
        : combination.tombstoning;
    const parametric = this.#parametric;
    const stamped = stamps?.named === true;
    if (!(parametric || stamped)) return facts;
    return Object.freeze({
      ...facts,
      ...(parametric && {
        values: Object.freeze({
          controls: controls ?? NO_CONTROLS,
          required: this.#required,
        }),
      }),
      ...(stamped && { stamps: stamps.of(controls) }),
    });
  }
}

/** The call facts of a chain whose parts filter, keep or judge rows. */
export const bindRows = (chain: ResolvedExtensionChain): RowsBinding =>
  new RowsBinding(chain);

/**
 * `rule`: its layer admitted where the extension is applied, the arguments
 * its predicates read checked against the chain's (an entry given as a
 * function's when it is first read), and the chain's call facts bound again.
 */
export const rulePart: ExtensionPart = {
  join(application) {
    const { definition, chain, next, schema, registry } = application;
    const { rule } = definition;
    if (rule === undefined) return;
    const layer = admitLayer(rule, schema, definition.name, registry);
    refuseUndeclared(application, layer.references);
    next.rows = Object.freeze([...(chain?.rows ?? []), layer]);
    next.bindRows = bindRows;
  },
  seal(application) {
    rebind(application, bindRows);
  },
};
