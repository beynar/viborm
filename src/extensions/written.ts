// The `written` point: a definition is told the rows a write call wrote.
// The engine shows them (`@query-engine/write-sinks`); this is what a
// definition declares and how a chain's declarations watch one call.

import type { QueryExecutionContext } from "@drivers/types";
import { type WriteKind, writeSinks } from "@query-engine/write-sinks";

export type { WriteKind } from "@query-engine/write-sinks";

import type { ResolvedOperationHandler } from "./chain";
import { type AdmittedControls, controlsOwnedBy } from "./controls";
import {
  publishWriteOutcomes,
  type WriteOutcome,
  type WriteOutcomeRegistration,
} from "./query";

/** One write call, as `written` is asked about it before it runs. */
export interface WrittenCall {
  /** The model the call names. */
  readonly model: string;
  readonly operation: string;
  /**
   * The call's arguments, after request transforms and the client's omit.
   * They are the call's own: read, never changed.
   */
  readonly args: Readonly<Record<string, unknown>>;
  /** The call's controls this extension declares, and only those. */
  readonly controls?: AdmittedControls;
}

/** What watches one write call. */
export interface WrittenWatch {
  /**
   * Are the rows the call creates, updates or deletes in `model` to be
   * shown? Rows nobody wants are not read: a call nothing wants a row of
   * sends exactly the statements it sends unwatched.
   */
  wants(model: string, kind: WriteKind): boolean;
  /**
   * Rows the call wrote to `model`, each with every scalar field: as the
   * write left them, as they were before a delete. Told once every write of
   * the call is made and always before `settled`, the call's own rows first,
   * then those written through its relations (`nested`), in write order. The
   * values are the caller's too: copy what is kept.
   */
  rows(
    model: string,
    kind: WriteKind,
    rows: readonly Readonly<Record<string, unknown>>[],
    nested: boolean
  ): void;
  /**
   * The call's unit is durable, or may be: after the call's own commit, after
   * the outermost commit inside a transaction, never after a rollback.
   * Awaited before the call's promise (or the transaction's) settles; what
   * it throws rejects that promise, and the write stays made.
   */
  settled(outcome: WriteOutcome): unknown;
}

/**
 * A definition's `written`: asked once per write call, it answers with what
 * watches the call, or with nothing to leave the call exactly as it is.
 */
export type WrittenHandler = (call: WrittenCall) => WrittenWatch | undefined;

/**
 * One write call under a chain's `written` declarations: the engine is told
 * what they want to see, and the call's one outcome registration tells them,
 * after `cached`'s, that it settled. A unit handed over whole answers after
 * it commits: what watches is then told it settled once its rows are, by
 * what `late` receives, which the call's value runs and waits for.
 */
export function watchWrite(
  handlers: readonly ResolvedOperationHandler[],
  call: Omit<WrittenCall, "controls">,
  controls: AdmittedControls | undefined,
  context: QueryExecutionContext,
  cached: WriteOutcomeRegistration | undefined,
  late: (settle: () => Promise<void>) => void
): WriteOutcomeRegistration | undefined {
  const watches: WrittenWatch[] = [];
  const settled: WriteOutcomeRegistration[] = [];
  for (const { extension, handler, controls: own } of handlers) {
    const watch = (handler as WrittenHandler)(
      Object.freeze(
        own ? { ...call, controls: controlsOwnedBy(controls, own) } : call
      )
    );
    if (!watch) continue;
    watches.push(watch);
    settled.push({
      extension,
      listener: (outcome) => watch.settled(outcome),
    });
  }
  if (watches.length === 0) return cached;
  let told = false;
  let heard: WriteOutcome | undefined;
  const wants = (model: string, kind: WriteKind) =>
    watches.some((watch) => watch.wants(model, kind));
  writeSinks.set(context, {
    wants,
    attempt() {
      // What this run wrote, the call's own rows before those its relations reach.
      const shown: [string, WriteKind, readonly object[], boolean][] = [];
      return {
        wants,
        shows(model, kind, rows) {
          if (rows.length > 0) shown.push([model, kind, rows, true]);
        },
        own(queries, model, args, kinds) {
          const name = model["~"].names.ts!;
          if (!kinds.some((kind) => wants(name, kind))) return undefined;
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
        done() {
          for (const [model, kind, rows, nested] of shown)
            for (const watch of watches)
              if (watch.wants(model, kind))
                watch.rows(
                  model,
                  kind,
                  rows as Readonly<Record<string, unknown>>[],
                  nested
                );
          told = true;
          const outcome = heard;
          if (outcome) late(() => publishWriteOutcomes(settled, outcome));
        },
      };
    },
  });
  return Object.freeze({
    extension: settled[0]!.extension,
    // Each listener's failure is already said as its own.
    failurePolicy: "boundary-owned",
    listener(outcome: WriteOutcome) {
      if (told)
        return publishWriteOutcomes(
          cached ? [cached, ...settled] : settled,
          outcome
        );
      heard = outcome;
      return cached?.listener(outcome);
    },
  });
}
