import { sourceOf, type Unit } from "../unit-source";

/**
 * The text a `statement` unit sends, as rendered for its driver; a native
 * batch's texts joined by `"; "`. The text of a verbatim unsafe raw query
 * too: it is never rewritten, but it is observed.
 */
export const text = (unit: Unit): string | undefined => sourceOf(unit)?.sql;
