import { ClientInitializationError } from "@errors";
import {
  type CallRows,
  Condition,
  type ModelDomain,
  type ModelStamps,
  type ModelVerbs,
  Parameter,
  type RowDomain,
} from "@query-engine/raptor3/shared/row-scope";
import type { Input } from "@query-engine/raptor3/shared/schema";
import { isPlainRecord } from "@schema/relation/terminal";
import { isImmutableRowData, isInstant, isReference } from "./admission";
import type { ResolvedControls, ResolvedDeletion } from "./chain";
import {
  type AdmittedControls,
  type RowsContribution,
  rowsModes,
} from "./controls";
import type { RuntimeExtensionDefinition } from "./definition";

type Predicates = RowsContribution["models"][string][string];

/** One `rows` member: its control, and where each of its modes sits. */
interface BoundRowsMember {
  readonly control: string;
  readonly names: readonly string[];
  readonly modes: ReadonlyMap<unknown, number>;
  readonly fallback: number;
  /** How far one step of this member's mode moves the combination index. */
  readonly stride: number;
}

/**
 * A chain's row facts, resolved once when an extension is applied: one
 * {@link CallRows} per combination of its `rows` members' modes, with and
 * without the tombstones, each with the chain's `data` stamps, so a call only
 * looks its facts up. The predicates hold the values they read as
 * parameters, prepared once for every call: a call whose combination reads
 * one carries its values beside the shared domains. When a stamp names a
 * control, the call's values are put in its stamps for that call alone.
 */
export interface RowsBinding {
  readonly members: readonly BoundRowsMember[];
  readonly deletion: Readonly<Record<string, ResolvedDeletion>>;
  /** Indexed by mode combination: the call writes tombstones. */
  readonly tombstoning: readonly CallRows[];
  /** Indexed by mode combination: the call deletes physically. */
  readonly physical: readonly CallRows[];
  /**
   * Indexed by mode combination: its domain or the default one reads a call
   * value, so its calls carry their values.
   */
  readonly parametric: readonly boolean[];
  /** A stamp names a control: each call puts its values in the stamps. */
  readonly bindsStamps: boolean;
  /** Whether a call must pass a control to touch a model directly. */
  readonly required: RequiredOn;
}

type RequiredOn = (control: string, model: string) => boolean;

const NEVER_REQUIRED: RequiredOn = () => false;

const NO_DELETION: Readonly<Record<string, ResolvedDeletion>> = Object.freeze(
  Object.create(null)
);

const NO_CONTROLS: AdmittedControls = Object.freeze({});

/** A named control the call did not pass. */
const ABSENT = Symbol("absent");

/**
 * Every control a definition's values name, at any depth: an admitted
 * predicate's parameters and conditions, and a stamp's references.
 */
function collectReferences(
  value: unknown,
  names: Set<string>,
  // Predicates share sub-predicates freely: each is read once.
  seen = new Set<object>()
): void {
  const parameter = value instanceof Condition ? value.parameter : value;
  if (parameter instanceof Parameter) {
    if (parameter.control !== undefined) names.add(parameter.control);
  } else if (isReference(value)) names.add(value.control);
  else if (Array.isArray(value) || isPlainRecord(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const item of Object.values(value))
      collectReferences(item, names, seen);
  }
}

// Admission-owned immutable predicates have the same references in every chain.
// Declarations and the receiving chain's controls are still checked each time.
const rowReferences = new WeakMap<RowsContribution, readonly string[]>();
function referencesOfRows(rows: RowsContribution): readonly string[] {
  const cached = rowReferences.get(rows);
  if (cached) return cached;
  const references = new Set<string>();
  const seen = new Set<object>();
  for (const modes of Object.values(rows.models))
    for (const mode of Object.values(modes)) {
      collectReferences(mode.root, references, seen);
      collectReferences(mode.related, references, seen);
    }
  for (const entry of Object.values(rows.verbs ?? {}))
    collectReferences(entry.predicates, references, seen);
  const names = [...references];
  if (isImmutableRowData(rows)) rowReferences.set(rows, names);
  return names;
}

/** The controls a stamp's fields name: its own keys are fields, never values. */
function collectStampReferences(
  stamp: Input | undefined,
  names: Set<string>
): void {
  for (const value of Object.values(stamp ?? {}))
    collectReferences(value, names);
}

/**
 * The controls a definition names but does not declare; the chain admits
 * those an earlier extension declares.
 */
export function undeclaredControlReferencesOf(
  definition: RuntimeExtensionDefinition
): readonly string[] {
  const declared = new Set(Object.keys(definition.controls ?? {}));
  if (definition.rows) declared.add(definition.rows.control);
  const references = new Set(
    definition.rows ? referencesOfRows(definition.rows) : []
  );
  for (const entry of Object.values(definition.data?.models ?? {})) {
    collectStampReferences(entry.create, references);
    collectStampReferences(entry.update, references);
  }
  for (const name of Object.keys(definition.deletion?.removeWhen ?? {}))
    references.add(name);
  return [...references].filter((name) => !declared.has(name));
}

/** Whether a domain's predicates read a call value (admission's nodes). */
function readsCall(value: unknown): boolean {
  if (value instanceof Parameter || value instanceof Condition) return true;
  if (Array.isArray(value)) return value.some(readsCall);
  return isPlainRecord(value) && Object.values(value).some(readsCall);
}

/** A stamp's value with the call's put in: itself when it names none. */
function stampValue(
  value: unknown,
  controls: AdmittedControls | undefined
): unknown {
  if (isReference(value)) {
    let given = controls?.[value.control];
    const { path } = value;
    for (const key of path === undefined ? [] : path.split(".")) {
      given =
        isPlainRecord(given) && Object.hasOwn(given, key)
          ? given[key]
          : undefined;
    }
    return given === undefined ? ABSENT : given;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => stampValue(item, controls));
    if (items.includes(ABSENT)) return ABSENT;
    return items.every((item, index) => item === value[index]) ? value : items;
  }
  if (!isPlainRecord(value)) return value;
  let copy: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(value)) {
    const bound = stampValue(item, controls);
    if (bound === ABSENT) return ABSENT;
    if (bound !== item) (copy ??= { ...value })[key] = bound;
  }
  return copy ?? value;
}

/**
 * A stamp bound: a field whose value names a control the call did not pass is
 * not written. The same object when no field names a control.
 */
function boundStamp(
  stamp: Input | undefined,
  controls: AdmittedControls | undefined
): Input | undefined {
  if (stamp === undefined) return undefined;
  const values: Record<string, unknown> = {};
  let changed = false;
  for (const [field, value] of Object.entries(stamp)) {
    const bound = stampValue(value, controls);
    changed ||= bound !== value;
    if (bound !== ABSENT) values[field] = bound;
  }
  return changed ? Object.freeze(values) : stamp;
}

/** Each model's stamps bound; an entry naming no control is kept as is. */
function boundStamps(
  stamps: ReadonlyMap<string, ModelStamps>,
  controls: AdmittedControls | undefined
): ReadonlyMap<string, ModelStamps> {
  const bound = new Map<string, ModelStamps>();
  for (const [model, entry] of stamps) {
    const create = boundStamp(entry.create, controls);
    const update = boundStamp(entry.update, controls);
    bound.set(
      model,
      create === entry.create && update === entry.update
        ? entry
        : Object.freeze({ create, update })
    );
  }
  return bound;
}

/** The call's one instant, where a stamp's field writes `{ now: true }`. */
const NOW = new Parameter();

/** A stamp with each `{ now: true }` field as {@link NOW}: itself without one. */
function withInstants(stamp: Input | undefined): Input | undefined {
  let copy: Record<string, unknown> | undefined;
  for (const [field, value] of Object.entries(stamp ?? {}))
    if (isInstant(value)) (copy ??= { ...stamp })[field] = NOW;
  return copy === undefined ? stamp : Object.freeze(copy);
}

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
 * its member's place in the chain: the layer the engine reads it as. A mode
 * that named a predicate holds its admitted object.
 */
function modelDomain(
  rows: readonly RowsContribution[],
  modes: readonly string[],
  purpose: keyof Predicates
): ModelDomain {
  const domain = new Map<string, Input[]>();
  for (const [layer, member] of rows.entries()) {
    for (const [model, entry] of Object.entries(member.models)) {
      const where = entry[modes[layer]!]?.[purpose];
      if (where === undefined) continue;
      const list = domain.get(model) ?? [];
      list[layer] = where as Input;
      domain.set(model, list);
    }
  }
  return domain;
}

/** `{ OR: [] }`, false: what a verb a model's `verbs` leaves out takes. */
const NOTHING: Input = Object.freeze({ OR: Object.freeze([]) });

/** A `writes` or `moves` entry, its names resolved. */
const fieldsOf = (
  entry: { readonly [field: string]: string } | undefined,
  named: (name: string) => Input
): ReadonlyMap<string, Input> =>
  new Map(
    Object.entries(entry ?? {}).map(([field, name]) => [field, named(name)])
  );

/**
 * Every member's verbs per model, each at its member's layer, their names
 * resolved to the admitted predicates: the same for every mode combination.
 */
function modelVerbs(
  rows: readonly RowsContribution[]
): ReadonlyMap<string, readonly (ModelVerbs | undefined)[]> | undefined {
  const verbs = new Map<string, (ModelVerbs | undefined)[]>();
  const keys = new Set<string>();
  for (const [layer, member] of rows.entries()) {
    for (const [model, entry] of Object.entries(member.verbs ?? {})) {
      // One projection key, one layer: a second would hide the first.
      const key = entry.evidence && `${model}.${entry.evidence.as}`;
      if (key !== undefined && keys.has(key))
        throw new ClientInitializationError(
          `rows.verbs.${model}.evidence.as "${entry.evidence!.as}" is declared by two extensions of the chain.`,
          { meta: { model } }
        );
      if (key !== undefined) keys.add(key);
      const named = (name: string | undefined): Input =>
        name === undefined ? NOTHING : entry.predicates[name]!;
      const list = verbs.get(model) ?? [];
      list[layer] = Object.freeze({
        read: named(entry.read),
        update: named(entry.update),
        delete: named(entry.delete),
        writes: fieldsOf(entry.writes, named),
        ...(entry.place !== undefined && { place: named(entry.place) }),
        moves: fieldsOf(entry.moves, named),
        acyclic: Object.freeze([...(entry.acyclic ?? [])]),
        ...(entry.evidence && {
          evidence: Object.freeze({
            as: entry.evidence.as,
            names: Object.freeze(
              entry.evidence.names.map((name) =>
                Object.freeze([name, named(name)] as const)
              )
            ),
            ordered: entry.evidence.ordered === true,
          }),
        }),
        reads: fieldsOf(entry.reads, named),
      });
      verbs.set(model, list);
    }
  }
  return verbs.size === 0 ? undefined : verbs;
}

export function bindRows(
  rows: readonly RowsContribution[] | undefined,
  deletion: Readonly<Record<string, ResolvedDeletion>> | undefined,
  data?: Readonly<Record<string, ModelStamps>>,
  controls?: ResolvedControls
): RowsBinding {
  const declared = rows ?? [];
  let stride = 1;
  const members = declared.map((member): BoundRowsMember => {
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
  const domains: RowDomain[] = [];
  const verbs = modelVerbs(declared);
  for (let combination = 0; combination < stride; combination++) {
    const modes = members.map(
      (member) =>
        member.names[
          Math.floor(combination / member.stride) % member.names.length
        ]!
    );
    domains.push(
      Object.freeze({
        root: modelDomain(declared, modes, "root"),
        related: modelDomain(declared, modes, "related"),
        ...(verbs && { verbs }),
      })
    );
  }
  const defaults =
    domains[
      members.reduce(
        (index, member) => index + member.fallback * member.stride,
        0
      )
    ]!;
  const tombstones =
    deletion === undefined ? undefined : new Map(Object.entries(deletion));
  const stamps =
    data === undefined
      ? undefined
      : new Map(
          Object.entries(data).map(([model, entry]) => {
            const create = withInstants(entry.create);
            const update = withInstants(entry.update);
            return [
              model,
              create === entry.create && update === entry.update
                ? entry
                : Object.freeze({ create, update }),
            ] as const;
          })
        );
  const stampReferences = new Set<string>();
  for (const entry of stamps?.values() ?? []) {
    collectStampReferences(entry.create, stampReferences);
    collectStampReferences(entry.update, stampReferences);
  }
  const physical = domains.map((domain) =>
    Object.freeze({ domain, defaults, ...(stamps && { stamps }) })
  );
  const verbsRead = declared.some((member) =>
    Object.values(member.verbs ?? {}).some((entry) =>
      readsCall(entry.predicates)
    )
  );
  const reads = (domain: RowDomain) =>
    verbsRead ||
    [domain.root, domain.related].some((models) =>
      [...models.values()].some(readsCall)
    );
  return Object.freeze({
    members,
    deletion: deletion ?? NO_DELETION,
    physical,
    tombstoning:
      tombstones === undefined
        ? physical
        : physical.map((facts) => Object.freeze({ ...facts, tombstones })),
    parametric: domains.map((domain) => reads(domain) || reads(defaults)),
    bindsStamps: stampReferences.size > 0,
    required: requiredOn(controls),
  });
}

/**
 * One call's row facts, from the controls it admitted: the modes its `rows`
 * controls chose (an absent one reads as its default), and whether it deletes
 * physically — its model's `deletion` entry names a `removeWhen` the call's
 * controls match. That control is placed only on the deletes of the models
 * the entry manages, so no other call can match it. When its predicates read
 * a call value, the call carries its controls; when a stamp names a control,
 * the call's values are put in.
 */
export function callRows(
  binding: RowsBinding,
  model: string,
  controls: AdmittedControls | undefined
): CallRows {
  let combination = 0;
  for (const member of binding.members) {
    combination +=
      member.stride *
      (member.modes.get(controls?.[member.control]) ?? member.fallback);
  }
  const removeWhen = binding.deletion[model]?.removeWhen;
  const physical =
    removeWhen !== undefined &&
    Object.entries(removeWhen).every(
      ([control, value]) => controls?.[control] === value
    );
  const facts = (physical ? binding.physical : binding.tombstoning)[
    combination
  ]!;
  const parametric = binding.parametric[combination]!;
  if (!(parametric || binding.bindsStamps)) return facts;
  return Object.freeze({
    ...facts,
    ...(parametric && {
      values: Object.freeze({
        controls: controls ?? NO_CONTROLS,
        required: binding.required,
      }),
    }),
    ...(binding.bindsStamps && {
      stamps: boundStamps(facts.stamps!, controls),
    }),
  });
}
