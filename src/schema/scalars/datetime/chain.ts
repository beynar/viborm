// The chain the three temporal scalars share

import {
  generatorDefault,
  KeyedScalarChain,
  next,
  refuseListGenerator,
  type ScalarState,
  type scalarChain,
} from "../common";
import { currentTemporalValue, type TemporalKind } from "./current";

/** The value each generator of a kind writes: one closure per kind and generator. */
const generated = (kind: TemporalKind) => ({
  now: generatorDefault(() => currentTemporalValue(kind)),
  updatedAt: generatorDefault(() => currentTemporalValue(kind)),
});
const GENERATED = {
  datetime: generated("datetime"),
  date: generated("date"),
  time: generated("time"),
};

/** A generator writes one value: it cannot fill a list. */
const refuseList = (state: ScalarState) =>
  refuseListGenerator(
    `s.${state.type === "datetime" ? "dateTime" : state.type}`
  );

/** The chain of a scalar that can take the instant of the write. */
abstract class TemporalScalarChain extends KeyedScalarChain {
  #generated(kind: "now" | "updatedAt") {
    if (this.state.array) refuseList(this.state);
    return next(this, {
      hasDefault: true,
      autoGenerate: { kind },
      default: GENERATED[this.state.type as TemporalKind][kind],
      optional: true,
    });
  }
  override array() {
    const kind = this.state.autoGenerate?.kind;
    if (kind === "now" || kind === "updatedAt") refuseList(this.state);
    return super.array();
  }
  now() {
    return this.#generated("now");
  }
  updatedAt() {
    return this.#generated("updatedAt");
  }
}

export const temporalScalarChain =
  TemporalScalarChain as unknown as typeof scalarChain;
