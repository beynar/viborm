/**
 * The words a `unit` handler reads of its unit, each produced when it is
 * read: `statement(u)` (the statement before rewriting), `text(u)` and
 * `parameters(u)` (its text and values), `driver(u)`, `failure(u)` (how a
 * unit that failed ended) and `run(u, sql)` (a statement run in the
 * transaction a unit opens).
 */
import type { AnyDriver } from "@drivers/exports";
import type { Sql } from "@sql";
import type { UnitContext } from "./contract";
import { Unit } from "./unit";

const own = (u: UnitContext): Unit | undefined =>
  u instanceof Unit ? u : undefined;

/** A statement unit's statement, before any part rewrote it. */
export function statement(u: UnitContext): Sql | undefined {
  return own(u)?.statement;
}

/** A statement unit's text, as a statement holds it before rendering. */
export function text(u: UnitContext): string | undefined {
  return own(u)?.statement?.toStatement();
}

/** A statement unit's parameter values. */
export function parameters(u: UnitContext): readonly unknown[] | undefined {
  return own(u)?.statement?.values;
}

/**
 * The driver a unit runs on. Not produced yet for a unit a part observes
 * (the host hands it to the official instrumentation only).
 */
export function driver(_u: UnitContext): AnyDriver | undefined {
  return undefined;
}

/** How a unit that failed ended: its error's name, message and code. */
export function failure(
  u: UnitContext
):
  | { readonly name: string; readonly message: string; readonly code?: string }
  | undefined {
  return own(u)?.completion?.error;
}

/** Run a statement in the transaction the unit opens; its rows. */
export function run(
  u: UnitContext,
  statement: Sql
): Promise<readonly Record<string, unknown>[]> {
  const runner = own(u)?.run;
  if (runner === undefined)
    return Promise.reject(
      new TypeError("run(u, sql) runs in a transaction unit as it opens")
    );
  return runner(statement);
}
