/**
 * A SurrealDB transaction that can go back.
 *
 * SurrealQL has no savepoints, and writers meet at commit, where the loser has
 * written nothing. Both are answered by the same record: every statement this
 * transaction ran, with what it answered. Going back is a new transaction running
 * those statements again.
 *
 * That is sound when every statement answers as it did: nothing the caller was
 * told has changed, so it cannot tell this transaction from one that began later.
 * A different answer ends it with a conflict, since what the caller decided from
 * no longer holds. The new transaction sees newer rows, so a read is checked as
 * strictly as a write. Holding the answers costs no work until they are compared.
 */

import { TransactionError } from "@errors";
import type { Surreal, SurrealTransaction } from "surrealdb";

const CONFLICT = /can be retried|read or write conflict/;

/** Two transactions that met at commit, in the words SurrealDB has for it. */
export function isConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (CONFLICT.test(error.message) ||
      (error.cause instanceof Error && CONFLICT.test(error.cause.message)))
  );
}

/** A statement that cannot have written, whatever it answers. */
const READS_ONLY =
  /^SELECT\b(?!.*\b(?:CREATE|UPDATE|UPSERT|DELETE|INSERT|RELATE|fn::))/s;
/** The form that reports a conflict by answering nothing, having written nothing. */
const IGNORES_CONFLICT = /^INSERT IGNORE\b/;
const NEXT_VALUE = /sequence::nextval\(\$(p\d+)\)/g;

/** Each attempt is won by someone, so this bounds the writers that can meet at once. */
const COMMITS = 16;

interface Statement {
  text: string;
  values: Record<string, unknown>;
  /** Absent when it failed, having perhaps written part of its change. */
  answer?: unknown;
}

const wroteNothing = ({ text, answer }: Statement) =>
  READS_ONLY.test(text) ||
  (IGNORES_CONFLICT.test(text) &&
    Array.isArray(answer) &&
    answer.flat().length === 0);

const asText = (answer: unknown) =>
  JSON.stringify(answer, (_key, value) =>
    typeof value === "bigint" ? `${value}n` : value
  );

export class ReplayedTransaction {
  readonly #client: Surreal;
  #open: SurrealTransaction;
  readonly #log: Statement[] = [];

  private constructor(client: Surreal, open: SurrealTransaction) {
    this.#client = client;
    this.#open = open;
  }

  static async begin(client: Surreal): Promise<ReplayedTransaction> {
    return new ReplayedTransaction(client, await client.beginTransaction());
  }

  /** How far this transaction has come, to {@link rollbackTo} later. */
  get mark(): number {
    return this.#log.length;
  }

  async query<R>(text: string, values: Record<string, unknown>): Promise<R> {
    const statement: Statement = { text, values };
    // In the order they were sent, whichever answers first.
    this.#log.push(statement);
    await this.#reserveSequences(statement);
    statement.answer = await this.#open.query(statement.text, statement.values);
    return statement.answer as R;
  }

  /**
   * A sequence stands outside any transaction, so a statement running again would
   * take another value. Each is taken ahead instead, and the statement holds it.
   */
  async #reserveSequences(statement: Statement): Promise<void> {
    const taken = [...statement.text.matchAll(NEXT_VALUE)];
    if (taken.length === 0) return;
    const [reserved] = await this.#client.query<[unknown[]]>(
      `RETURN [${taken.map(([call]) => call).join(", ")}]`,
      statement.values
    );
    const values = { ...statement.values };
    let index = 0;
    statement.text = statement.text.replace(NEXT_VALUE, () => {
      const name = `reserved${index}`;
      values[name] = reserved[index++];
      return `$${name}`;
    });
    statement.values = values;
  }

  /**
   * What a savepoint's rollback does: everything after `mark` never happened. Only
   * statements that cannot have written are left to stand without running the
   * others again, since the server refuses to commit over a partial write.
   */
  async rollbackTo(mark: number): Promise<void> {
    if (!this.#log.splice(mark).every(wroteNothing)) await this.#replay();
  }

  async #replay(): Promise<void> {
    await this.#open.cancel().catch(() => undefined);
    this.#open = await this.#client.beginTransaction();
    for (const statement of this.#log) {
      const answer = await this.#open.query(statement.text, statement.values);
      if (asText(answer) !== asText(statement.answer))
        throw new TransactionError(
          "A concurrent write changed what this transaction read, so it cannot go on. This transaction can be retried."
        );
    }
  }

  /** A write conflict leaves nothing applied, so the statements can run again. */
  async commit(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#open.commit();
        return;
      } catch (error) {
        if (!isConflict(error) || attempt === COMMITS) throw error;
      }
      // Two losers running again together would only meet again.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * 10 * attempt)
      );
      await this.#replay();
    }
  }

  async cancel(): Promise<void> {
    await this.#open.cancel();
  }
}
