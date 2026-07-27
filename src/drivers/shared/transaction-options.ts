/**
 * Public transaction options: parse once, resolve against the driver's declared
 * capability, then either honor or refuse. Never accept-and-ignore.
 *
 * Two error classes, split on cause and used consistently everywhere:
 *
 * - `TransactionError` / `V5005 INVALID_TRANSACTION_INPUT` — the options object
 *   itself is malformed (not an object, unknown key, unknown isolation level,
 *   non-positive timeout). The caller wrote something meaningless.
 * - `UnsupportedOperationError` / `V8003 UNSUPPORTED_OPERATION` — the options
 *   are well formed but this driver (or this `$transaction` form) cannot honor
 *   them. The caller wrote something meaningful that we refuse to fake.
 *
 * Timeout and max-wait *expiry* are neither: they are runtime transaction
 * failures and surface as `TransactionError` / `V5002 TRANSACTION_TIMEOUT`.
 */

import {
  TransactionError,
  UnsupportedOperationError,
  VibORMErrorCode,
} from "@errors";

/** Prisma's isolation-level spellings, exactly. */
export const TRANSACTION_ISOLATION_LEVELS = [
  "ReadUncommitted",
  "ReadCommitted",
  "RepeatableRead",
  "Serializable",
] as const;

export type TransactionIsolationLevel =
  (typeof TRANSACTION_ISOLATION_LEVELS)[number];

/** Options accepted by the interactive (callback) `$transaction` form. */
export interface TransactionOptions {
  /** Isolation level for the transaction. */
  isolationLevel?: TransactionIsolationLevel;
  /** Milliseconds the callback body may run before rollback. */
  timeout?: number;
  /** Milliseconds to wait for a transaction slot before giving up. */
  maxWait?: number;
}

/**
 * Options accepted by the sequential (array) `$transaction` form. Prisma's
 * sequential API takes `isolationLevel` only: an array has no interactive
 * window for `timeout` to bound, so neither client offers it there.
 */
export interface BatchTransactionOptions {
  isolationLevel?: TransactionIsolationLevel;
}

/** Where a driver must emit `SET TRANSACTION ISOLATION LEVEL`, if anywhere. */
export type IsolationLevelPlacement =
  /** PostgreSQL family: first statement *inside* the open transaction. */
  | "post-begin"
  /** MySQL family: on the transaction's own connection *before* BEGIN. */
  | "pre-begin"
  /** SQLite family: serializable by construction; nothing to emit. */
  | "serializable-only"
  /** No transaction is opened, so there is nothing to configure. */
  | "unsupported";

/** How a driver can bound the wait for a transaction slot. */
export type MaxWaitSupport =
  /** The driver serializes transactions through a queue we can bound. */
  | "queue"
  /** The driver acquires a pooled connection it can abandon and release. */
  | "acquisition"
  /** No wait we own, or no wait at all. */
  | "unsupported";

/**
 * A driver's honest answer for each option. Every advertised driver declares
 * one; `tests/drivers/transaction-portability.test.ts` pins every cell.
 */
export interface TransactionOptionSupport {
  readonly isolationLevel: IsolationLevelPlacement;
  /**
   * Why this driver cannot honor the levels it refuses. Required whenever
   * `isolationLevel` is not `"post-begin"` or `"pre-begin"`, so a refusal
   * always names its reason instead of just saying "no".
   */
  readonly isolationLevelReason?: string;
  /** Whether the callback body can be raced against a timer and rolled back. */
  readonly timeout: boolean;
  /** Why `timeout` cannot be honored. Required when `timeout` is false. */
  readonly timeoutReason?: string;
  readonly maxWait: MaxWaitSupport;
  /** Why `maxWait` cannot be honored. Required when `maxWait` is unsupported. */
  readonly maxWaitReason?: string;
}

/** The `$transaction` form the options were passed to. */
export type TransactionForm = "callback" | "batch";

export interface TransactionOptionContext {
  readonly driverName: string;
  readonly form: TransactionForm;
}

/** What the driver layer must act on. `timeout` never reaches a driver. */
export interface DriverTransactionOptions {
  /** Set only when the driver's placement is `"pre-begin"`. */
  readonly isolationLevel?: TransactionIsolationLevel;
  /** Set only when the driver's max-wait mode is `"acquisition"`. */
  readonly maxWaitMs?: number;
}

/** The honored shape of a validated, driver-accepted options object. */
export interface TransactionPlan {
  readonly isolationLevel?: TransactionIsolationLevel;
  /** `SET TRANSACTION ISOLATION LEVEL ...`, when the driver emits SQL. */
  readonly isolationStatement?: string;
  readonly isolationPlacement: IsolationLevelPlacement;
  readonly timeoutMs?: number;
  readonly maxWaitMs?: number;
  readonly maxWaitMode: MaxWaitSupport;
  /** The subset the driver's own `transaction()` must act on. */
  readonly driverOptions?: DriverTransactionOptions;
}

const methodForForm = (form: TransactionForm): string =>
  form === "batch" ? "$transaction([...])" : "$transaction(callback)";

function invalidTransactionOptions(
  message: string,
  context: TransactionOptionContext
): TransactionError {
  return new TransactionError(message, {
    code: VibORMErrorCode.INVALID_TRANSACTION_INPUT,
    meta: { driver: context.driverName, method: methodForForm(context.form) },
  });
}

function refuseTransactionOption(
  option: string,
  reason: string,
  context: TransactionOptionContext
): UnsupportedOperationError {
  return new UnsupportedOperationError(
    `Driver "${context.driverName}" cannot honor the "${option}" transaction option on ${methodForForm(context.form)}: ${reason}`,
    {
      meta: {
        driver: context.driverName,
        method: methodForForm(context.form),
      },
    }
  );
}

/** A transaction whose body outran its `timeout`. */
export function transactionTimeoutError(
  timeoutMs: number,
  context: TransactionOptionContext
): TransactionError {
  return new TransactionError(
    `Transaction on driver "${context.driverName}" exceeded its timeout of ${timeoutMs}ms and was rolled back.`,
    {
      code: VibORMErrorCode.TRANSACTION_TIMEOUT,
      meta: { driver: context.driverName, method: methodForForm(context.form) },
    }
  );
}

/** A transaction that never started because it outwaited its `maxWait`. */
export function transactionMaxWaitError(
  maxWaitMs: number,
  context: TransactionOptionContext
): TransactionError {
  return new TransactionError(
    `Transaction on driver "${context.driverName}" waited longer than maxWait (${maxWaitMs}ms) for a transaction slot and never started.`,
    {
      code: VibORMErrorCode.TRANSACTION_TIMEOUT,
      meta: { driver: context.driverName, method: methodForForm(context.form) },
    }
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIsolationLevel = (value: unknown): value is TransactionIsolationLevel =>
  TRANSACTION_ISOLATION_LEVELS.includes(value as TransactionIsolationLevel);

function readDurationOption(
  raw: unknown,
  option: string,
  context: TransactionOptionContext
): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw invalidTransactionOptions(
      `Transaction option "${option}" must be a positive finite number of milliseconds.`,
      context
    );
  }
  return raw;
}

/**
 * Validate the raw second argument of `$transaction`. Unknown keys are rejected
 * rather than dropped: a misspelled option must never look like it took effect.
 */
export function parseTransactionOptions(
  raw: unknown,
  context: TransactionOptionContext
): TransactionOptions | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw invalidTransactionOptions(
      "Transaction options must be an object.",
      context
    );
  }

  const allowed =
    context.form === "batch"
      ? ["isolationLevel"]
      : ["isolationLevel", "timeout", "maxWait"];
  // `Reflect.ownKeys`, not `Object.keys`: a symbol-keyed property is still
  // something the caller put there, and dropping it silently would be exactly
  // the accept-and-ignore this boundary exists to prevent.
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key === "string" && allowed.includes(key)) continue;
    if (context.form === "batch" && (key === "timeout" || key === "maxWait")) {
      throw invalidTransactionOptions(
        `Transaction option "${key}" is not available on $transaction([...]): an array of operations has no interactive window to bound. Use the callback form.`,
        context
      );
    }
    throw invalidTransactionOptions(
      `Unknown transaction option "${String(key)}". Supported options are ${allowed.map((name) => `"${name}"`).join(", ")}.`,
      context
    );
  }

  const options: TransactionOptions = {};
  if (raw.isolationLevel !== undefined) {
    if (!isIsolationLevel(raw.isolationLevel)) {
      throw invalidTransactionOptions(
        `Unknown isolation level ${JSON.stringify(raw.isolationLevel)}. Supported levels are ${TRANSACTION_ISOLATION_LEVELS.map((level) => `"${level}"`).join(", ")}.`,
        context
      );
    }
    options.isolationLevel = raw.isolationLevel;
  }
  if (raw.timeout !== undefined) {
    options.timeout = readDurationOption(raw.timeout, "timeout", context);
  }
  if (raw.maxWait !== undefined) {
    options.maxWait = readDurationOption(raw.maxWait, "maxWait", context);
  }
  return options;
}

const ISOLATION_LEVEL_SQL: Record<TransactionIsolationLevel, string> = {
  ReadUncommitted: "READ UNCOMMITTED",
  ReadCommitted: "READ COMMITTED",
  RepeatableRead: "REPEATABLE READ",
  Serializable: "SERIALIZABLE",
};

/** The dialect statement that applies `level`. Never interpolates user input. */
export function isolationLevelStatement(
  level: TransactionIsolationLevel
): string {
  return `SET TRANSACTION ISOLATION LEVEL ${ISOLATION_LEVEL_SQL[level]}`;
}

function resolveIsolationLevel(
  level: TransactionIsolationLevel,
  support: TransactionOptionSupport,
  context: TransactionOptionContext
): { placement: IsolationLevelPlacement; statement?: string } {
  switch (support.isolationLevel) {
    case "post-begin":
    case "pre-begin":
      return {
        placement: support.isolationLevel,
        statement: isolationLevelStatement(level),
      };
    case "serializable-only":
      // Honored by construction, not by statement: SQLite runs one writer at a
      // time, so a transaction is already serializable. Emitting nothing is the
      // honest implementation — anything weaker would be a lie about the level.
      if (level === "Serializable") return { placement: "serializable-only" };
      throw refuseTransactionOption(
        "isolationLevel",
        `${level} is not available — ${support.isolationLevelReason ?? "this driver offers Serializable only"}.`,
        context
      );
    default:
      throw refuseTransactionOption(
        "isolationLevel",
        support.isolationLevelReason ??
          "this driver does not open a transaction that can be configured",
        context
      );
  }
}

/**
 * Turn validated options into a plan this driver can actually execute, or throw
 * a typed refusal naming the option and the reason.
 */
export function resolveTransactionPlan(
  options: TransactionOptions | undefined,
  support: TransactionOptionSupport,
  context: TransactionOptionContext
): TransactionPlan | undefined {
  if (!options) return undefined;
  if (
    options.isolationLevel === undefined &&
    options.timeout === undefined &&
    options.maxWait === undefined
  ) {
    return undefined;
  }

  let placement: IsolationLevelPlacement = "unsupported";
  let statement: string | undefined;
  if (options.isolationLevel !== undefined) {
    const resolved = resolveIsolationLevel(
      options.isolationLevel,
      support,
      context
    );
    placement = resolved.placement;
    statement = resolved.statement;
  }

  if (options.timeout !== undefined && !support.timeout) {
    throw refuseTransactionOption(
      "timeout",
      support.timeoutReason ??
        "this driver does not run an interactive callback that could be interrupted",
      context
    );
  }

  if (options.maxWait !== undefined && support.maxWait === "unsupported") {
    throw refuseTransactionOption(
      "maxWait",
      support.maxWaitReason ??
        "this driver has no transaction-slot wait that VibORM can bound",
      context
    );
  }

  const driverOptions: {
    isolationLevel?: TransactionIsolationLevel;
    maxWaitMs?: number;
  } = {};
  if (placement === "pre-begin" && options.isolationLevel !== undefined) {
    driverOptions.isolationLevel = options.isolationLevel;
  }
  if (support.maxWait === "acquisition" && options.maxWait !== undefined) {
    driverOptions.maxWaitMs = options.maxWait;
  }

  return {
    ...(options.isolationLevel === undefined
      ? {}
      : { isolationLevel: options.isolationLevel }),
    ...(statement === undefined ? {} : { isolationStatement: statement }),
    isolationPlacement: placement,
    ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
    ...(options.maxWait === undefined ? {} : { maxWaitMs: options.maxWait }),
    maxWaitMode: support.maxWait,
    ...(Object.keys(driverOptions).length === 0 ? {} : { driverOptions }),
  };
}

/**
 * Race `run()` against `timeoutMs`. On expiry the caller is rejected while the
 * body keeps running; every caller of this helper must drain and roll back the
 * abandoned body before releasing its connection.
 */
export async function runWithTransactionTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  context: TransactionOptionContext
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(transactionTimeoutError(timeoutMs, context)),
      timeoutMs
    );
  });
  // The abandoned body's rejection is observed here so an expired transaction
  // never surfaces as an unhandled rejection.
  const body = run();
  body.catch(() => undefined);
  try {
    return await Promise.race([body, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bound a pooled acquisition by `maxWaitMs`. When the bound is exceeded the
 * acquisition is abandoned, but the resource it eventually yields is released
 * so an over-waited transaction cannot leak a checked-out connection.
 */
export async function acquireWithMaxWait<T>(
  acquire: () => Promise<T>,
  release: (resource: T) => void,
  maxWaitMs: number | undefined,
  context: TransactionOptionContext
): Promise<T> {
  const acquisition = acquire();
  if (maxWaitMs === undefined) return acquisition;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abandoned = false;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abandoned = true;
      reject(transactionMaxWaitError(maxWaitMs, context));
    }, maxWaitMs);
  });
  acquisition.catch(() => undefined);
  try {
    return await Promise.race([acquisition, expiry]);
  } catch (error) {
    if (abandoned) {
      acquisition.then(
        (resource) => {
          try {
            release(resource);
          } catch {
            // The pool owns a connection we never used; nothing further to do.
          }
        },
        () => undefined
      );
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
