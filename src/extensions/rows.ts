import { isCanonicalKeyData, stableStringify } from "@cache/key";
import type {
  CallRows,
  ModelDomain,
  ModelStamps,
  RowDomain,
  Stamp,
} from "@query-engine/raptor3/shared/row-scope";
import type { Input } from "@query-engine/raptor3/shared/schema";
import { isPlainRecord } from "@schema/relation/terminal";
import type { ResolvedDeletion } from "./chain";
import {
  type AdmittedControls,
  type RowsContribution,
  rowsModes,
} from "./controls";

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
 * looks its facts up. When the combination's predicates or the default ones
 * name a control, a call takes those facts with its values put in, kept per
 * combination and values. When a stamp names one, the call's values are put
 * in its stamps for that call alone: they take no room in that memo, so a
 * tenant keeps one domain whoever writes.
 */
export interface RowsBinding {
  readonly members: readonly BoundRowsMember[];
  readonly deletion: Readonly<Record<string, ResolvedDeletion>>;
  /** Indexed by mode combination: the call writes tombstones. */
  readonly tombstoning: readonly CallRows[];
  /** Indexed by mode combination: the call deletes physically. */
  readonly physical: readonly CallRows[];
  /**
   * Indexed by mode combination: the controls its domain and the default
   * domain name; empty when none does, and the call takes the facts above.
   */
  readonly references: readonly (readonly string[])[];
  /** Facts with a call's values put in, by combination and values. */
  readonly bound: Map<string, CallRows>;
  /** A stamp names a control: each call puts its values in the stamps. */
  readonly bindsStamps: boolean;
}

const NO_DELETION: Readonly<Record<string, ResolvedDeletion>> = Object.freeze(
  Object.create(null)
);

// ponytail: per-value memo, LRU if a tenant count above 256 is measured.
/** How many bound facts one chain keeps: past it, the oldest goes. */
const BOUND_LIMIT = 256;

/** A named control the call did not pass. */
const ABSENT = Symbol("absent");

/** The keys whose items are filters: a filter is never a reference. */
const LOGICAL = new Set(["AND", "OR", "NOT"]);

/** `{ control: "<name>" }` where a predicate takes a value. */
function referenceOf(value: unknown): string | undefined {
  if (!isPlainRecord(value)) return undefined;
  const [key, ...others] = Object.keys(value);
  return key === "control" &&
    others.length === 0 &&
    typeof value.control === "string"
    ? value.control
    : undefined;
}

/**
 * Every control a predicate's values name, at any depth. `filter` marks a
 * filter's place (the predicate, an item of `AND`/`OR`/`NOT`), where
 * `{ control }` is a field.
 */
function collectReferences(
  value: unknown,
  names: Set<string>,
  filter: boolean
): void {
  const name = filter ? undefined : referenceOf(value);
  if (name !== undefined) names.add(name);
  else if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, names, filter);
  } else if (isPlainRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      collectReferences(item, names, LOGICAL.has(key));
    }
  }
}

/** The controls a list of domains' predicates name. */
function referencesOf(domains: readonly RowDomain[]): readonly string[] {
  const names = new Set<string>();
  for (const { root, related } of domains) {
    for (const list of [...root.values(), ...related.values()]) {
      for (const where of list) collectReferences(where, names, true);
    }
  }
  return [...names];
}

/** The value with the call's values put in: itself when it names none. */
function boundValue(
  value: unknown,
  controls: AdmittedControls | undefined,
  filter: boolean
): unknown {
  const name = filter ? undefined : referenceOf(value);
  if (name !== undefined) {
    const given = controls?.[name];
    return given === undefined ? ABSENT : given;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => boundValue(item, controls, filter));
    if (items.includes(ABSENT)) return ABSENT;
    return items.every((item, index) => item === value[index]) ? value : items;
  }
  return isPlainRecord(value) ? boundWhere(value, controls) : value;
}

/**
 * One predicate with the call's values put in, or {@link ABSENT} when it names
 * a control the call did not pass: then it filters nothing, as a mode without
 * that predicate would.
 */
function boundWhere(
  where: Input,
  controls: AdmittedControls | undefined
): Input | typeof ABSENT {
  let copy: Input | undefined;
  for (const [key, item] of Object.entries(where)) {
    const value = boundValue(item, controls, LOGICAL.has(key));
    if (value === ABSENT) return ABSENT;
    if (value !== item) (copy ??= { ...where })[key] = value;
  }
  return copy ?? where;
}

/** Each model's predicates bound; the same map when none names a control. */
function boundModels(
  models: ModelDomain,
  controls: AdmittedControls | undefined
): ModelDomain {
  const bound = new Map<string, readonly Input[]>();
  let changed = false;
  for (const [model, list] of models) {
    const kept: Input[] = [];
    for (const where of list) {
      const value = boundWhere(where, controls);
      changed ||= value !== where;
      if (value !== ABSENT) kept.push(value);
    }
    if (kept.length > 0) bound.set(model, kept);
  }
  return changed ? bound : models;
}

/** A domain bound; the same object when no predicate names a control. */
function boundDomain(
  domain: RowDomain,
  controls: AdmittedControls | undefined
): RowDomain {
  const root = boundModels(domain.root, controls);
  const related = boundModels(domain.related, controls);
  return root === domain.root && related === domain.related
    ? domain
    : Object.freeze({ root, related });
}

/**
 * A stamp bound: a field whose value names a control the call did not pass is
 * not written, and stays the extension's (its owner is kept, so the call may
 * not write it either). The same object when no field names a control.
 */
function boundStamp(
  stamp: Stamp | undefined,
  controls: AdmittedControls | undefined
): Stamp | undefined {
  if (stamp === undefined) return undefined;
  const values: Record<string, unknown> = {};
  let changed = false;
  for (const [field, value] of Object.entries(stamp.values)) {
    const bound = boundValue(value, controls, false);
    changed ||= bound !== value;
    if (bound !== ABSENT) values[field] = bound;
  }
  return changed ? Object.freeze({ values, owners: stamp.owners }) : stamp;
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

function boundFacts(
  facts: CallRows,
  controls: AdmittedControls | undefined
): CallRows {
  const domain = boundDomain(facts.domain, controls);
  return Object.freeze({
    ...facts,
    domain,
    defaults:
      facts.defaults === facts.domain
        ? domain
        : boundDomain(facts.defaults, controls),
  });
}

/** One purpose's predicates per model, for one mode of every member. */
function modelDomain(
  rows: readonly RowsContribution[],
  modes: readonly string[],
  purpose: keyof Predicates
): ModelDomain {
  const domain = new Map<string, Record<string, unknown>[]>();
  for (const [index, member] of rows.entries()) {
    for (const [model, entry] of Object.entries(member.models)) {
      const where = entry[modes[index]!]?.[purpose];
      if (where === undefined) continue;
      const list = domain.get(model) ?? [];
      list.push(where);
      domain.set(model, list);
    }
  }
  return domain;
}

export function bindRows(
  rows: readonly RowsContribution[] | undefined,
  deletion: Readonly<Record<string, ResolvedDeletion>> | undefined,
  data?: Readonly<Record<string, ModelStamps>>
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
  const stamps = data === undefined ? undefined : new Map(Object.entries(data));
  const stampReferences = new Set<string>();
  for (const entry of stamps?.values() ?? []) {
    collectReferences(entry.create?.values, stampReferences, true);
    collectReferences(entry.update?.values, stampReferences, true);
  }
  const physical = domains.map((domain) =>
    Object.freeze({ domain, defaults, ...(stamps && { stamps }) })
  );
  return Object.freeze({
    members,
    deletion: deletion ?? NO_DELETION,
    physical,
    tombstoning:
      tombstones === undefined
        ? physical
        : physical.map((facts) => Object.freeze({ ...facts, tombstones })),
    references: domains.map((domain) => referencesOf([domain, defaults])),
    bound: new Map(),
    bindsStamps: stampReferences.size > 0,
  });
}

/**
 * One call's row facts, from the controls it admitted: the modes its `rows`
 * controls chose (an absent one reads as its default), and whether it deletes
 * physically — its model's `deletion` entry names a `removeWhen` the call's
 * controls match. That control is placed only on the deletes of the models
 * the entry manages, so no other call can match it. When a predicate or a
 * stamp names a control, the call's values are put in.
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
  const facts = domainFacts(binding, physical, combination, controls);
  return binding.bindsStamps
    ? Object.freeze({
        ...facts,
        stamps: boundStamps(facts.stamps!, controls),
      })
    : facts;
}

/** The combination's facts with the call's values put in its domains. */
function domainFacts(
  binding: RowsBinding,
  physical: boolean,
  combination: number,
  controls: AdmittedControls | undefined
): CallRows {
  const facts = (physical ? binding.physical : binding.tombstoning)[
    combination
  ]!;
  const references = binding.references[combination]!;
  if (references.length === 0) return facts;
  const values: Record<string, unknown> = {};
  for (const name of references) {
    if (controls?.[name] !== undefined) values[name] = controls[name];
  }
  // A value no key spells by its content (a Map keys as `{}`) is bound for
  // this call alone: it never takes another value's facts.
  if (!isCanonicalKeyData(values)) return boundFacts(facts, controls);
  const key = `${physical}${combination}${stableStringify(values)}`;
  let known = binding.bound.get(key);
  if (known === undefined) {
    if (binding.bound.size === BOUND_LIMIT) {
      binding.bound.delete(binding.bound.keys().next().value!);
    }
    // The facts outlive the call under a key spelling the values' content, so
    // they are bound from a copy: a caller who later mutates its Date or array
    // never changes what another call with equal values reads.
    known = boundFacts(facts, structuredClone(values));
    binding.bound.set(key, known);
  }
  return known;
}
