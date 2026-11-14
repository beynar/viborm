import { sourceOf, type Unit } from "../unit-source";

/** The SQL name of the model an `operation` unit addresses. */
export const table = (unit: Unit): string | undefined => sourceOf(unit)?.table;
