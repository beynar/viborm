/**
 * What applies a `rule`: each extension's layer admitted once per schema
 * (`admission.ts`) and bound once per application into what each
 * combination of its mode arguments' values selects. A chain whose parts
 * filter, keep or judge rows binds its call facts here, with what its other
 * parts posed: the kept rows, the stamps and the order.
 */
import type {
  CallRows,
  CallValues,
  ModelDomain,
  RowDomain,
} from "@query-engine/raptor3/shared/row-scope";
import { type Input, memo } from "@query-engine/raptor3/shared/schema";
import { type AdmittedLayer, admitLayer } from "./admission";
import { rebind, refuseUndeclared } from "./call-rows";
import type {
  CallRowsBinding,
  ExtensionPart,
  ResolvedControls,
  ResolvedExtensionChain,
} from "./chain";
import { type AdmittedControls, controlsPart } from "./controls";
import { prepareCall } from "./row-domain";
import { bindVerbs, type VerbsBound } from "./verbs";

/** One layer's mode: its argument, and where each of its values sits. */
interface BoundMode {
  readonly control: string | undefined;
  readonly names: readonly string[];
  readonly modes: ReadonlyMap<unknown, number>;
  readonly fallback: number;
  /** How far one step of this layer's mode moves the combination index. */
  readonly stride: number;
}

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
  purpose: "root" | "related"
): ModelDomain {
  const built = new Map<string, readonly Input[] | null>();
  return {
    get: (model) =>
      memo(built, model, () => {
        let list: Input[] | null = null;
        for (const [layer, member] of layers.entries()) {
          const where = member.models[model]?.[modes[layer]!]?.[purpose];
          if (where !== undefined) (list ??= [])[layer] = where;
        }
        return list;
      }) ?? undefined,
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
  readonly #modes: readonly BoundMode[];
  readonly #chain: ResolvedExtensionChain;
  readonly #layers: readonly AdmittedLayer[];
  readonly #verbs: Omit<VerbsBound, "reads">;
  /** Some predicate reads a call value: every call carries its values. */
  readonly #parametric: boolean;
  readonly #order: ReadonlyMap<string, readonly Input[]> | undefined;
  readonly #required: RequiredOn;
  readonly #domains = new Map<number, RowDomain>();
  readonly #combinations = new Map<number, Combination>();
  /** The combination absent arguments select. */
  readonly #fallback: number;
  constructor(chain: ResolvedExtensionChain) {
    const layers = chain.rows ?? [];
    let stride = 1;
    this.#modes = layers.map(({ mode }): BoundMode => {
      const names = mode?.values ?? [""];
      const bound = {
        control: mode?.name,
        names,
        modes: new Map<unknown, number>(
          names.map((name, index) => [name, index])
        ),
        fallback: mode === undefined ? 0 : names.indexOf(mode.fallback),
        stride,
      };
      stride *= names.length;
      return bound;
    });
    const { reads, ...verbs } = bindVerbs(chain);
    this.#chain = chain;
    this.#layers = layers;
    this.#verbs = verbs;
    this.#parametric =
      reads ||
      layers.some((layer) =>
        Object.values(layer.references.modes).some((names) => names.length)
      );
    this.#order = chain.order && new Map(Object.entries(chain.order));
    this.#required = requiredOn(chain.controls);
    this.#fallback = this.#modes.reduce(
      (index, mode) => index + mode.fallback * mode.stride,
      0
    );
  }
  /** Each layer's mode in `combination`. */
  #names(combination: number): readonly string[] {
    return this.#modes.map(
      (mode) =>
        mode.names[Math.floor(combination / mode.stride) % mode.names.length]!
    );
  }
  /** What `combination` selects, one domain for every call that takes it. */
  #domain(combination: number): RowDomain {
    return memo(this.#domains, combination, () => {
      const modes = this.#names(combination);
      return Object.freeze({
        root: modelDomain(this.#layers, modes, "root"),
        related: modelDomain(this.#layers, modes, "related"),
        ...this.#verbs,
        ...(this.#order && { order: this.#order }),
      });
    });
  }
  #combination(combination: number): Combination {
    const { kept, stamps } = this.#chain;
    const physical: CallRows = Object.freeze({
      domain: this.#domain(combination),
      defaults: this.#domain(this.#fallback),
      ...(stamps && { stamps: stamps.all }),
      prepare: prepareCall,
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
    let index = 0;
    for (const mode of this.#modes) {
      if (mode.control !== undefined)
        index +=
          mode.stride *
          (mode.modes.get(controls?.[mode.control]) ?? mode.fallback);
    }
    // Looked up without a closure: every call of the chain passes here.
    let combination = this.#combinations.get(index);
    if (combination === undefined) {
      combination = this.#combination(index);
      this.#combinations.set(index, combination);
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
  uses: [controlsPart],
  join(application) {
    const { definition, chain, next, schema, registry } = application;
    const { rule } = definition;
    if (rule === undefined) return;
    const layer = admitLayer(rule, schema, definition.name, registry);
    const { modes, verbs } = layer.references;
    refuseUndeclared(application, [...Object.values(modes).flat(), ...verbs]);
    next.rows = Object.freeze([...(chain?.rows ?? []), layer]);
    next.bindRows = bindRows;
  },
  seal(application) {
    rebind(application, bindRows);
  },
};
