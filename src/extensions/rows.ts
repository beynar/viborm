import {
  type CallRows,
  type ModelDomain,
  type ModelStamps,
  Parameter,
  type RowDomain,
} from "@query-engine/raptor3/shared/row-scope";
import { type Input, memo } from "@query-engine/raptor3/shared/schema";
import { isPlainRecord } from "@schema/relation/terminal";
import {
  type AdmittedRows,
  isInstant,
  isReference,
  type VerbsBound,
} from "./admission";
import type { ResolvedControls, ResolvedDeletion } from "./chain";
import { type AdmittedControls, rowsModes } from "./controls";
import type { RuntimeExtensionDefinition } from "./definition";
import { Kept } from "./kept";
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
  /** One call's row facts, from the controls it admitted ({@link callRows}). */
  readonly call: (
    model: string,
    controls: AdmittedControls | undefined
  ) => CallRows;
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
 * A stamp's value with each reference it holds, at any depth, given what
 * `read` answers for it: itself when it holds none, {@link ABSENT} where
 * `read` answers nothing.
 */
function stampValue(
  value: unknown,
  read: (control: string, path: string | undefined) => unknown
): unknown {
  if (isReference(value)) {
    const given = read(value.control, value.path);
    return given === undefined ? ABSENT : given;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => stampValue(item, read));
    if (items.includes(ABSENT)) return ABSENT;
    return items.every((item, index) => item === value[index]) ? value : items;
  }
  if (!isPlainRecord(value)) return value;
  let copy: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(value)) {
    const bound = stampValue(item, read);
    if (bound === ABSENT) return ABSENT;
    if (bound !== item) (copy ??= { ...value })[key] = bound;
  }
  return copy ?? value;
}

/** The controls a stamp's fields name: its own keys are fields, never values. */
function collectStampReferences(
  stamp: Input | undefined,
  names: Set<string>
): void {
  for (const value of Object.values(stamp ?? {}))
    stampValue(value, (control) => names.add(control));
}

/**
 * The controls a definition names but does not declare; the chain admits
 * those an earlier extension declares.
 */
export function undeclaredControlReferencesOf(
  definition: RuntimeExtensionDefinition
): readonly string[] {
  const declared = new Set(Object.keys(definition.controls ?? {}));
  const references = new Set<string>();
  const { rows } = definition;
  if (rows) {
    declared.add(rows.control);
    // Admission recorded the controls its predicates name.
    for (const names of [
      ...Object.values(rows.references!.modes),
      rows.references!.verbs,
    ])
      for (const name of names) if (name !== undefined) references.add(name);
  }
  for (const entry of Object.values(definition.data?.models ?? {})) {
    collectStampReferences(entry.create, references);
    collectStampReferences(entry.update, references);
  }
  for (const name of Object.keys(definition.deletion?.removeWhen ?? {}))
    references.add(name);
  return [...references].filter((name) => !declared.has(name));
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
  const read = (control: string, path: string | undefined) => {
    let given = controls?.[control];
    for (const key of path === undefined ? [] : path.split("."))
      given =
        isPlainRecord(given) && Object.hasOwn(given, key)
          ? given[key]
          : undefined;
    return given;
  };
  const values: Record<string, unknown> = {};
  let changed = false;
  for (const [field, value] of Object.entries(stamp)) {
    const bound = stampValue(value, read);
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

export function bindRows(
  rows: readonly AdmittedRows[] | undefined,
  deletion: Readonly<Record<string, ResolvedDeletion>> | undefined,
  data?: Readonly<Record<string, ModelStamps>>,
  controls?: ResolvedControls,
  order?: Readonly<Record<string, readonly Input[]>>
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
  // What reads the verbs and confinements, where a member declares one.
  const binder = declared.find((member) => member.bind !== undefined)?.bind;
  const { reads: verbsRead, ...verbs }: VerbsBound = binder?.(
    declared,
    controls
  ) ?? { reads: false };
  const orders = order && new Map(Object.entries(order));
  const domains: RowDomain[] = [];
  const reading: boolean[] = [];
  for (let combination = 0; combination < stride; combination++) {
    const modes = members.map(
      (member) =>
        member.names[
          Math.floor(combination / member.stride) % member.names.length
        ]!
    );
    domains.push(
      Object.freeze({
        root: modelDomain(declared, modes, "root", verbs.verbs),
        related: modelDomain(declared, modes, "related", verbs.verbs),
        ...verbs,
        ...(orders && { order: orders }),
      })
    );
    reading.push(
      verbsRead ||
        modes.some(
          (mode, layer) =>
            (declared[layer]!.references!.modes[mode]?.length ?? 0) > 0
        )
    );
  }
  const fallback = members.reduce(
    (index, member) => index + member.fallback * member.stride,
    0
  );
  const defaults = domains[fallback]!;
  const tombstones =
    deletion === undefined ? undefined : new Kept(Object.entries(deletion));
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
    Object.freeze({
      domain,
      defaults,
      ...(stamps && { stamps }),
      prepare: prepareCall,
    })
  );
  const binding: RowsBinding = Object.freeze({
    members,
    deletion: deletion ?? NO_DELETION,
    physical,
    tombstoning:
      tombstones === undefined
        ? physical
        : physical.map((facts) => Object.freeze({ ...facts, tombstones })),
    parametric: reading.map((reads) => reads || reading[fallback]!),
    bindsStamps: stampReferences.size > 0,
    required: requiredOn(controls),
    call: (model, admitted) => callRows(binding, model, admitted),
  });
  return binding;
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
