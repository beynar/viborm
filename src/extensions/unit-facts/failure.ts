import { sourceOf, type Unit } from "../unit-source";

/** What a unit's child failed with, once `next()` settled; else `undefined`. */
export const failure = (unit: Unit): unknown => sourceOf(unit)?.failure;
