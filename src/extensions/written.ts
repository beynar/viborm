// What watches the rows a write call wrote and its commit: `watch` and
// `settled` in a `call`'s first moment register a watch; the call's one
// outcome registration tells each watch that the write settled, and, for a
// watch made with `watch`, the engine shows the rows
// (`@query-engine/write-sinks`) through what that word brings (`showRows`).

import type { QueryExecutionContext } from "@drivers/types";
import { type WriteKind, writeSinks } from "@query-engine/write-sinks";

export type { WriteKind } from "@query-engine/write-sinks";

import type { AdmittedArgs } from "./arguments";
import type { CallOrigin } from "./origin";
import {
  type collect,
  publishWriteOutcomes,
  tell,
  type WriteOutcome,
  type WriteOutcomeRegistration,
} from "./query";

/** One write call, as what watches it is asked about before it runs. */
export interface WrittenCall {
  /** The model the call names. */
  readonly model: string;
  readonly operation: string;
  /**
   * The call's arguments, after request transforms and the client's omit.
   * They are the call's own: read, never changed.
   */
  readonly args: Readonly<Record<string, unknown>>;
  /** One object per call: what its first moments registered watches under. */
  readonly call?: CallOrigin;
}

/** Rows one write showed: model, kind, rows, and whether through a relation. */
type Shown = readonly [string, WriteKind, readonly object[], boolean];

/**
 * What asks the engine to show the rows a call writes, for one call: what
 * `watch` brings, so a call watched by `settled` alone carries none of it.
 * `told` receives the rows once every write of the call is made.
 */
export type ShowRows = (
  context: QueryExecutionContext,
  wants: (model: string, kind: WriteKind) => boolean,
  told: (shown: readonly Shown[]) => void
) => void;

/**
 * One write call under what its first moments registered, where one of them
 * asked for rows: what `watch` brings (`watchShown`), so a call watched by
 * `settled` alone is told its outcome and carries none of it.
 */
export type WatchShown = (
  watched: Watched,
  settled: readonly WriteOutcomeRegistration[],
  context: QueryExecutionContext,
  late: (settle: () => Promise<void>) => void
) => WriteOutcomeRegistration["listener"];

/**
 * What `watch(c, …)` and `settled(c, …)` register for one call: which rows
 * it wants shown and receives (every scalar field, as the write left them,
 * as they were before a delete; the call's own first, then those written
 * through its relations; the values are the caller's too), and what it is
 * told once the call's write is durable, or may be: after the call's own
 * commit, after the outermost commit inside a transaction, never after a
 * rollback, and after the rows of an extension that is shown any.
 */
export interface Watching {
  readonly wants?: (model: string, kind: WriteKind) => boolean;
  readonly rows?: (
    model: string,
    kind: WriteKind,
    rows: readonly Readonly<Record<string, unknown>>[],
    nested: boolean
  ) => void;
  readonly settled?: (outcome: WriteOutcome) => unknown;
  /** What shows the rows: what `watch` brings, never `settled`. */
  readonly show?: WatchShown;
  /** What installs a transaction's collector: what `settled` brings. */
  readonly collect?: typeof collect;
  /** What tells a raw statement's `settled` of its outcome: what `settled` brings. */
  readonly tell?: typeof tell;
}

/** What a write call's first moments registered, each with its extension, in chain order. */
export type Watched = (readonly [string, Watching])[];

/**
 * One write call under what its first moments registered: the call's one
 * outcome registration tells each `settled` that the write settled, and,
 * where a `watch` asked for rows, what that word brings shows them first
 * (`watchShown`).
 */
export function watchWrite(
  watched: Watched,
  context: QueryExecutionContext,
  late: (settle: () => Promise<void>) => void
): WriteOutcomeRegistration | undefined {
  if (watched.length === 0) return undefined;
  const settled: WriteOutcomeRegistration[] = [];
  for (const [extension, watching] of watched)
    if (watching.settled)
      settled.push({ extension, listener: watching.settled });
  return {
    extension: watched[0]![0],
    tell,
    // Each listener's failure is said as its own, an error of viborm's.
    listener:
      watched
        .find(([, watching]) => watching.show)?.[1]
        .show?.(watched, settled, context, late) ??
      ((outcome) => publishWriteOutcomes(settled, outcome)),
  };
}

/**
 * A write call some of whose watches asked for rows: the engine is told what
 * they want to see, and the call's one outcome registration tells them that
 * it settled. A unit handed over whole answers after it commits: what an
 * extension shown rows registered is then told it settled once its rows
 * are, by what `late` receives, which the call's value runs and waits for.
 */
export const watchShown: WatchShown = (watched, settled, context, late) => {
  const seeing = new Set<string>();
  for (const [extension, watching] of watched)
    if (watching.show) seeing.add(extension);
  const shown = settled.filter(({ extension }) => seeing.has(extension));
  const blind = settled.filter(({ extension }) => !seeing.has(extension));
  let told = false;
  let heard: WriteOutcome | undefined;
  const wants = (model: string, kind: WriteKind) =>
    watched.some(([, watching]) => watching.wants?.(model, kind) === true);
  showRows(context, wants, (rows) => {
    for (const [model, kind, written, nested] of rows)
      for (const [, watching] of watched)
        if (watching.wants?.(model, kind) === true)
          // The engine shows rows as it reads them: records of fields.
          watching.rows?.(
            model,
            kind,
            written as readonly Readonly<Record<string, unknown>>[],
            nested
          );
    told = true;
    const outcome = heard;
    if (outcome) late(() => publishWriteOutcomes(shown, outcome));
  });
  return (outcome) => {
    // A write that may have committed failed: no rows will be told.
    if (told || outcome.certainty === "may-have-committed")
      return publishWriteOutcomes(settled, outcome);
    heard = outcome;
    return publishWriteOutcomes(blind, outcome);
  };
};

/** The engine shows the rows of one call's writes that `wants` wants. */
export const showRows: ShowRows = (context, wants, told) => {
  writeSinks.set(context, {
    wants,
    attempt() {
      // What this run wrote, the call's own rows before those its relations reach.
      const shown: Shown[] = [];
      return {
        wants,
        shows(model, kind, rows) {
          if (rows.length > 0) shown.push([model, kind, rows, true]);
        },
        own(queries, model, args, kinds) {
          const name = model["~"].names.ts!;
          if (!kinds.some((kind) => wants(name, kind))) return undefined;
          // An operation's `select` is a record of fields where present.
          const select = args.select as Record<string, unknown> | undefined;
          const { scalars } = model["~"].state;
          // What the caller asked for beside the row's own fields: what its
          // selection names that is no scalar, and what it includes.
          const beside: Record<string, unknown> = {
            ...Object.fromEntries(
              Object.entries(select ?? {}).filter(
                ([field, selected]) =>
                  selected && !Object.hasOwn(scalars, field)
              )
            ),
            ...args.include,
          };
          return {
            // Whole rows, beside those.
            projection: queries.prepareProjection(
              model,
              Object.keys(beside).length > 0 ? { include: beside } : {}
            ),
            cut(rows, kind) {
              if (kind && wants(name, kind) && rows.length > 0)
                shown.unshift([
                  name,
                  kind,
                  rows.map((row) =>
                    Object.fromEntries(
                      Object.entries(row).filter(([field]) =>
                        Object.hasOwn(scalars, field)
                      )
                    )
                  ),
                  false,
                ]);
              if (select)
                for (const row of rows)
                  for (const field of Object.keys(row))
                    if (!(select[field] || Object.hasOwn(beside, field)))
                      delete row[field];
              return rows;
            },
          };
        },
        done: () => told(shown),
      };
    },
  });
};

/** What watches one write call under the chain's watching parts. */
export interface Watching {
  readonly watch: (
    call: WrittenCall,
    values: AdmittedArgs | undefined,
    context: QueryExecutionContext,
    late: (settle: () => Promise<void>) => void
  ) => WriteOutcomeRegistration | undefined;
}
