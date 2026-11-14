import { sourceOf, type Unit } from "../unit-source";

/** The identity of the logical call a unit belongs to. */
export const correlation = (unit: Unit): string | undefined =>
  sourceOf(unit)?.context?.correlationId;
