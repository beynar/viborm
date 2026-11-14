import type { RawSurface } from "@client/raw";
import type { Operations } from "@client/types";
import { QueryError } from "@errors";
import { isSql, type Sql } from "@sql";
import { isFunction, isRecord } from "@validation/value-guards";
import { isError } from "../errors/diagnostic-safety";
import type { ExtensionPart, ResolvedExtensionHandler } from "./chain";
import { type Unit, unitOf } from "./unit-source";

/** The trusted identity exposed to one low-level statement transform. */
export interface StatementContext {
  readonly statement: Sql;
  readonly model: string | undefined;
  readonly operation: Operations | keyof RawSurface;
}

export type StatementHandler = (context: StatementContext) => Sql;

/** A unit declared `{ rewrites: true }`: `next(sql)` sends `sql` instead. */
export type RewritingHandler = (
  unit: Unit,
  next: (statement?: Sql) => undefined
) => unknown;

/**
 * A rewriting unit as the `statement` member runs it: once per logical
 * statement, before rendering, in chain order. `statement(unit)` reads the
 * statement as the earlier rewrites left it; `next(sql)`, called once and
 * before the handler returns, hands on what is sent (unchanged without an
 * argument). Rewriting units do not observe: the statement's own unit runs
 * later, around the provider call.
 */
export function rewritingUnit(handler: RewritingHandler): StatementHandler {
  return (context) => {
    let rewritten: Sql | undefined;
    handler(
      unitOf({
        kind: "statement",
        operation: context.operation,
        model: context.model,
        statement: context.statement,
      }),
      (statement = context.statement) => {
        rewritten ??= statement;
        return undefined;
      }
    );
    if (rewritten === undefined)
      throw new TypeError("A rewriting unit returned without calling next().");
    return rewritten;
  };
}

/**
 * Applies resolved statement transforms before placeholder rendering.
 *
 * The empty path is deliberately an identity path: it does not inspect the
 * statement and does not allocate a context.
 */
export function applyStatementTransforms(
  statement: Sql,
  model: string | undefined,
  operation: string,
  transforms: readonly ResolvedExtensionHandler[] | undefined
): Sql {
  if (transforms === undefined || transforms.length === 0) return statement;

  let transformedStatement = statement;
  for (const transform of transforms) {
    const context = Object.freeze({
      statement: transformedStatement,
      model,
      operation,
    });

    let transformed: unknown;
    try {
      transformed = Reflect.apply(transform.handler, undefined, [context]);
    } catch (reason) {
      throw statementTransformFailure(
        transform.extension,
        model,
        operation,
        "threw",
        normalizeThrown(reason)
      );
    }

    try {
      if (isSql(transformed)) {
        const toStatement = Reflect.get(transformed, "toStatement");
        if (!isFunction(toStatement)) {
          throw new TypeError(
            "Statement transform returned a Sql value without a callable toStatement method"
          );
        }
        const rendered = Reflect.apply(toStatement, transformed, ["?"]);
        if (typeof rendered !== "string") {
          throw new TypeError(
            "Statement transform returned a Sql value whose toStatement method did not return a string"
          );
        }
        transformedStatement = transformed;
        continue;
      }
    } catch (reason) {
      throw statementTransformFailure(
        transform.extension,
        model,
        operation,
        "returned an unreadable value",
        normalizeUnreadableReturn(reason)
      );
    }

    let thenable: boolean;
    try {
      thenable = isThenable(transformed);
    } catch (reason) {
      throw statementTransformFailure(
        transform.extension,
        model,
        operation,
        "returned an unreadable value",
        normalizeUnreadableReturn(reason)
      );
    }

    const failure = thenable
      ? "returned a promise or thenable"
      : "returned a non-Sql value";
    throw statementTransformFailure(
      transform.extension,
      model,
      operation,
      failure,
      new TypeError(`Statement transform ${failure}`)
    );
  }

  return transformedStatement;
}

function isThenable(value: unknown): boolean {
  if (!(isRecord(value) || isFunction(value))) return false;
  return isFunction(Reflect.get(value, "then"));
}

function normalizeThrown(reason: unknown): Error {
  return isError(reason)
    ? reason
    : new Error("Statement transform threw a non-Error value");
}

function normalizeUnreadableReturn(reason: unknown): Error {
  return isError(reason)
    ? reason
    : new Error("Statement transform returned an unreadable value");
}

function statementTransformFailure(
  extension: string,
  model: string | undefined,
  operation: string,
  failure: string,
  cause: Error
): QueryError {
  const identity = model === undefined ? operation : `${model}.${operation}`;
  return new QueryError(
    `Extension "${extension}" statement handler for ${identity} ${failure}.`,
    {
      cause,
      meta: { method: "statement", model, operation },
    }
  );
}

/** A chain's statement transforms, and what applies them to one statement. */
export interface StatementHandlers {
  readonly handlers: readonly ResolvedExtensionHandler[];
  readonly apply: (
    statement: Sql,
    model: string | undefined,
    operation: string
  ) => Sql;
}

/** `statement`: a rewrite of each statement before it is sent. */
export const statementPart: ExtensionPart = {
  members: ["statement"],
  join({ next, chain, definition, owner }) {
    if (definition.statement === undefined) return;
    const handlers = Object.freeze([
      ...(chain?.statement?.handlers ?? []),
      Object.freeze({ extension: owner.name, handler: definition.statement }),
    ]);
    next.statement = Object.freeze({
      handlers,
      apply: (statement: Sql, model: string | undefined, operation: string) =>
        applyStatementTransforms(statement, model, operation, handlers),
    });
  },
};
