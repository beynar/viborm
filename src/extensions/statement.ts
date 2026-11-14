/**
 * The rewriting units of a chain (`unit(fn, kinds, { rewrites: true })`).
 * Each is a unit around one logical statement: `statement(unit)` reads the
 * statement as the earlier rewrites left it, `next(sql)` hands on what is
 * sent (unchanged without an argument), and resolves with how the statement
 * ended. Inside the innermost `next()` the statement is rendered and sent,
 * as its own `statement` unit around the provider call. A chain with one is
 * never served by the cache, and verbatim unsafe raw queries are never
 * rewritten.
 */
import type { Sql } from "@sql";
import type { ExtensionPart } from "./chain";
import { type Observation, observationOf } from "./observation";
import type { UnitHandler, UnitSource } from "./unit-source";

/** A chain's rewriting units, and what runs a logical statement under them. */
export interface StatementHandlers extends Observation {
  /**
   * The members of one batch, each its own logical statement: every member
   * is rewritten before `send` sends any (it receives each member's final
   * statement, `undefined` for a member with no unit), and each member's
   * unit then ends as the batch does. A member whose unit fails before its
   * `next()` refuses the batch: `refuse(index, failure)` is thrown.
   */
  readonly together: <Result>(
    members: readonly (UnitSource | undefined)[],
    send: (statements: readonly (Sql | undefined)[]) => Promise<Result>,
    refuse: (index: number, failure: unknown) => unknown
  ) => Promise<Result>;
}

/** The host part of `unit(handler, kinds, { rewrites: true })`. */
export function rewritePart(handler: UnitHandler): ExtensionPart {
  return {
    join({ next, chain, owner }) {
      const observation = observationOf([
        ...(chain?.statement?.handlers ?? []),
        { extension: owner.name, handler },
      ]);
      next.statement = {
        ...observation,
        together: async (members, send, refuse) => {
          const statements: (Sql | undefined)[] = [];
          const reached = new Set<number>();
          let settle: (outcome: Promise<unknown>) => void = () => undefined;
          const outcome = new Promise<unknown>((resolve) => {
            settle = resolve;
          });
          const units = members.map((source, index) => {
            if (source === undefined) return undefined;
            return observation.enter(source, (statement) => {
              statements[index] = statement;
              reached.add(index);
              return outcome;
            });
          });
          await Promise.all(units.map((unit) => unit?.reached));
          const done = Promise.all(units.map((unit) => unit?.done));
          const refused = units.findIndex(
            (unit, index) => unit !== undefined && !reached.has(index)
          );
          if (refused >= 0) {
            const failure = await units[refused]?.done.then(
              () => undefined,
              (error: unknown) => error
            );
            settle(Promise.reject(failure));
            await done.catch(() => undefined);
            throw refuse(refused, failure);
          }
          const sent = send(statements);
          settle(sent);
          // The send's failure is the call's, through `sent`; the units that
          // wait on `outcome` see it too, and where none started, nothing
          // else does.
          outcome.catch(() => undefined);
          try {
            const value = await sent;
            await done;
            return value;
          } finally {
            await done.catch(() => undefined);
          }
        },
      };
    },
  };
}
