/**
 * One migration client composition root. V1 nouns only.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { type ApplyV1Result, applyV1 } from "./apply-v1";
import { type CheckResult, checkEstate } from "./check";
import { type GenerateV1Result, generateV1 } from "./generate-v1";
import { loadMigrationGraph } from "./graph";
import {
  baselineV1,
  downV1,
  logV1,
  resetV1,
  resolveV1,
  statusV1,
  verifyV1,
} from "./operators";
import type { MigrationClient } from "./push/planner";
import { type PushResultFor, pushV1 } from "./push-v1";
import type {
  MigrationStorageReader,
  MigrationStorageWriter,
} from "./storage/contract";
import { isMigrationStorageWriter } from "./storage/contract";
import type {
  ApplyV1Options,
  BaselineOptions,
  DownV1Options,
  ExactPushOptions,
  GenerateV1Options,
  LedgerEventV1,
  PushOptionsV1,
  ResetV1Options,
  ResolveV1Options,
  StateSelector,
} from "./v1-types";

export interface MigrationClientOptions {
  storage?: MigrationStorageReader | MigrationStorageWriter;
}

export interface Migrations {
  generate(options?: GenerateV1Options): Promise<GenerateV1Result>;
  check(): Promise<CheckResult>;
  list(): Promise<readonly { stateId: string; name: string }[]>;
  show(selector: StateSelector): Promise<{ stateId: string; name: string }>;
  graph(): Promise<{ roots: readonly string[]; leaves: readonly string[] }>;
  status(): Promise<Awaited<ReturnType<typeof statusV1>>>;
  verify(): Promise<{ ok: boolean }>;
  log(): Promise<readonly LedgerEventV1[]>;
  apply(options?: ApplyV1Options): Promise<ApplyV1Result>;
  down(options?: DownV1Options): Promise<Awaited<ReturnType<typeof downV1>>>;
  baseline(options: BaselineOptions): Promise<{ stateId: string }>;
  resolve(
    options: ResolveV1Options
  ): Promise<{ outcome: ResolveV1Options["outcome"] }>;
  reset(options?: ResetV1Options): Promise<Awaited<ReturnType<typeof resetV1>>>;
  push<O extends PushOptionsV1>(
    options?: ExactPushOptions<O>
  ): Promise<PushResultFor<O>>;
}

function requireStorage(
  storage: MigrationStorageReader | undefined
): MigrationStorageReader {
  if (!storage) {
    throw new MigrationError(
      "This command requires migration storage",
      VibORMErrorCode.MIGRATION_STORAGE_REQUIRED
    );
  }
  return storage;
}

function requireWriter(
  storage: MigrationStorageReader | undefined
): MigrationStorageWriter {
  const reader = requireStorage(storage);
  if (!isMigrationStorageWriter(reader)) {
    throw new MigrationError(
      "This command requires a storage writer",
      VibORMErrorCode.MIGRATION_STORAGE_REQUIRED
    );
  }
  return reader;
}

export function createMigrationClient(
  client: MigrationClient,
  options: MigrationClientOptions = {}
): Migrations {
  const storage = options.storage;
  return {
    generate: (generateOptions) =>
      generateV1(client, requireWriter(storage), generateOptions),
    check: () => checkEstate(requireStorage(storage)),
    list: async () => {
      const graph = await loadMigrationGraph(requireStorage(storage));
      return [...graph.states.values()].map((state) => ({
        stateId: state.stateId,
        name: state.name,
      }));
    },
    show: async (selector) => {
      const graph = await loadMigrationGraph(requireStorage(storage));
      const { resolveStateSelector } = await import("./graph");
      const id = resolveStateSelector(graph, selector);
      const state = graph.states.get(id)!;
      return { stateId: state.stateId, name: state.name };
    },
    graph: async () => {
      const loaded = await loadMigrationGraph(requireStorage(storage));
      return { roots: loaded.roots, leaves: loaded.leaves };
    },
    status: () => statusV1(client, requireStorage(storage)),
    verify: () => verifyV1(client, requireStorage(storage)),
    log: () => logV1(client),
    apply: (applyOptions) =>
      applyV1(client, requireStorage(storage), applyOptions),
    down: (downOptions) => downV1(client, requireStorage(storage), downOptions),
    baseline: (baselineOptions) =>
      baselineV1(client, requireStorage(storage), baselineOptions),
    resolve: (resolveOptions) =>
      resolveV1(client, requireStorage(storage), resolveOptions),
    reset: (resetOptions) =>
      resetV1(client, requireWriter(storage), resetOptions),
    push: (pushOptions) => pushV1(client, pushOptions),
  };
}
