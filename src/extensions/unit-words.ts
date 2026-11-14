/**
 * The words a `unit` handler reads of its unit, each a top-level function
 * that reads what the unit's producer already holds, when it is called: a
 * fact nobody reads is never computed, and a word a program does not import
 * is not in its bundle.
 */
import { snapshotDiagnosticParameters } from "@drivers/driver-diagnostics";
import {
  type DriverIdentity,
  readDriverIdentity,
} from "@drivers/driver-identity";
import { QueryError } from "@errors";
import type { Sql } from "@sql";
import { errorOrigin } from "../errors/logged-errors";
import type { UnitContext } from "./contract";
import { originOf, sourceOf } from "./unit-source";

/**
 * The text a `statement` unit sends, as rendered for its driver; a native
 * batch's texts joined by `"; "`. The text of a verbatim unsafe raw query
 * too: it is never rewritten, but it is observed.
 */
export const text = (u: UnitContext): string | undefined => sourceOf(u)?.sql;

/**
 * A bounded snapshot of the parameters a `statement` unit sends; for a
 * native batch, one list per member. Read it before `next()`: a provider may
 * change what it was handed. Each read takes its own snapshot.
 */
export function parameters(u: UnitContext): readonly unknown[] | undefined {
  const source = sourceOf(u);
  if (source?.batch !== undefined)
    return source.batch.map((member) =>
      snapshotDiagnosticParameters(member.params ?? [])
    );
  return source?.params === undefined
    ? undefined
    : snapshotDiagnosticParameters(source.params);
}

/**
 * The dialect, name and SQL namespace of the driver doing a unit's work;
 * `undefined` for a unit with no driver, or when a custom adapter's
 * `namespace` getter throws.
 */
export function driver(u: UnitContext): DriverIdentity | undefined {
  const source = sourceOf(u)?.driver;
  return source === undefined ? undefined : readDriverIdentity(source);
}

/** What a unit's child failed with, once `next()` settled; else `undefined`. */
export const failure = (u: UnitContext): unknown => sourceOf(u)?.failure;

/** The identity of the logical call a unit belongs to. */
export const correlation = (u: UnitContext): string | undefined =>
  sourceOf(u)?.context?.correlationId;

/** The SQL name of the model an `operation` unit addresses. */
export const table = (u: UnitContext): string | undefined =>
  sourceOf(u)?.table;

/** One member of a native batch, as `statements(u)` gives it. */
export interface BatchMember {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly model?: string;
  readonly operation?: string;
  readonly correlation?: string;
}

/**
 * The members of a `statement` unit that sends a native batch, in order;
 * `undefined` for a unit that sends one statement. A failure that names a
 * member carries its index (`meta.statementIndex`).
 */
export function statements(
  u: UnitContext
): readonly BatchMember[] | undefined {
  return sourceOf(u)?.batch?.map(({ sql, params, context }) => ({
    sql,
    parameters: snapshotDiagnosticParameters(params ?? []),
    ...(context?.model === undefined ? {} : { model: context.model }),
    ...(context?.operation === undefined
      ? {}
      : { operation: context.operation }),
    ...(context?.correlationId === undefined
      ? {}
      : { correlation: context.correlationId }),
  }));
}

/**
 * The first error of a line of successors the package made from it (a clone
 * that adds execution context or commit certainty); the error itself when it
 * has none. Two units that fail with errors of one origin failed once.
 */
export const origin = (error: unknown): unknown => errorOrigin(error);

/**
 * For a unit that rewrites statements: the statement before its rewrite, to
 * hand on, changed or not, to `next(sql)`.
 */
export const statement = (u: UnitContext): Sql | undefined =>
  sourceOf(u)?.statement;

/**
 * For a `transaction` unit: runs `sql` in the transaction and gives its
 * rows. Called before `next()`, it opens the transaction and runs before
 * anything else does; the transaction's body waits for the innermost
 * `next()`. A savepoint is no transaction.
 */
export function run(
  u: UnitContext,
  sql: Sql
): Promise<readonly Record<string, unknown>[]> {
  const send = sourceOf(u)?.run;
  return send === undefined
    ? Promise.reject(
        new QueryError("run() needs the transaction unit a handler received.")
      )
    : send(sql);
}

/**
 * Attach a fact to a unit that is still running: `target` is a unit (one a
 * handler received, or `work` made), or a call's `run`, which notes on the
 * call's `operation` unit. `false` when there is no such unit, or it has
 * settled (where no handler runs around a unit, nothing would read it).
 */
export function note(target: object, fact: unknown): boolean {
  const source = originOf(target);
  if (source === undefined || source.failed !== undefined) return false;
  source.notes?.push(fact);
  return true;
}

/** The facts noted on a unit, in order. */
export const notes = (u: UnitContext): readonly unknown[] =>
  sourceOf(u)?.notes ?? [];
