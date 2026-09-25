/**
 * A captured mutation's own answer is settled before its listener failure is
 * released — credential-free.
 *
 * The repair prompt §3 states the rule: a settlement region contains every
 * judgement that can still turn this operation's answer into a failure, not
 * only the decode. `OperationContext.capturedMutation` judges its own row
 * count INSIDE `settleSubmitted`, so a captured mutation whose
 * row count falls short of the set it captured composes with the write-outcome
 * listener failure the batch HELD while it acknowledged, instead of being read
 * one statement after the hold was already released.
 *
 * The native measurement is
 * `tests/providers/docker/pg-captured-set-concurrency.test.ts` — three cells on
 * the repository's forced batch profile, where a second connection commits the
 * drift between the unit's last premise and its first write. This file is the
 * part of that pin which needs no credentials, and it is deliberately NOT a
 * concurrency suite: one better-sqlite3 connection carries the whole unit, so
 * the drift is applied from a statement hook on the operation's OWN connection
 * at the same position — after every premise has answered, before the write
 * they stand in front of. What that position reproduces is the shape the
 * settlement owns: a shortfall the premises cannot see, discovered by the row
 * count, on a transport that has already acknowledged.
 *
 * The last two cells are the INTERACTIVE half of the same method, one per
 * verb. A transactional provider without RETURNING captures too,
 * `requireCapturedSet` returns at once there (an interactive session captured
 * `FOR UPDATE`), and the row count is the only reader of the window between
 * the capture and the write. That arm has no hold to release, which is why
 * they are not composition cells — they are the cells that make the
 * interactive arm of `capturedMutation`'s count judgement load-bearing.
 */

import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { BatchQuery, QueryExecutionContext } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { QueryResult } from "@drivers/types";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

const schema = (() => {
  const note = s
    .model({
      id: s.string().id(),
      label: s.string(),
      active: s.boolean(),
    })
    .map("se_notes");
  return { note };
})();

type SettlementConfig = VibORMConfig<typeof schema>;
type SettlementClient = VibORMClient<SettlementConfig>;

/** The write a captured bulk mutation issues against the seeded table. */
const WRITE = /^(?:UPDATE|DELETE)\s+(?:FROM\s+)?"se_notes"/;

/** The registered sentence for a captured set the effect did not match. */
const CHANGED = (verb: string) =>
  `${verb} selected-row cardinality changed during its locked mutation.`;

/** What the client's listener throws when this batch acknowledges. */
const OUTCOME_THREW = "closure-repair credential-free listener failed";
/** The publication owner's own sentence for it (`@extensions/query`). */
const LISTENER_FAILED =
  'Extension "failing-outcome" write-outcome listener failed after committed.';
/** The one composition of a primary with a retained listener failure
 *  (`retainWriteOutcomeFailure`, `@errors`). */
const COMPOSED = "Query execution and write-outcome publication both failed.";

/**
 * The transport with no RETURNING — the shape that CAPTURES the rows it writes
 * — carrying a one-shot drift applied immediately before the write.
 *
 * The position is the schedule, and it is the same one the native cells buy
 * with a second connection: on the batch route every premise
 * `requireCapturedSet` queued has already answered inside this batch when the
 * write is reached; on the interactive route `requireCapturedSet` answered by
 * returning, and the capture is the only read that preceded it.
 */
class CapturingSQLite3Driver extends SQLite3Driver {
  readonly statements: string[] = [];
  drifted = false;
  private drift?: (database: Database.Database) => void;

  constructor() {
    super({ dataDir: ":memory:" });
    this.adapter.capabilities.supportsReturning = false;
  }

  driftBeforeWrite(apply: (database: Database.Database) => void): void {
    this.drift = apply;
    this.drifted = false;
    this.statements.length = 0;
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    const apply = this.drift;
    if (apply && WRITE.test(statement)) {
      this.drift = undefined;
      this.drifted = true;
      apply(client);
    }
    return await super.execute<T>(client, statement, parameters);
  }
}

/**
 * The same transport as a batch-only one: an ATOMIC native batch and no
 * interactive transaction, so the write window really is a batch and `submit`
 * acknowledges its committed segment — holding a listener that failed there —
 * before the operation has answered for it.
 */
class CapturingBatchOnlyDriver extends CapturingSQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries, context)
    );
  }
}

/**
 * A listener on the write-outcome rail that fails exactly where the batch
 * transport HOLDS it: registered before the operation proceeds, throwing when
 * the batch acknowledges its committed segment, which on this route happens
 * BEFORE the operation has answered for that batch.
 */
const withFailingOutcome = (client: SettlementClient) =>
  client.$extends({
    name: "failing-outcome",
    query: {
      note: {
        deleteMany({ onWriteOutcome, proceed }) {
          onWriteOutcome(() => {
            throw new Error(OUTCOME_THREW);
          });
          return proceed();
        },
        updateMany({ onWriteOutcome, proceed }) {
          onWriteOutcome(() => {
            throw new Error(OUTCOME_THREW);
          });
          return proceed();
        },
      },
    },
  });

/**
 * The composition, as the estate's ONE composition states it
 * (`retainWriteOutcomeFailure`, `@errors`): one aggregate whose primary is the
 * OPERATION's own failure BY IDENTITY — `cause` and `errors[0]` are the same
 * object — with the listener's failure retained beside it, never discarded,
 * never re-wrapped into the operation's and never primary itself.
 */
const composition = (raised: unknown) => {
  const aggregate = raised instanceof AggregateError ? raised : undefined;
  return {
    message: aggregate?.message,
    errorCount: aggregate?.errors.length,
    primaryIsCause:
      aggregate !== undefined && aggregate.cause === aggregate.errors[0],
    primary: aggregate?.errors[0],
    retained: aggregate?.errors[1],
  };
};

/**
 * The listener's failure as the EXISTING error model carries it: the
 * publication owner's own `QueryError`, naming the extension, the method and
 * the certainty, with the value the listener threw kept as its cause — whose
 * message this estate's diagnostics redact by design (`sanitizeErrorCause`),
 * which is why the identifying facts are the class and the meta.
 */
const listenerFailure = (failure: unknown) => ({
  name: failure instanceof Error ? failure.name : undefined,
  message: failure instanceof Error ? failure.message : String(failure),
  meta: (failure as { meta?: unknown } | undefined)?.meta,
  keepsCause:
    (failure as { originalCause?: unknown } | undefined)
      ?.originalCause instanceof Error,
});

/** What every combined failure of this file must say about its composition. */
const COMPOSITION = {
  message: COMPOSED,
  errorCount: 2,
  primaryIsCause: true,
};

/** What every retained listener failure of this file must say about itself. */
const RETAINED_LISTENER = {
  name: "QueryError",
  message: LISTENER_FAILED,
  meta: { method: "onWriteOutcome", commitCertainty: "committed" },
  keepsCause: true,
};

interface Progress {
  readonly atomicity?: string;
  readonly phase?: string;
  readonly committedSegments?: number;
}

/** What a failure says about the effects its batch already acknowledged. */
const progressOf = (error: unknown): Progress | undefined =>
  (error as { meta?: { recordSeriesProgress?: Progress } } | undefined)?.meta
    ?.recordSeriesProgress;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Runs an operation for its OUTCOME, so a cell can assert a rejection. */
const settle = async <T>(
  run: () => PromiseLike<T>
): Promise<{ error?: unknown; value?: T }> =>
  await Promise.resolve(run()).then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );

describe("a captured mutation's answer is settled before its listener failure is released", () => {
  let driver: CapturingSQLite3Driver | undefined;

  afterEach(async () => {
    await driver?.disconnect();
    driver = undefined;
  });

  /** n1 and n2 match the selector; n3 is the row the selector never named. */
  async function world(
    make: () => CapturingSQLite3Driver
  ): Promise<SettlementClient> {
    driver = make();
    const client = createClient({ schema, driver }) as SettlementClient;
    await syncLiveSchema(client);
    for (const seed of [
      { id: "n1", label: "one", active: true },
      { id: "n2", label: "two", active: true },
      { id: "n3", label: "three", active: false },
    ])
      await client.note.create({ data: seed });
    return client;
  }

  const rows = async (client: SettlementClient) =>
    (await client.note.findMany({ orderBy: { id: "asc" } })).map((row) => [
      row.id,
      row.label,
      row.active,
    ]);

  /** n1 stops matching the selector after the premises and before the write. */
  const deactivateFirst = (database: Database.Database) => {
    database
      .prepare(`UPDATE "se_notes" SET "active" = 0 WHERE "id" = 'n1'`)
      .run();
  };

  test("batch route: a held write-outcome listener failure does not take the captured DELETE's cardinality answer with it", async () => {
    const client = await world(() => new CapturingBatchOnlyDriver());
    const failing = withFailingOutcome(client);
    driver?.driftBeforeWrite(deactivateFirst);

    const raised = (
      await settle(() =>
        failing.note.deleteMany({
          where: { active: true },
          select: { id: true, label: true },
        })
      )
    ).error;

    expect(driver?.drifted).toBe(true);
    // The OPERATION's own answer is settled before the hold is released, so the
    // cardinality failure is the primary and the listener's is retained beside
    // it — not the other way round, and neither is lost.
    expect(raised).toBeInstanceOf(AggregateError);
    const composed = composition(raised);
    expect(composed).toMatchObject(COMPOSITION);
    expect(messageOf(composed.primary)).toContain(CHANGED("deleteMany"));
    expect(listenerFailure(composed.retained)).toMatchObject(RETAINED_LISTENER);
    // And the primary still carries what the batch committed: the answer that
    // failed is a RESULT-phase failure over an acknowledged segment.
    expect(progressOf(composed.primary)).toMatchObject({
      atomicity: "segment",
      phase: "result",
      committedSegments: 1,
    });
    // Exact committed state: the row that stopped matching is carried by the
    // write's own selector (D-65) and was left alone; the row that still
    // matched is gone; nothing was replayed or undone.
    expect(await rows(client)).toEqual([
      ["n1", "one", false],
      ["n3", "three", false],
    ]);
  });

  test("batch route: a held write-outcome listener failure does not take the captured UPDATE's cardinality answer with it", async () => {
    const client = await world(() => new CapturingBatchOnlyDriver());
    const failing = withFailingOutcome(client);
    driver?.driftBeforeWrite(deactivateFirst);

    const raised = (
      await settle(() =>
        failing.note.updateMany({
          where: { active: true },
          data: { label: "renamed" },
          select: { id: true, label: true },
        })
      )
    ).error;

    expect(driver?.drifted).toBe(true);
    expect(raised).toBeInstanceOf(AggregateError);
    const composed = composition(raised);
    expect(composed).toMatchObject(COMPOSITION);
    expect(messageOf(composed.primary)).toContain(CHANGED("updateMany"));
    expect(listenerFailure(composed.retained)).toMatchObject(RETAINED_LISTENER);
    expect(progressOf(composed.primary)).toMatchObject({
      atomicity: "segment",
      phase: "result",
      committedSegments: 1,
    });
    // n1 keeps its label, n2 has the committed one, and the non-RETURNING
    // read-back is behind the answer, so no result was published for either.
    expect(await rows(client)).toEqual([
      ["n1", "one", false],
      ["n2", "renamed", true],
      ["n3", "three", false],
    ]);
  });

  test("batch route: a listener that fails beside a captured answer that SUCCEEDED is still published alone", async () => {
    const client = await world(() => new CapturingBatchOnlyDriver());
    const failing = withFailingOutcome(client);
    // No drift: every captured row still matches at the effect, so the
    // operation's own answer is a success and the only failure in the window
    // is the listener's.
    const outcome = await settle(() =>
      failing.note.deleteMany({
        where: { active: true },
        select: { id: true, label: true },
      })
    );

    // Published alone, in its own class: no aggregate, and above all no
    // cardinality sentence invented for an answer that did not fail.
    expect(outcome.value).toBeUndefined();
    expect(outcome.error).not.toBeInstanceOf(AggregateError);
    expect(listenerFailure(outcome.error)).toMatchObject(RETAINED_LISTENER);
    // A listener failure beside a successful answer is not the operation's own
    // record-series failure, so it carries no progress — unchanged.
    expect(progressOf(outcome.error)).toBeUndefined();
    // The write is durable and complete: the failure is the listener's.
    expect(await rows(client)).toEqual([["n3", "three", false]]);
  });

  test("interactive route: a captured row that stops matching before the write is answered by the cardinality sentence", async () => {
    const client = await world(() => new CapturingSQLite3Driver());
    driver?.driftBeforeWrite(deactivateFirst);

    const outcome = await settle(() =>
      client.note.deleteMany({
        where: { active: true },
        select: { id: true, label: true },
      })
    );

    // There is no hold on this route — `heldOutcomeFailure` is set only where
    // `submit` acknowledges — so the answer is the operation's own failure,
    // published alone. What this cell pins is that the answer is STATED: the
    // same count judgement, on the arm that dispatches rather than submits.
    expect(driver?.drifted).toBe(true);
    expect(outcome.value).toBeUndefined();
    expect(messageOf(outcome.error)).toContain(CHANGED("deleteMany"));
    expect(outcome.error).not.toBeInstanceOf(AggregateError);
    // The interactive capture and its write are one region, so the failure
    // takes the whole unit — including the drift applied on its own connection
    // — back with it. Nothing was published and nothing was written.
    expect(await rows(client)).toEqual([
      ["n1", "one", true],
      ["n2", "two", true],
      ["n3", "three", false],
    ]);
  });

  test("interactive route: a captured row that stops matching before the UPDATE is answered by the cardinality sentence", async () => {
    const client = await world(() => new CapturingSQLite3Driver());
    driver?.driftBeforeWrite(deactivateFirst);

    const outcome = await settle(() =>
      client.note.updateMany({
        where: { active: true },
        data: { label: "renamed" },
        select: { id: true, label: true },
      })
    );

    // The UPDATE's half of the same interactive check: its read-back comes
    // after the answer, so a shortfall publishes no row at all.
    expect(driver?.drifted).toBe(true);
    expect(outcome.value).toBeUndefined();
    expect(messageOf(outcome.error)).toContain(CHANGED("updateMany"));
    expect(outcome.error).not.toBeInstanceOf(AggregateError);
    expect(await rows(client)).toEqual([
      ["n1", "one", true],
      ["n2", "two", true],
      ["n3", "three", false],
    ]);
  });
});
