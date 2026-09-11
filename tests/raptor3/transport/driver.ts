import assert from "node:assert/strict";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { Driver } from "@drivers/driver";
import type {
  BatchQuery,
  CommittedBatchNotification,
  QueryExecutionContext,
  QueryResult,
} from "@drivers/types";
import type { StatementCompletion } from "../harness/protocol";
import { Recorder } from "../harness/recorder";
import { observeFailure } from "../harness/sqlite-world";
import type { TransportProfileId } from "../profiles";

export interface ExpectedStatement {
  action: "SELECT" | "INSERT" | "UPDATE";
  parameters: readonly unknown[];
}

export interface Reply {
  name: string;
  via: "execute" | "batch";
  statements: readonly ExpectedStatement[];
  committed: boolean;
  injected?: true;
  outcome:
    | { kind: "rows"; responses: QueryResult<unknown>[] }
    | { kind: "failure"; code: "57014"; message: string };
}

export interface ActorScript {
  name: string;
  /** A unique public value in the actor's first dispatched request. */
  firstParameter: string;
  replies: readonly Reply[];
}

/** Replies are supplied by fixtures; this driver neither evaluates nor answers SQL. */
export class ScriptedTransport extends Driver<object, object> {
  readonly adapter = new PostgresAdapter();
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  override readonly supportsOrderedCommittedSegments: boolean;
  readonly statements: StatementCompletion[] = [];
  readonly dispatched: {
    actor: string;
    request: string;
    parameters: unknown[][];
  }[] = [];
  private readonly positions = new Map<string, number>();
  private readonly correlations = new Map<string, string>();
  private readonly pending = new Map<string, () => Promise<void>>();
  private wake: (() => void) | undefined;
  private harnessFailure: unknown;
  private released = 0;

  constructor(
    readonly scripts: readonly ActorScript[],
    readonly recorder: Recorder,
    profile: TransportProfileId,
    private readonly specimen?:
      | "wrong-publication"
      | "lost-progress"
      | "wrong-attribution"
  ) {
    super("postgresql", profile);
    this.supportsOrderedCommittedSegments =
      profile === "scripted-returning-ack";
    this.adapter.capabilities.supportsCteWithMutations = false;
  }

  protected async initClient(): Promise<object> {
    return {};
  }
  protected async closeClient(): Promise<void> {}
  protected async transaction<T>(): Promise<T> {
    return this.fail(
      new Error("Lane A fixture does not admit interactive transactions")
    );
  }
  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    return this.fail(new Error("Lane A fixture does not admit raw execution"));
  }
  protected async execute<T>(
    _client: object,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const replies = await this.answer<T>("execute", [{ sql, params }], context);
    return replies[0]!;
  }
  protected override executeBatch<T>(
    _client: object,
    queries: BatchQuery[],
    context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    return this.answer("batch", queries, context, committed);
  }

  private fail(failure: unknown): never {
    this.harnessFailure = failure;
    this.wake?.();
    throw failure;
  }

  private answer<T>(
    via: Reply["via"],
    queries: BatchQuery[],
    context: QueryExecutionContext | undefined,
    acknowledge?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    let script: ActorScript;
    let reply: Reply;
    let correlationId: string;
    try {
      assert(
        context?.correlationId,
        "Transport request has no operation identity"
      );
      correlationId = context.correlationId;
      const knownActor = this.correlations.get(correlationId);
      const matches = this.scripts.filter((actor) =>
        knownActor
          ? actor.name === knownActor
          : !this.positions.has(actor.name) &&
            queries.some((query) =>
              query.params?.includes(actor.firstParameter)
            )
      );
      assert.equal(matches.length, 1, "Unknown or ambiguous scripted actor");
      script = matches[0]!;
      this.correlations.set(correlationId, script.name);
      const position = this.positions.get(script.name) ?? 0;
      const expected = script.replies[position];
      assert(expected, `Unscripted redispatch by ${script.name}`);
      reply = expected;
      assert.equal(via, reply.via, `Wrong transport form: ${reply.name}`);
      assert.equal(
        queries.length,
        reply.statements.length,
        `Unscripted statement: ${reply.name}`
      );
      if (reply.outcome.kind === "rows")
        assert.equal(
          reply.outcome.responses.length,
          reply.statements.length,
          `Missing explicit response: ${reply.name}`
        );
      if (
        this.specimen === "wrong-publication" &&
        reply.name.endsWith(":consumer")
      )
        queries = queries.map((query, index) =>
          reply.statements[index]!.action === "INSERT"
            ? { ...query, params: [...(query.params ?? []).slice(0, -1), -999] }
            : query
        );
      for (const [index, query] of queries.entries()) {
        const statement = reply.statements[index]!;
        assert.match(query.sql, new RegExp(`^${statement.action}\\b`, "i"));
        if (query.context)
          assert.equal(
            query.context.correlationId,
            correlationId,
            "A statement crossed operation contexts"
          );
        this.recorder.record({
          kind: "dispatch",
          sql: query.sql,
          parameters: query.params ?? [],
          transactionOpen: false,
        });
      }
      this.positions.set(script.name, position + 1);
      this.dispatched.push({
        actor: script.name,
        request: reply.name,
        parameters: queries.map((query) => [...(query.params ?? [])]),
      });
      this.recorder.record({
        kind: "transport",
        actor: script.name,
        request: reply.name,
        correlationId,
        phase: "queued",
      });
    } catch (failure) {
      return this.fail(failure);
    }
    return new Promise((resolve, reject) => {
      this.pending.set(reply.name, async () => {
        const event = (
          phase: "committed" | "acknowledged" | "returned" | "rejected"
        ) =>
          this.recorder.record({
            kind: "transport",
            actor: script.name,
            request: reply.name,
            correlationId,
            phase,
          });
        try {
          if (reply.injected)
            this.recorder.record({ kind: "injected-failure", cut: reply.name });
          if (reply.committed) {
            event("committed");
            if (acknowledge) {
              await acknowledge();
              event("acknowledged");
            }
          }
          if (reply.outcome.kind === "failure") {
            const failure = Object.assign(new Error(reply.outcome.message), {
              code: reply.outcome.code,
            });
            this.recorder.record({
              kind: "dispatch-failure",
              failure: observeFailure(failure),
            });
            event("rejected");
            reject(failure);
            return;
          }
          const responses = structuredClone(reply.outcome.responses);
          for (const [index, response] of responses.entries()) {
            const query = queries[index]!;
            const statement = {
              sql: query.sql,
              parameters: query.params ?? [],
              rows: response.rows,
              transactionOpen: false,
            };
            this.statements.push(statement);
            await this.recorder.complete(statement);
          }
          event("returned");
          // The fixture supplies typed provider values; the generic driver has no schema.
          resolve(responses as QueryResult<T>[]);
        } catch (failure) {
          this.harnessFailure = failure;
          reject(failure);
        }
      });
      this.wake?.();
    });
  }

  /** Start all actors before selecting among their genuinely pending completions. */
  async drain<T>(work: Promise<T>, actorCount: number): Promise<T> {
    let settled = false;
    let outcome: { value: T } | { failure: unknown };
    const completion = work
      .then(
        (value) => {
          outcome = { value };
        },
        (failure) => {
          outcome = { failure };
        }
      )
      .finally(() => {
        settled = true;
        this.wake?.();
      });
    const wait = () =>
      new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    while (!settled && this.positions.size < actorCount) {
      if (this.harnessFailure !== undefined) throw this.harnessFailure;
      await wait();
    }
    while (!settled) {
      if (this.harnessFailure !== undefined) throw this.harnessFailure;
      if (this.pending.size === 0) {
        await wait();
        continue;
      }
      assert(this.released++ < 2_000, "Transport completion budget exceeded");
      const name = this.recorder.release([...this.pending.keys()]);
      const release = this.pending.get(name)!;
      this.pending.delete(name);
      await release();
    }
    if (this.harnessFailure !== undefined) throw this.harnessFailure;
    assert.equal(
      this.pending.size,
      0,
      "An operation finished with pending transport work"
    );
    await completion;
    if ("failure" in outcome!) throw outcome.failure;
    return outcome!.value;
  }

  finish(): void {
    if (this.harnessFailure !== undefined) throw this.harnessFailure;
    for (const script of this.scripts)
      assert.equal(
        this.positions.get(script.name),
        script.replies.length,
        `Unconsumed explicit replies: ${script.name}`
      );
    assert.equal(
      this.correlations.size,
      this.scripts.length,
      "Operations reused a correlation identity"
    );
  }
}
