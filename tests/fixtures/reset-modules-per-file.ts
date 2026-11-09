/**
 * The per-file reset Vitest 3's `singleFork` gave every file of a project.
 *
 * Vitest 3 ran a `singleFork` project's files in one child process and, before
 * each file, dropped every module that file's predecessor had evaluated and
 * every `vi.mock` it had registered. Vitest 4 spells `singleFork` as
 * `maxWorkers: 1, isolate: false` and performs that reset only for
 * `isolate: true`, which starts a fresh process per file instead and would not
 * fit the layer wall budgets. Setup files are re-evaluated before every file,
 * so this one, listed first, restores the reset: module state, registries and
 * mocks never leak from one file into the next. Modules Vitest externalizes
 * (`node_modules`) stay loaded, exactly as they did under `singleFork`.
 */
import { vi } from "vitest";

const { __vitest_mocker__: mocker } = globalThis as {
  __vitest_mocker__?: { reset(): void };
};
mocker?.reset();
vi.resetModules();
