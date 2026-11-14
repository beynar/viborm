/**
 * Default data: the fields an extension writes on the creates and updates
 * that leave them out (`data`). A stamp's value is a constant, the call's
 * instant, or a control's value; only that last one needs a control, and
 * what admits controls comes with the part that declares them, never with
 * this one.
 */
import {
  type ModelStamps,
  Parameter,
} from "@query-engine/raptor3/shared/row-scope";
import type { Input } from "@query-engine/raptor3/shared/schema";
import { isPlainRecord } from "@schema/relation/terminal";
import { isInstant, isReference } from "./admission";
import { checkFields, eachModel, rebind, refuseUndeclared } from "./call-rows";
import type { ExtensionPart } from "./chain";
import type { AdmittedControls, DataContribution } from "./controls";
import { readOwn } from "./definition";
import { bindPlain } from "./plain-domain";

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

/** The call's one instant, where a stamp's field writes `{ now: true }`. */
const NOW = new Parameter();

/** A stamp with each `{ now: true }` field as {@link NOW}: itself without one. */
function withInstants(stamp: Input | undefined): Input | undefined {
  let copy: Record<string, unknown> | undefined;
  for (const [field, value] of Object.entries(stamp ?? {}))
    if (isInstant(value)) (copy ??= { ...stamp })[field] = NOW;
  return copy === undefined ? stamp : Object.freeze(copy);
}

/** Each model's stamps through `bind`: an entry it leaves alone is kept as is. */
function eachStamp(
  stamps: Iterable<readonly [string, ModelStamps]>,
  bind: (stamp: Input | undefined) => Input | undefined
): Map<string, ModelStamps> {
  const bound = new Map<string, ModelStamps>();
  for (const [model, entry] of stamps) {
    const create = bind(entry.create);
    const update = bind(entry.update);
    bound.set(
      model,
      create === entry.create && update === entry.update
        ? entry
        : Object.freeze({ create, update })
    );
  }
  return bound;
}

/**
 * The chain's `data`, as a call writes it: the call's instant is a parameter
 * every call reads, and a control's value is put in for each call.
 */
export class Stamps {
  /** Per model (its TS name), the fields its creates and updates write. */
  readonly all: ReadonlyMap<string, ModelStamps>;
  /** A stamp names a control: each call's stamps then hold its values. */
  readonly named: boolean;
  constructor(data: Readonly<Record<string, ModelStamps>>) {
    this.all = eachStamp(Object.entries(data), withInstants);
    const names = new Set<string>();
    for (const entry of this.all.values()) {
      collectStampReferences(entry.create, names);
      collectStampReferences(entry.update, names);
    }
    this.named = names.size > 0;
  }
  /** One call's stamps, from the controls it admitted. */
  of(controls: AdmittedControls | undefined): ReadonlyMap<string, ModelStamps> {
    return eachStamp(this.all, (stamp) => boundStamp(stamp, controls));
  }
}

/** One kind's fields with an extension's own merged in: it wins a field. */
function withStamp(
  previous: Input | undefined,
  fields: Readonly<Record<string, unknown>> | undefined
): Input | undefined {
  return fields === undefined
    ? previous
    : Object.freeze({ ...previous, ...fields });
}

function appendData(
  previous: Readonly<Record<string, ModelStamps>> | undefined,
  data: DataContribution
): Readonly<Record<string, ModelStamps>> {
  const entries: Record<string, ModelStamps> = Object.create(null);
  Object.assign(entries, previous);
  for (const [model, entry] of Object.entries(data.models)) {
    const known = entries[model];
    entries[model] = Object.freeze({
      create: withStamp(known?.create, entry.create),
      update: withStamp(known?.update, entry.update),
    });
  }
  return Object.freeze(entries);
}

/**
 * `data`: default data. The controls a stamp names are declared on the chain
 * by its own or an earlier extension, whose part brings what admits them.
 */
export const defaultDataPart: ExtensionPart = {
  members: ["data"],
  admit(application) {
    const extension = application.definition.name;
    eachModel(application, "data", (model, name, entry) => {
      checkFields(
        extension,
        `data.${name}`,
        model,
        readOwn(entry, "create", extension)
      );
      checkFields(
        extension,
        `data.${name}`,
        model,
        readOwn(entry, "update", extension)
      );
    });
  },
  join(application) {
    const { definition, chain, next } = application;
    const { data } = definition;
    if (data === undefined) return;
    const names = new Set<string>();
    for (const entry of Object.values(data.models)) {
      collectStampReferences(entry.create, names);
      collectStampReferences(entry.update, names);
    }
    refuseUndeclared(application, names);
    next.data = appendData(chain?.data, data);
    next.stamps = new Stamps(next.data);
  },
  seal(application) {
    rebind(application, bindPlain);
  },
};
