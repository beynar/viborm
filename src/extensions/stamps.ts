/**
 * Default data: the fields `defaults` writes on the creates and updates that
 * leave them out. A field's value is a constant, the call's instant, or an
 * argument's value; only that last one is read per call.
 */
import {
  type ModelStamps,
  Parameter,
} from "@query-engine/raptor3/shared/row-scope";
import type { Input } from "@query-engine/raptor3/shared/schema";
import type { AdmittedControls } from "./controls";

/** The call's one instant, where a field writes `now`. */
export const NOW = /* @__PURE__ */ new Parameter();

const NO_VALUES = Object.freeze({ controls: {}, required: () => false });

/** Never read: a field naming an argument reads no instant. */
const instant = () => new Date();

/** Whether a field writes an argument's value, read per call. */
const named = (value: unknown): value is Parameter =>
  value instanceof Parameter && value.control !== undefined;

/** A stamp with its arguments' values put in: a field whose argument the call left out is not written. */
function boundStamp(
  stamp: Input | undefined,
  controls: AdmittedControls | undefined
): Input | undefined {
  if (stamp === undefined || !Object.values(stamp).some(named)) return stamp;
  const values = controls ? { ...NO_VALUES, controls } : NO_VALUES;
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(stamp)) {
    const given = named(value) ? value.read(values, instant) : value;
    if (given !== undefined) out[field] = given;
  }
  return Object.freeze(out);
}

/**
 * The chain's default data as a call writes it: the call's instant is a
 * parameter every call reads, and an argument's value is put in per call.
 */
export class Stamps {
  /** Per model (its TS name), the fields its creates and updates write. */
  readonly all: ReadonlyMap<string, ModelStamps>;
  /** A field names an argument: each call's stamps then hold its values. */
  readonly named: boolean;
  constructor(data: Readonly<Record<string, ModelStamps>>) {
    this.all = new Map(Object.entries(data));
    this.named = Object.values(data).some((entry) =>
      [entry.create, entry.update].some(
        (stamp) => stamp !== undefined && Object.values(stamp).some(named)
      )
    );
  }
  /** One call's stamps, from the arguments it admitted. */
  of(controls: AdmittedControls | undefined): ReadonlyMap<string, ModelStamps> {
    const bound = new Map<string, ModelStamps>();
    for (const [model, entry] of this.all) {
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
}
