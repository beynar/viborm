import assert from "node:assert/strict";
import { SQLite3Driver } from "@drivers/sqlite3";
import type {
  BatchQuery,
  QueryResult,
  QueryExecutionContext,
} from "@drivers/types";
import { VibORMError } from "@errors";
import Database from "better-sqlite3";
import type { ProfileId } from "../profiles";
import type {
  CandidateEngineFactory,
  DefaultObservation,
  ControlledFault,
  FailureObservation,
  G0ReplayRecord,
  PreparedScenario,
  ReplayTape,
  RunObservation,
  ScenarioDefinition,
  StatementCompletion,
} from "./protocol";
import { Recorder, recordingEventLimit } from "./recorder";

/** The transport borrows the fixture's database; its SQL is always real SQLite. */
class ObservedSQLiteDriver extends SQLite3Driver {
  constructor(
    database: Database.Database,
    private readonly recorder: Recorder,
    private readonly completed: (
      statement: StatementCompletion
    ) => Promise<void>,
    private readonly statementTransform?: (sql: string) => string,
    private failuresBeforeDispatch = 0
  ) {
    super({ client: database });
  }

  protected override async transaction<T>(
    client: Database.Database,
    callback: (transaction: Database.Database) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    let primary: unknown;
    try {
      return await super.transaction(
        client,
        async (transaction) => {
          try {
            return await callback(transaction);
          } catch (failure) {
            primary = failure;
            throw failure;
          }
        },
        context
      );
    } catch (failure) {
      if (failure instanceof AggregateError && primary !== undefined) {
        assert.equal(
          failure.cause,
          primary,
          "Cleanup replaced the original callback failure"
        );
        assert.equal(
          failure.errors[0],
          primary,
          "Cleanup reordered the primary failure"
        );
        this.recorder.record({
          kind: "cleanup-failure",
          failure: observeFailure(failure),
        });
      }
      throw failure;
    }
  }

  protected override async execute<T>(
    client: Database.Database,
    sql: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    if (this.failuresBeforeDispatch > 0) {
      this.failuresBeforeDispatch--;
      this.recorder.record({
        kind: "injected-failure",
        cut: "before-dispatch",
      });
      throw new Error("Controlled failure before dispatch");
    }
    const statement = this.statementTransform?.(sql) ?? sql;
    this.recorder.record({
      kind: "dispatch",
      sql: statement,
      parameters,
      transactionOpen: client.inTransaction,
    });
    let response: QueryResult<T>;
    try {
      response = await super.execute<T>(client, statement, parameters);
    } catch (failure) {
      this.recorder.record({
        kind: "dispatch-failure",
        failure: observeFailure(failure),
      });
      throw failure;
    }
    await this.completed({
      sql: statement,
      parameters,
      rows: response.rows,
      transactionOpen: client.inTransaction,
    });
    return response;
  }
}

/** Restricted transport model, not a claim about D1 or another hosted driver. */
class ObservedAtomicBatchDriver extends ObservedSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const responses: QueryResult<T>[] = [];
      for (const query of queries) {
        responses.push(
          await this.execute<T>(transaction, query.sql, query.params ?? [])
        );
      }
      return responses;
    });
  }
}

export function observeFailure(failure: unknown): FailureObservation {
  if (!(failure instanceof Error)) throw failure;
  const cause =
    failure instanceof VibORMError ? failure.originalCause : failure.cause;
  const code =
    "code" in failure && typeof failure.code === "string"
      ? failure.code
      : undefined;
  return {
    name: failure.name,
    message: failure.message,
    ...(code === undefined ? {} : { code }),
    ...(failure instanceof VibORMError ? { meta: failure.meta } : {}),
    ...(cause === undefined
      ? {}
      : { cause: cause instanceof Error ? observeFailure(cause) : cause }),
    ...(failure instanceof AggregateError
      ? {
          errors: failure.errors.map((member: unknown) =>
            member instanceof Error ? observeFailure(member) : member
          ),
        }
      : {}),
  };
}

export interface ObservedWorld {
  fixture: PreparedScenario;
  observation: RunObservation;
  statements: StatementCompletion[];
  record: G0ReplayRecord;
}

export interface WorldOptions {
  candidateFactory?: CandidateEngineFactory;
  candidateName?: "commands";
  replay?: ReplayTape;
  eventLimit?: number;
  /** Test-only fault at an observed fixture cut; never a private statement index. */
  fault?: ControlledFault;
  /** Changed-SQL specimens still execute the resulting statement in real SQLite. */
  statementTransform?: (sql: string) => string;
}

export async function runSQLiteWorld(
  scenario: ScenarioDefinition,
  profile: ProfileId,
  seed = 0,
  options: WorldOptions = {}
): Promise<ObservedWorld> {
  let candidateExecutions = 0;
  const requestedFactory = options.candidateFactory;
  const candidateFactory: CandidateEngineFactory | undefined = requestedFactory
    ? (config) => {
        const engine = requestedFactory(config);
        return {
          execute(...args) {
            candidateExecutions += 1;
            return engine.execute(...args);
          },
          prepareBatch(...args) {
            candidateExecutions += 1;
            return engine.prepareBatch(...args);
          },
        };
      }
    : undefined;
  const recorder = new Recorder(
    seed,
    options.replay,
    options.eventLimit ?? recordingEventLimit(scenario.id)
  );
  const defaults: DefaultObservation[] = [];
  const reachedCuts: string[] = [];
  const recordCut = (name: string) => {
    reachedCuts.push(name);
    recorder.record({ kind: "cut", name });
  };
  const fixture = scenario.prepare({
    profile,
    seed,
    clockEpochMs: recorder.clockEpochMs,
    fault: options.fault,
    recordDefault(name, value) {
      const observation = { name, value };
      defaults.push(observation);
      recorder.record({ kind: "default", observation });
    },
    recordCut,
  });
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const statements: StatementCompletion[] = [];
  let observationFailure: unknown;
  const nativeExec = database.exec;
  let rollbackFaultInjected = false;
  database.exec = function (source) {
    const control = source.trim().toUpperCase();
    let phase: "begin" | "commit" | "rollback" | undefined;
    if (control === "BEGIN") phase = "begin";
    if (control === "COMMIT") phase = "commit";
    if (control === "ROLLBACK") phase = "rollback";
    try {
      nativeExec.call(this, source);
    } catch (failure) {
      if (phase)
        recorder.record({
          kind: "transaction-failure",
          phase,
          failure: observeFailure(failure),
        });
      throw failure;
    }
    // Only a successful native control call establishes the provider outcome.
    if (phase) {
      recorder.record({ kind: "transaction", phase });
      try {
        const cut = fixture.afterTransaction?.(database, phase);
        if (cut) recordCut(cut);
      } catch (failure) {
        observationFailure ??= failure;
        throw failure;
      }
    }
    if (
      phase === "rollback" &&
      options.fault?.kind === "after-rollback" &&
      !rollbackFaultInjected
    ) {
      rollbackFaultInjected = true;
      recorder.record({ kind: "injected-failure", cut: "after-rollback" });
      throw new Error("Controlled failure after rollback");
    }
    return this;
  };
  let cutFaultInjected = false;
  const completed = async (statement: StatementCompletion) => {
    statements.push(structuredClone(statement));
    await recorder.complete(statement);
    let cuts: readonly string[] = [];
    try {
      const observed = fixture.afterStatement?.(database, statement);
      cuts =
        observed === undefined
          ? []
          : typeof observed === "string"
            ? [observed]
            : observed;
      for (const cut of cuts) {
        recordCut(cut);
      }
    } catch (failure) {
      // A fixture assertion must not be mistaken for an expected ORM refusal.
      observationFailure ??= failure;
      throw failure;
    }
    if (
      options.fault?.kind === "at-cut" &&
      cuts.includes(options.fault.cut) &&
      !cutFaultInjected
    ) {
      cutFaultInjected = true;
      recorder.record({ kind: "injected-failure", cut: options.fault.cut });
      throw new Error(`Controlled failure at ${options.fault.cut}`);
    }
  };
  const driver =
    profile === "sqlite-interactive"
      ? new ObservedSQLiteDriver(
          database,
          recorder,
          completed,
          options.statementTransform,
          options.fault?.kind === "before-dispatch"
            ? (options.fault.times ?? 1)
            : 0
        )
      : new ObservedAtomicBatchDriver(
          database,
          recorder,
          completed,
          options.statementTransform,
          options.fault?.kind === "before-dispatch"
            ? (options.fault.times ?? 1)
            : 0
        );
  return recorder.control(async () => {
    const completedWorld = await (async () => {
      try {
        fixture.seed(database);
        const initial = fixture.inspect(database);
        const schema = database
          .prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name"
          )
          .all();
        const sqliteVersion = database
          .prepare("SELECT sqlite_version()")
          .pluck()
          .get();
        if (typeof sqliteVersion !== "string")
          throw new Error("SQLite version response is invalid");
        let outcome: RunObservation["outcome"];
        let invocationFailure: unknown;
        try {
          outcome = {
            kind: "success",
            value: await fixture.invoke(driver, candidateFactory),
          };
        } catch (failure) {
          invocationFailure = failure;
          outcome = { kind: "failure", failure: observeFailure(failure) };
        }
        if (candidateFactory) {
          const expectedExecutions = fixture.expectedExecutions ?? 1;
          if (candidateExecutions !== expectedExecutions) {
            const message = `${scenario.id}/${profile}/seed-${seed}: Unexpected candidate execution count: ${candidateExecutions} !== ${expectedExecutions}; the fixture bypassed or repeated the requested engine`;
            if (invocationFailure !== undefined)
              throw new Error(message, { cause: invocationFailure });
            throw new Error(message);
          }
        }
        if (observationFailure !== undefined) throw observationFailure;
        assert.equal(
          database.inTransaction,
          false,
          "the operation left a transaction open"
        );
        const observation = {
          outcome,
          ...(fixture.subsequentOutcomes
            ? {
                subsequentOutcomes: structuredClone(fixture.subsequentOutcomes),
              }
            : {}),
          initial,
          final: fixture.inspect(database),
          defaults,
          reachedCuts,
        };
        return { observation, schema, sqliteVersion };
      } finally {
        try {
          await driver.disconnect();
        } finally {
          database.close();
        }
      }
    })();
    const record = {
      scenarioId: scenario.id,
      ...(scenario.specimen ? { specimen: scenario.specimen } : {}),
      ...(options.candidateName ? { candidate: options.candidateName } : {}),
      profile,
      seed,
      ...(options.fault ? { fault: options.fault } : {}),
      publicInput: fixture.publicInput,
      ...completedWorld,
      tape: recorder.finish(),
      statements,
    };
    if (options.fault)
      assert.equal(
        record.tape.events.filter((event) => event.kind === "injected-failure")
          .length,
        options.fault.kind === "before-dispatch"
          ? (options.fault.times ?? 1)
          : 1,
        "Required injected failure was not reached"
      );
    return {
      fixture: {
        ...fixture,
        assert(observation) {
          // Persist the completed run before a missing behavior fails its oracle.
          // Same-engine replay enters this same assertion owner.
          for (const cut of fixture.requiredCuts)
            assert(
              observation.reachedCuts.includes(cut),
              `Missing semantic cut ${cut}; observed outcome: ${JSON.stringify(observation.outcome)}`
            );
          fixture.assert(observation);
        },
      },
      observation: completedWorld.observation,
      statements,
      record,
    };
  });
}
