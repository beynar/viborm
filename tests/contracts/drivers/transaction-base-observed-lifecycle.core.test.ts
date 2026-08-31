/**
 * What an observer is told about a transaction it did not run.
 *
 * `observe` is public API, and the one fact it carries that nothing else can
 * reconstruct is COMMIT CERTAINTY: after a failure, did the write land? The
 * driver base is the only layer that knows, because it is the layer that sees
 * `readyToCommit` fire and then watches COMMIT itself fail. Three outcomes are
 * possible and all three are load-bearing for a caller deciding whether to
 * retry — so all three are pinned here, together with the savepoint form, which
 * must report NO certainty at all because a savepoint commits nothing.
 *
 * The nesting contracts below are the other half: a savepoint whose ROLLBACK
 * failed leaves state nobody can account for, and that must poison the ROOT
 * transaction rather than the scope that happened to notice.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { Driver } from "@drivers/driver";
import {
  createExecutionContext,
  getExecutionTransactionPhases,
} from "@drivers/execution-context";
import {
  runTransactionLifecycle,
  type TransactionOptionSupport,
} from "@drivers/shared";
import type { QueryExecutionContext, QueryResult } from "@drivers/types";
import { appendResolvedExtension } from "@extensions/chain";
import type { ObservationCompletion } from "@extensions/observation";
import { getOfficialInstrumentationChainCapability } from "@instrumentation/extension";
import { SPAN_TRANSACTION } from "@instrumentation/spans";
import { sql } from "@sql";
import {
  type InstrumentationConfig,
  instrumentation,
} from "@src/instrumentation/exports";
import {
  type OtelRecorder,
  withOtelRecorder,
} from "@tests/unit/instrumentation/_capture";
import { afterEach, describe, expect, test } from "vitest";

interface FakeSession {
  readonly id: string;
}

const SAVEPOINT_ROLLBACK_PREFIX = "ROLLBACK TO SAVEPOINT ";
const SAVEPOINT_PREFIX = "SAVEPOINT ";
const RELEASE_PREFIX = "RELEASE SAVEPOINT ";

const QUEUE_MAX_WAIT_SUPPORT: TransactionOptionSupport = {
  isolationLevel: "unsupported",
  isolationLevelReason: "this recording driver opens no configurable session",
  timeout: true,
  maxWait: "queue",
};

/** Let the observer's span finish; a span ends after the caller is resolved. */
async function waitFor(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error("Expected the observed span to be recorded");
}

/** A promise this test settles by hand, standing in for unfinished work. */
function held<T>() {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle: (value: T) => settle?.(value) };
}

/** Records the completion every ordinary `observe` handler is handed. */
function completionRecorder() {
  const pending: Promise<unknown>[] = [];
  const records: string[] = [];
  const extension = {
    name: "completion-recorder",
    observe(
      unit: { readonly kind: string },
      proceed: () => Promise<ObservationCompletion>
    ) {
      const observed = proceed().then((completion) => {
        records.push(
          `${unit.kind}:${completion.status}:${completion.commitCertainty ?? "none"}`
        );
      });
      pending.push(observed);
      return observed;
    },
  };
  return {
    extension,
    records,
    async settle(): Promise<void> {
      await Promise.allSettled(pending);
      await Promise.resolve();
    },
  };
}

/** Build the trusted context an official-derived client supplies. */
function observedContext(
  config: InstrumentationConfig,
  values: QueryExecutionContext,
  companion?: object
): QueryExecutionContext {
  let chain = appendResolvedExtension(undefined, instrumentation(config), {});
  if (companion) chain = appendResolvedExtension(chain, companion, {});
  const capability = getOfficialInstrumentationChainCapability(chain);
  if (capability === undefined) {
    throw new Error("Official instrumentation capability was not registered");
  }
  return createExecutionContext(values, capability.context, undefined, chain);
}

/** Logging with no enabled level: observed, but nothing to trace or log. */
const QUIET_OBSERVATION: InstrumentationConfig = {
  logging: { query: () => undefined },
};

interface PhasedOptions {
  readonly failBegin?: boolean;
  readonly failCommit?: boolean;
  readonly failSavepointRollback?: boolean;
  readonly serialize?: boolean;
  readonly support?: TransactionOptionSupport;
}

/**
 * A driver that runs a real BEGIN/COMMIT/ROLLBACK lifecycle over an in-memory
 * session and reports the transaction phases exactly as a provider driver does,
 * so commit certainty is derived rather than declared.
 */
class PhasedDriver extends Driver<FakeSession, FakeSession> {
  readonly adapter: DatabaseAdapter = new PostgresAdapter();
  readonly statements: string[] = [];
  protected override readonly serializeTransactions: boolean;
  private readonly options: PhasedOptions;

  constructor(options: PhasedOptions = {}) {
    super("postgresql", "phased");
    this.options = options;
    this.serializeTransactions = options.serialize === true;
  }

  protected override transactionOptionSupport(): TransactionOptionSupport {
    return this.options.support ?? super.transactionOptionSupport();
  }

  protected initClient(): Promise<FakeSession> {
    return Promise.resolve({ id: "session" });
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(
    _client: FakeSession,
    statement: string
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  protected executeRaw<T>(
    _client: FakeSession,
    statement: string
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    if (
      this.options.failSavepointRollback === true &&
      statement.startsWith(SAVEPOINT_ROLLBACK_PREFIX)
    ) {
      return Promise.reject(new Error(`refused: ${statement}`));
    }
    if (this.options.failBegin === true && statement === "BEGIN") {
      return Promise.reject(new Error("could not start transaction"));
    }
    if (this.options.failCommit === true && statement === "COMMIT") {
      return Promise.reject(new Error("connection lost during commit"));
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  protected transaction<T>(
    client: FakeSession,
    fn: (tx: FakeSession) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    const phases = getExecutionTransactionPhases(context);
    return runTransactionLifecycle({
      begin: () => this.executeRaw(client, "BEGIN", undefined),
      callback: () => fn(client),
      commit: () => this.executeRaw(client, "COMMIT", undefined),
      rollback: () => this.executeRaw(client, "ROLLBACK", undefined),
      ...(phases === undefined ? {} : { phases }),
    });
  }

  /** Statement names with the random savepoint identifiers removed. */
  shape(): string[] {
    return this.statements.map((statement) => {
      if (statement.startsWith(SAVEPOINT_ROLLBACK_PREFIX)) {
        return "ROLLBACK TO SAVEPOINT";
      }
      if (statement.startsWith(RELEASE_PREFIX)) return "RELEASE SAVEPOINT";
      if (statement.startsWith(SAVEPOINT_PREFIX)) return "SAVEPOINT";
      return statement;
    });
  }
}

describe("observed commit certainty", () => {
  test("reports a committed transaction as committed", async () => {
    const recorder = completionRecorder();
    const driver = new PhasedDriver();
    const context = observedContext(
      QUIET_OBSERVATION,
      { operation: "$transaction" },
      recorder.extension
    );

    await expect(
      driver._transaction(() => Promise.resolve("value"), undefined, context)
    ).resolves.toBe("value");
    await recorder.settle();

    expect(driver.shape()).toEqual(["BEGIN", "COMMIT"]);
    expect(recorder.records).toContain("transaction:success:committed");
  });

  test("reports a COMMIT that failed after readiness as may-have-committed", async () => {
    const recorder = completionRecorder();
    const driver = new PhasedDriver({ failCommit: true });
    const context = observedContext(
      QUIET_OBSERVATION,
      { operation: "$transaction" },
      recorder.extension
    );

    await expect(
      driver._transaction(() => Promise.resolve("value"), undefined, context)
    ).rejects.toThrow();
    await recorder.settle();

    // The body finished and COMMIT was issued; whether the server applied it
    // before the connection died is exactly what the caller cannot assume.
    expect(driver.shape()).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
    expect(recorder.records).toContain(
      "transaction:failure:may-have-committed"
    );
  });

  test("reports no certainty for a transaction that never opened", async () => {
    const recorder = completionRecorder();
    const driver = new PhasedDriver({ failBegin: true });
    const context = observedContext(
      QUIET_OBSERVATION,
      { operation: "$transaction" },
      recorder.extension
    );

    await expect(
      driver._transaction(() => Promise.resolve("value"), undefined, context)
    ).rejects.toThrow();
    await recorder.settle();

    expect(driver.shape()).toEqual(["BEGIN"]);
    expect(recorder.records).toContain("transaction:failure:none");
  });

  test("reports no certainty for a savepoint, which commits nothing", async () => {
    const recorder = completionRecorder();
    const driver = new PhasedDriver();
    const context = observedContext(
      QUIET_OBSERVATION,
      { operation: "$transaction" },
      recorder.extension
    );

    await driver.withTransaction(
      (txDriver) => txDriver._transaction(() => Promise.resolve("inner")),
      undefined,
      context
    );
    await recorder.settle();

    expect(driver.shape()).toEqual([
      "BEGIN",
      "SAVEPOINT",
      "RELEASE SAVEPOINT",
      "COMMIT",
    ]);
    expect(recorder.records).toContain("savepoint:success:none");
    expect(recorder.records).toContain("transaction:success:committed");
  });
});

describe("observed transaction spans", () => {
  let recorder: OtelRecorder | undefined;

  afterEach(async () => {
    await recorder?.dispose();
    recorder = undefined;
  });

  test("runs the whole transaction inside one traced lifecycle gate", async () => {
    recorder = withOtelRecorder();
    const driver = new PhasedDriver();
    const context = observedContext(
      { tracing: true },
      {
        operation: "$transaction",
      }
    );

    await driver.withTransaction(
      (txDriver) => txDriver._execute(sql`SELECT ${1}`),
      undefined,
      context
    );

    const traced = recorder;
    await waitFor(() => traced.find(SPAN_TRANSACTION) !== undefined);

    expect(driver.shape()).toEqual(["BEGIN", "SELECT $1", "COMMIT"]);
    expect(traced.find(SPAN_TRANSACTION)).toBeDefined();
  });
});

describe("observed queue-bounded maxWait", () => {
  test("bounds the queue wait without opening a transaction", async () => {
    const recorder = completionRecorder();
    const driver = new PhasedDriver({
      serialize: true,
      support: QUEUE_MAX_WAIT_SUPPORT,
    });
    const context = observedContext(
      QUIET_OBSERVATION,
      { operation: "$transaction" },
      recorder.extension
    );
    const occupied = held<string>();

    const holder = driver._transaction(
      () => occupied.promise,
      undefined,
      context
    );
    const bounded = driver._transaction(
      () => Promise.resolve("started"),
      { maxWait: 1 },
      context
    );

    await expect(bounded).rejects.toMatchObject({ code: "V5002" });
    occupied.settle("released");
    await expect(holder).resolves.toBe("released");
    await recorder.settle();

    expect(driver.shape()).toEqual(["BEGIN", "COMMIT"]);
    expect(recorder.records).toContain("transaction:failure:none");
  });
});

describe("nested savepoint failure ownership", () => {
  test("a savepoint whose ROLLBACK failed poisons the root transaction", async () => {
    const driver = new PhasedDriver({ failSavepointRollback: true });

    const failure = await driver
      .withTransaction((first) =>
        first.withTransaction((second) =>
          second.withTransaction(() =>
            Promise.reject(new Error("innermost body failed"))
          )
        )
      )
      .catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(AggregateError);
    // Two savepoints were opened and both rollbacks were refused, so no scope
    // could be proven undone — the root transaction is rolled back and the
    // COMMIT is never attempted.
    expect(driver.shape()).toEqual([
      "BEGIN",
      "SAVEPOINT",
      "SAVEPOINT",
      "ROLLBACK TO SAVEPOINT",
      "RELEASE SAVEPOINT",
      "ROLLBACK TO SAVEPOINT",
      "RELEASE SAVEPOINT",
      "ROLLBACK",
    ]);
  });

  test("a nested transaction opened through withTransaction is one savepoint", async () => {
    const driver = new PhasedDriver();

    await expect(
      driver.withTransaction((first) =>
        first.withTransaction(() => Promise.resolve("nested"))
      )
    ).resolves.toBe("nested");

    expect(driver.shape()).toEqual([
      "BEGIN",
      "SAVEPOINT",
      "RELEASE SAVEPOINT",
      "COMMIT",
    ]);
  });
});
