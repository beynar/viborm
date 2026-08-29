/** One capability-sensitive migration client composition root. */

import { errorCause } from "../drivers/shared/driver-options";
import { MigrationError, VibORMErrorCode } from "../errors";
import { type ApplyV1Result, applyV1 } from "./apply-v1";
import { type CheckResult, checkEstate } from "./check";
import { type GenerateV1Result, generateV1 } from "./generate-v1";
import { loadMigrationGraph, resolveStateSelector } from "./graph";
import { snapshotExactRecord } from "./input-boundary";
import {
  baselineV1,
  downV1,
  logV1,
  resetV1,
  resolveV1,
  type StatusV1Result,
  statusV1,
  verifyV1,
} from "./operators";
import {
  type GraphResult,
  type ListResult,
  listMigrationStates,
  migrationGraphResult,
  type ShowResult,
  showMigrationState,
} from "./public-view";
import type { MigrationClient } from "./push/planner";
import { type PushResultFor, pushV1 } from "./push-v1";
import type {
  MigrationStorageReader,
  MigrationStorageWriter,
} from "./storage/contract";
import {
  isMigrationStorageReader,
  isMigrationStorageWriter,
} from "./storage/contract";
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

export interface MigrationClientOptions<
  S extends MigrationStorageReader = MigrationStorageReader,
> {
  readonly storage: S;
}

type NoExtraMigrationClientOptionKeys<Given> = Record<
  Exclude<keyof Given, "storage">,
  never
>;

export type GenerateResult = GenerateV1Result;
export type StatusResult = StatusV1Result;
export interface VerifyResult {
  readonly ok: boolean;
}
export type LogResult = readonly LedgerEventV1[];
export type ApplyResult = ApplyV1Result;
export interface DownResult {
  readonly path: readonly string[];
  readonly preview: boolean;
}
export interface BaselineResult {
  readonly stateId: string;
}
export interface ResolveResult {
  readonly outcome: ResolveV1Options["outcome"];
}
export interface ResetResult {
  readonly preview: boolean;
  readonly path: readonly string[];
}
export interface LiveMigrations {
  log(): Promise<LogResult>;
  push<O extends PushOptionsV1>(
    options?: ExactPushOptions<O>
  ): Promise<PushResultFor<O>>;
}

export interface ReadableMigrations extends LiveMigrations {
  check(): Promise<CheckResult>;
  list(): Promise<ListResult>;
  show(selector: StateSelector): Promise<ShowResult>;
  graph(): Promise<GraphResult>;
  status(): Promise<StatusResult>;
  verify(): Promise<VerifyResult>;
  apply(options?: ApplyV1Options): Promise<ApplyResult>;
  down(options?: DownV1Options): Promise<DownResult>;
  baseline(options: BaselineOptions): Promise<BaselineResult>;
  resolve(options: ResolveV1Options): Promise<ResolveResult>;
}

export interface WritableMigrations extends ReadableMigrations {
  generate(options?: GenerateV1Options): Promise<GenerateResult>;
  reset(options?: ResetV1Options): Promise<ResetResult>;
}

export function createMigrationClient<
  Options extends MigrationClientOptions<MigrationStorageWriter>,
>(
  client: MigrationClient,
  options: Options & NoExtraMigrationClientOptionKeys<Options>
): WritableMigrations;
export function createMigrationClient<
  Options extends MigrationClientOptions<MigrationStorageReader>,
>(
  client: MigrationClient,
  options: Options & NoExtraMigrationClientOptionKeys<Options>
): ReadableMigrations;
export function createMigrationClient(
  client: MigrationClient,
  options?: undefined
): LiveMigrations;
export function createMigrationClient(
  client: MigrationClient,
  options?: MigrationClientOptions
): LiveMigrations | ReadableMigrations | WritableMigrations {
  const live: LiveMigrations = Object.freeze({
    log: () => logV1(client),
    push<O extends PushOptionsV1>(
      pushOptions?: ExactPushOptions<O>
    ): Promise<PushResultFor<O>> {
      return pushV1(client, pushOptions);
    },
  });
  if (options === undefined) return live;
  const record = snapshotExactRecord(
    options,
    ["storage"],
    "migration client options",
    refuseClientOptions
  );
  const storage = record.storage;
  if (storage === undefined) {
    return refuseClientOptions(
      "migration client options must include storage when supplied"
    );
  }
  let readableStorage: MigrationStorageReader;
  try {
    if (!isMigrationStorageReader(storage)) {
      return refuseClientOptions(
        "migration client storage must implement MigrationStorageReader"
      );
    }
    readableStorage = storage;
  } catch (failure) {
    return refuseClientOptions(
      "migration client storage could not be inspected",
      errorCause(failure)
    );
  }

  const readable: ReadableMigrations = Object.freeze({
    ...live,
    check: () => checkEstate(readableStorage),
    list: async () =>
      listMigrationStates(await loadMigrationGraph(readableStorage)),
    show: async (selector) => {
      const graph = await loadMigrationGraph(readableStorage);
      return showMigrationState(graph, resolveStateSelector(graph, selector));
    },
    graph: async () =>
      migrationGraphResult(await loadMigrationGraph(readableStorage)),
    status: () => statusV1(client, readableStorage),
    verify: () => verifyV1(client, readableStorage),
    apply: (applyOptions) => applyV1(client, readableStorage, applyOptions),
    down: (downOptions) => downV1(client, readableStorage, downOptions),
    baseline: (baselineOptions) =>
      baselineV1(client, readableStorage, baselineOptions),
    resolve: (resolveOptions) =>
      resolveV1(client, readableStorage, resolveOptions),
  });
  let writableStorage: MigrationStorageWriter;
  try {
    if (!isMigrationStorageWriter(readableStorage)) return readable;
    writableStorage = readableStorage;
  } catch (failure) {
    return refuseClientOptions(
      "migration client storage could not be inspected",
      errorCause(failure)
    );
  }

  return Object.freeze({
    ...readable,
    generate: (generateOptions) =>
      generateV1(client, writableStorage, generateOptions),
    reset: (resetOptions) => resetV1(client, writableStorage, resetOptions),
  });
}

function refuseClientOptions(message: string, cause?: Error): never {
  throw new MigrationError(message, VibORMErrorCode.INVALID_INPUT, { cause });
}
