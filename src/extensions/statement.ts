import type { RawSurface } from "@client/raw";
import type { Operations } from "@client/types";
import { QueryError } from "@errors";
import { isSql, type Sql } from "@sql";
import { isFunction, isRecord } from "@validation/value-guards";
import { isError } from "../errors/diagnostic-safety";
import type { ResolvedExtensionHandler } from "./chain";

/** The trusted identity exposed to one low-level statement transform. */
export interface StatementContext {
  readonly statement: Sql;
  readonly model: string | undefined;
  readonly operation: Operations | keyof RawSurface;
}

export type StatementHandler = (context: StatementContext) => Sql;

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
