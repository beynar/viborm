/**
 * Filters (`rows`): the rows each call may take, chosen by modes, admitted
 * once per schema (`admission.ts`) and bound once per application into what
 * each combination of modes selects. A chain whose parts filter, keep or
 * judge rows binds its call facts here, with what its other parts posed: the
 * kept rows, the stamps and the order.
 */
import type {
  CallRows,
  CallValues,
  ModelDomain,
  RowDomain,
} from "@query-engine/raptor3/shared/row-scope";
import { type Input, memo } from "@query-engine/raptor3/shared/schema";
import { isRecord } from "@validation/value-guards";
import { type AdmittedRows, admitRows, type VerbsBound } from "./admission";
import { eachModel, rebind, refuseUndeclared } from "./call-rows";
import type {
  Application,
  CallRowsBinding,
  ExtensionPart,
  ResolvedControls,
  ResolvedExtensionChain,
} from "./chain";
import { type AdmittedControls, controlsPart, rowsModes } from "./controls";
import { extensionError, readOwn, readOwnKeys } from "./definition";
import { prepareCall } from "./row-domain";

/** One `rows` member: its control, and where each of its modes sits. */
interface BoundRowsMember {
  readonly control: string;
  readonly names: readonly string[];
  readonly modes: ReadonlyMap<unknown, number>;
  readonly fallback: number;
  /** How far one step of this member's mode moves the combination index. */
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

/** The chain's `required` declarations as one test, by control and model. */
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
 * One purpose's predicates per model, for one mode of every member, each at
 * its member's place in the chain: the layer the engine reads it as. A
 * model's list is built the first time it is read: a mode that named a lazy
 * `verbs` entry's predicate holds its resolver, called once `verbs` resolved
 * the model's entries, which checks them against the chain.
 */
function modelDomain(
  rows: readonly AdmittedRows[],
  modes: readonly string[],
  purpose: "root" | "related",
  verbs: RowDomain["verbs"]
): ModelDomain {
  const built = new Map<string, readonly Input[] | null>();
  return {
    get: (model) =>
      memo(built, model, () => {
        let list: Input[] | null = null;
        for (const [layer, member] of rows.entries()) {
          // Admission left each predicate admitted, or a lazy entry's
          // resolver: the declared type has no name for either.
          const where = member.models[model]?.[modes[layer]!]?.[purpose] as
            | Input
            | (() => Input)
            | undefined;
          if (where === undefined) continue;
          if (typeof where === "function") verbs!.get(model);
          (list ??= [])[layer] = typeof where === "function" ? where() : where;
        }
        return list;
      }) ?? undefined,
  };
}

/**
 * A chain's row facts, resolved once when an extension is applied: what
 * each combination of its `rows` members' modes selects, built the first
 * time a call takes it, with the chain's kept rows, stamps and order, so a
 * call only looks its facts up. The predicates hold the values they read as
 * parameters, prepared once for every call: where one of them reads a call
 * value, each call carries its values beside the shared domains.
 */
export class RowsBinding implements CallRowsBinding {
  readonly #members: readonly BoundRowsMember[];
  readonly #chain: ResolvedExtensionChain;
  readonly #rows: readonly AdmittedRows[];
  readonly #verbs: Omit<VerbsBound, "reads">;
  /** Some predicate reads a call value: every call carries its values. */
  readonly #parametric: boolean;
  readonly #order: ReadonlyMap<string, readonly Input[]> | undefined;
  readonly #required: RequiredOn;
  readonly #domains = new Map<number, RowDomain>();
  readonly #combinations = new Map<number, Combination>();
  /** The combination absent controls select. */
  readonly #fallback: number;
  constructor(chain: ResolvedExtensionChain) {
    const rows = chain.rows ?? [];
    let stride = 1;
    this.#members = rows.map((member): BoundRowsMember => {
      const modes = rowsModes(member);
      const bound = {
        control: member.control,
        names: modes,
        modes: new Map<unknown, number>(
          modes.map((mode, index) => [mode, index])
        ),
        fallback: modes.indexOf(member.default),
        stride,
      };
      stride *= modes.length;
      return bound;
    });
    // What reads the verbs and confinements, where a member declares one.
    const binder = rows.find((member) => member.bind !== undefined)?.bind;
    const { reads, ...verbs }: VerbsBound = binder?.(rows, chain.controls) ?? {
      reads: false,
    };
    this.#chain = chain;
    this.#rows = rows;
    this.#verbs = verbs;
    this.#parametric =
      reads ||
      rows.some((member) =>
        Object.values(member.references!.modes).some((names) => names.length)
      );
    this.#order = chain.order && new Map(Object.entries(chain.order));
    this.#required = requiredOn(chain.controls);
    this.#fallback = this.#members.reduce(
      (index, member) => index + member.fallback * member.stride,
      0
    );
  }
  /** Each member's mode in `combination`. */
  #modes(combination: number): readonly string[] {
    return this.#members.map(
      (member) =>
        member.names[
          Math.floor(combination / member.stride) % member.names.length
        ]!
    );
  }
  /** What `combination` selects, one domain for every call that takes it. */
  #domain(combination: number): RowDomain {
    return memo(this.#domains, combination, () => {
      const modes = this.#modes(combination);
      const verbs = this.#verbs;
      return Object.freeze({
        root: modelDomain(this.#rows, modes, "root", verbs.verbs),
        related: modelDomain(this.#rows, modes, "related", verbs.verbs),
        ...verbs,
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
   * One call's row facts, from the controls it admitted: the modes its
   * `rows` controls chose (an absent one reads as its default), and whether
   * it deletes physically ({@link Kept.removes}). When its predicates read a
   * call value, the call carries its controls; when a stamp names a control,
   * the call's values are put in.
   */
  call(model: string, controls: AdmittedControls | undefined): CallRows {
    let index = 0;
    for (const member of this.#members) {
      index +=
        member.stride *
        (member.modes.get(controls?.[member.control]) ?? member.fallback);
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

/** The controls an admitted member's predicates name, its mode control aside. */
function namedControls(rows: AdmittedRows): (string | undefined)[] {
  const { modes, verbs } = rows.references!;
  return [...Object.values(modes).flat(), ...verbs];
}

/**
 * What a `rows` member's models declare, checked before its predicates are
 * admitted: every model the same mode names, the default among them, each
 * mode an object.
 */
function checkModes(application: Application): void {
  const extension = application.definition.name;
  let expected: readonly string[] | undefined;
  eachModel(application, "rows", (_model, _name, entry, declaration) => {
    const fallback = readOwn(declaration, "default", extension);
    const modes = readOwnKeys(entry, extension);
    const named = modes.filter((key): key is string => typeof key === "string");
    const prior = expected;
    if (
      typeof fallback !== "string" ||
      !named.includes(fallback) ||
      (prior &&
        (prior.length !== named.length ||
          named.some((mode) => !prior.includes(mode))))
    )
      extensionError(
        `Extension "${extension}" row models must share mode names and include the default mode.`,
        extension
      );
    expected ??= named;
    for (const mode of modes) {
      if (typeof mode !== "string")
        extensionError(
          `Extension "${extension}" row mode must be a string.`,
          extension
        );
      if (!isRecord(readOwn(entry, mode, extension)))
        extensionError(
          `Extension "${extension}" row mode must be an object.`,
          extension
        );
    }
  });
}

/**
 * `rows` admitted where the extension is applied, through each model's
 * `where` schema, unless it declares `verbs` or `confine`: what reads those
 * admits it then ({@link verbsPart}). Once every part has checked what it
 * reads, so a refusal names the member at fault, whichever part it is.
 */
export function admitFilters(application: Application): void {
  const { definition, schema, registry } = application;
  const { rows } = definition;
  if (
    rows === undefined ||
    rows.verbs !== undefined ||
    rows.confine !== undefined
  )
    return;
  application.definition = Object.freeze({
    ...definition,
    rows: admitRows(rows, schema, definition.name, registry),
  });
}

/**
 * `rows`: filters. Its mode control is placed by the controls part, which it
 * brings. A member that declares `verbs` or `confine` is admitted by what
 * reads them: without it, it is refused rather than read as filters alone.
 */
export const filtersPart: ExtensionPart = {
  members: ["rows"],
  uses: [controlsPart],
  admit: checkModes,
  declare: admitFilters,
  join(application) {
    const { definition, chain, next } = application;
    const { rows } = definition;
    if (rows === undefined) return;
    if (rows.references === undefined)
      extensionError(
        "An extension whose `rows` declare `verbs` or `confine` must be built with defineExtension().",
        definition.name
      );
    // A lazy `verbs` entry's references are checked when it is resolved, by
    // the binding, against what the chain declared where it was applied.
    refuseUndeclared(application, namedControls(rows));
    next.rows = Object.freeze([...(chain?.rows ?? []), rows]);
    next.bindRows = bindRows;
  },
  seal(application) {
    rebind(application, bindRows);
  },
};
