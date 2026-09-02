/**
 * Shared `@clack/prompts` mock for the CLI test suite — registered as a vitest
 * setupFile (see vitest.config.ts `setupFiles`) so it re-applies for EVERY test
 * file in a freshly-reset module registry.
 *
 * WHY A SETUP FILE (not a `vi.mock` inside `_harness.ts`):
 * `@clack/prompts` is external ESM. Under the `forks` pool (required because the
 * suite runs real PGlite, which does not work in worker threads), vitest reuses
 * a child process for multiple test files. A `vi.mock` hoisted inside an
 * imported harness module does NOT reliably re-intercept the already-evaluated
 * ESM clack module when a worker is reused for a second file — the REAL prompt
 * then loads and `p.confirm` blocks forever on stdin in the non-TTY runner,
 * hanging the whole directory run (observed: a rendered "Do you want to proceed
 * with this change?" box). A setupFile runs before each test file's imports in
 * that file's isolated context, so the mock is registered in time every time,
 * regardless of worker reuse.
 *
 * The mock is scriptable + capturable: `confirm` pulls from a per-test FIFO
 * answer queue (`queueAnswers`), and `outro`/`cancel`/`note` become silent
 * no-ops whose text is recorded into `clackLog` for output assertions. We mock
 * the *prompt library*, never the code under test.
 */

import { vi } from "vitest";

/** Sentinel returned by a queued answer to simulate Ctrl-C (p.isCancel true). */
export const CANCEL = Symbol.for("clack:cancel");

// Per-invocation queue of answers for confirm(). Consumed FIFO.
let answerQueue: unknown[] = [];
// Text emitted by clack (outro/note/cancel) for assertions.
let clackLog: string[] = [];

/** Queue the answers the next command's prompts will receive, in order. */
export function queueAnswers(answers: unknown[]): void {
  answerQueue = [...answers];
}

/** Snapshot the recorded clack lines (intro/outro/note/log/spinner text). */
export function getClackLog(): string[] {
  return [...clackLog];
}

/** Clear the recorded clack lines (called at the start of each invocation). */
export function resetClackLog(): void {
  clackLog = [];
}

function nextAnswer(fallback: unknown): unknown {
  if (answerQueue.length === 0) {
    return fallback;
  }
  return answerQueue.shift();
}

vi.mock("@clack/prompts", () => {
  const record = (...parts: unknown[]) => {
    clackLog.push(parts.map((x) => String(x)).join(" "));
  };
  return {
    isCancel: (v: unknown) => v === CANCEL,
    outro: (m: string) => record("outro", m),
    cancel: (m: string) => record("cancel", m),
    note: (message: string, title?: string) =>
      record("note", title ?? "", message),
    confirm: (opts: { initialValue?: boolean }) =>
      Promise.resolve(nextAnswer(opts.initialValue ?? true)),
  };
});
