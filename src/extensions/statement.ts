/**
 * The rewriting units of a chain (`unit(fn, kinds, { rewrites: true })`):
 * they run once per logical statement, before rendering, in chain order.
 * The statement's own `statement` unit runs later, around the provider call.
 * A chain with one is never served by the cache, and verbatim unsafe raw
 * queries are never rewritten.
 */
import { QueryError } from "@errors";
import type { Sql } from "@sql";
import type { ExtensionPart } from "./chain";
import { type UnitEnd, type UnitHandler, unitOf } from "./unit-source";

type Rewrite = (
  statement: Sql,
  model: string | undefined,
  operation: string
) => Sql;

/** A chain's rewriting units, and what applies them to one statement. */
export interface StatementHandlers {
  readonly rewrites: readonly Rewrite[];
  readonly apply: Rewrite;
}

const REWRITTEN: UnitEnd = Object.freeze({ status: "success", duration: 0 });

/**
 * One rewriting unit: `statement(unit)` reads the statement as the earlier
 * rewrites left it; `next(sql)`, called before the handler returns, hands on
 * what is sent (unchanged without an argument), and resolves at once.
 */
function rewriting(extension: string, handler: UnitHandler): Rewrite {
  return (statement, model, operation) => {
    let rewritten: Sql | undefined;
    let returned: unknown;
    try {
      returned = handler(
        unitOf({ kind: "statement", operation, model, statement }),
        (sql = statement) => {
          rewritten ??= sql;
          return Promise.resolve(REWRITTEN);
        }
      );
    } catch (cause) {
      throw rewriteFailure(extension, model, operation, "threw", cause);
    }
    // The rewrite is what `next(sql)` was handed, synchronously.
    if (returned instanceof Promise) returned.catch(() => undefined);
    if (rewritten === undefined)
      throw rewriteFailure(
        extension,
        model,
        operation,
        "returned without calling next()"
      );
    return rewritten;
  };
}

function rewriteFailure(
  extension: string,
  model: string | undefined,
  operation: string,
  failure: string,
  cause?: unknown
): QueryError {
  const identity = model === undefined ? operation : `${model}.${operation}`;
  return new QueryError(
    `Extension "${extension}" rewriting unit for ${identity} ${failure}.`,
    {
      ...(cause instanceof Error ? { cause } : {}),
      meta: { method: "unit", model, operation },
    }
  );
}

/** The host part of `unit(handler, kinds, { rewrites: true })`. */
export function rewritePart(handler: UnitHandler): ExtensionPart {
  return {
    join({ next, chain, owner }) {
      const rewrites = [
        ...(chain?.statement?.rewrites ?? []),
        rewriting(owner.name, handler),
      ];
      next.statement = {
        rewrites,
        apply: (statement, model, operation) => {
          let sent = statement;
          for (const rewrite of rewrites)
            sent = rewrite(sent, model, operation);
          return sent;
        },
      };
    },
  };
}
