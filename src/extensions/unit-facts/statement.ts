import type { Sql } from "@sql";
import { sourceOf, type Unit } from "../unit-source";

/**
 * For a unit that rewrites statements: the statement before its rewrite, to
 * hand on, changed or not, to `next(sql)`.
 */
export const statement = (unit: Unit): Sql | undefined =>
  sourceOf(unit)?.statement;
