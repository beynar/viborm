/**
 * `unit((u, next) => …, kinds?, options?)`: a function around each unit of
 * real work (an operation, a statement, a batch, a transaction, a savepoint,
 * a connection, a cache step). Observing is calling `next()` and reading how
 * the unit ended; what the handler throws fails the call. A part declared
 * `{ rewrites: true }` sends another statement: `next(sql)`.
 *
 * Until each kind of unit carries its own state, the part writes the members
 * the host reads (a temporary translation): `statement` for a part that
 * rewrites, `transaction` for the transaction units (`run(u, sql)` runs a
 * statement as the transaction opens), `observe` for every other kind.
 */
import type { Sql } from "@sql";
import { isFunction } from "@validation/value-guards";
import type {
  AnyTarget,
  EmptyFacts,
  Part,
  UnitContext,
  UnitKind,
  UnitOf,
  UnitOutcome,
} from "./contract";
import type { DefinitionDraft } from "./extension";
import { builtPart } from "./extension";
import type { ObservationCompletion, ObservationUnit } from "./observation";
import { observePart } from "./observation";
import { statementPart } from "./statement";
import { unitPart } from "./units";

/** What the unit words read of a unit, beside what `contract.ts` types. */
export class Unit implements UnitContext {
  readonly kind: UnitKind;
  readonly model: string | undefined;
  readonly operation: string | undefined;
  /** A statement unit before it is rewritten. */
  readonly statement: Sql | undefined;
  /** A transaction unit: runs a statement in the transaction as it opens. */
  readonly run:
    | ((statement: Sql) => Promise<readonly Record<string, unknown>[]>)
    | undefined;
  /** How the unit ended, once `next()` settled. */
  completion: ObservationCompletion | undefined;
  constructor(
    kind: UnitKind,
    model: string | undefined,
    operation: string | undefined,
    statement?: Sql,
    run?: (statement: Sql) => Promise<readonly Record<string, unknown>[]>
  ) {
    this.kind = kind;
    this.model = model;
    this.operation = operation;
    this.statement = statement;
    this.run = run;
    this.completion = undefined;
  }
}

type Handler = (
  unit: UnitContext,
  next: (sql?: Sql) => Promise<UnitOutcome>
) => unknown;

const SETTLED: UnitOutcome = Object.freeze({ status: "success", duration: 0 });

function rewriting(handler: Handler) {
  return (context: {
    readonly statement: Sql;
    readonly model: string | undefined;
    readonly operation: string;
  }): Sql => {
    let sent = context.statement;
    const unit = new Unit(
      "statement",
      context.model,
      context.operation,
      context.statement
    );
    const returned = handler(unit, (sql) => {
      if (sql !== undefined) sent = sql;
      return Promise.resolve(SETTLED);
    });
    // The rewrite is what `next(sql)` was handed, synchronously.
    if (returned instanceof Promise) returned.catch(() => undefined);
    return sent;
  };
}

function observing(handler: Handler, kinds: readonly UnitKind[] | undefined) {
  return (
    lifecycle: ObservationUnit,
    proceed: () => Promise<ObservationCompletion>
  ): unknown => {
    if (kinds !== undefined && !kinds.includes(lifecycle.kind))
      return proceed();
    const unit = new Unit(
      lifecycle.kind,
      "model" in lifecycle ? lifecycle.model : undefined,
      lifecycle.operation
    );
    return handler(unit, async () => {
      const completion = await proceed();
      unit.completion = completion;
      return {
        status: completion.status,
        duration: completion.durationMs,
        ...(completion.commitCertainty === undefined
          ? {}
          : { certainty: completion.commitCertainty }),
      };
    });
  };
}

function opening(handler: Handler) {
  return async (
    run: (statement: Sql) => Promise<readonly Record<string, unknown>[]>
  ): Promise<void> => {
    await handler(
      new Unit("transaction", undefined, undefined, undefined, run),
      () => Promise.resolve(SETTLED)
    );
  };
}

/** A function around each unit of the kinds named (every kind when absent). */
export function unit<
  T extends AnyTarget,
  Rewrites extends true | undefined = undefined,
>(
  around: (
    unit: UnitOf<Rewrites>,
    next: (sql?: Sql) => Promise<UnitOutcome>
  ) => unknown,
  kinds?: readonly UnitKind[],
  options?: { readonly rewrites?: Rewrites }
): Part<T, EmptyFacts>;
export function unit(
  handler: Handler,
  kinds?: readonly UnitKind[],
  options?: { readonly rewrites?: true }
): unknown {
  if (!isFunction(handler))
    throw new TypeError("unit() takes a function of the unit and its next");
  if (options?.rewrites === true)
    return builtPart([statementPart], (draft: DefinitionDraft) => {
      draft.statement = rewriting(handler);
    });
  const opens = kinds?.includes("transaction") === true;
  const others = kinds?.filter((kind) => kind !== "transaction");
  const observes = others === undefined || others.length > 0;
  return builtPart(
    [...(opens ? [unitPart] : []), ...(observes ? [observePart] : [])],
    (draft: DefinitionDraft) => {
      if (opens) draft.transaction = opening(handler);
      if (observes) draft.observe = observing(handler, others);
    }
  );
}
