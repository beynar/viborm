import type { BatchQuery } from "@drivers";
import { ASSERTION_MARKER } from "@drivers/error-mapping";

/**
 * The leading keyword of a statement that CHANGES committed state. Anchored at
 * the start deliberately: a planning read can carry the word `UPDATE` inside it
 * (`SELECT … FOR UPDATE` is the locked probe transaction mode emits), and a
 * substring test would read that as a write and open the injection window one
 * batch too early — the exact class of mistake this predicate exists to end.
 */
const WRITE_STATEMENT = /^\s*(?:insert|update|delete)\b/i;

/**
 * Is this driver batch the operation's compiled ATOMIC UNIT rather than one
 * level of its planning reads?
 *
 * Every one-shot staleness-injection hook in this estate documents its window
 * as "between planning and the atomic batch". It USED to implement that as
 * "fire on the first `executeBatch` call", which was the same thing only while
 * planning reads travelled one `_execute` at a time. PLAN Phase 6.1 groups the
 * planning reads by dependency level and sends a multi-read level through
 * `_executeBatch`, so "the first batch" and "the atomic unit" are no longer the
 * same call — and a hook keyed on the first batch would inject its concurrent
 * mutation BEFORE planning, never opening the window the test is about.
 *
 * The unit is recognised by what only `compileToEntries` can put in a batch:
 * a WRITE, or a guard assertion (the `__viborm_assert__` alias every adapter's
 * `assertions.exists`/`notExists` carries). A planning level is correlated
 * SELECTs and nothing else, so it matches neither.
 *
 * Both halves are load-bearing, and the second is not redundant with the first:
 * an upsert whose `targetWhere`/`setWhere` conditional does not match compiles
 * to a DELIBERATE no-op unit — `[notExists guard, terminal read]`, no write at
 * all — and the skip-premise pin those tests attack lives in exactly that
 * write-free batch. A "contains a write" test alone stops injecting there,
 * which silently deletes the race coverage instead of relocating it.
 */
export function batchIsAtomicUnit(queries: readonly BatchQuery[]): boolean {
  return queries.some(
    (query) =>
      WRITE_STATEMENT.test(query.sql) || query.sql.includes(ASSERTION_MARKER)
  );
}
