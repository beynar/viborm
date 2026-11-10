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
import { acquireWithMaxWait } from "../shared/transaction-options";

const CONFLICT = /can be retried|read or write conflict/;

/** What a statement throws where a row it would leave is not permitted. */
/** The mark a waiting write's `THROW` carries, and its index in the text it went with. */
export const WAITING_FAILED = /viborm:waiting:(\d+)/;

export const FORBIDDEN_ROW = "viborm: a row this write leaves is not permitted";

/** Two transactions that met at commit, in the words SurrealDB has for it. */
export function isConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (CONFLICT.test(error.message) ||
      (error.cause instanceof Error && CONFLICT.test(error.cause.message)))
  );
}

/**
 * What may write wherever it stands in a text: a statement, a subquery or a block
 * (keywords are any case), or a function defined in the database or a module.
 */
const MAY_WRITE =
  /\b(?:CREATE|UPDATE|UPSERT|DELETE|INSERT|RELATE|DEFINE|REMOVE|ALTER|REBUILD)\b|\b(?:fn|mod|silo|api)::/i;
const SELECTS = /^SELECT\b/i;
/** The form that reports a conflict by answering nothing, having written nothing. */
const IGNORES_CONFLICT = /^INSERT IGNORE\b/i;
/** A clause after which an insert answers nothing, whether it wrote or not. */
const ANSWERS_NOTHING = /\bRETURN\s+(?:NONE|BEFORE|VALUE\s+NONE)\b/i;
const NEXT_VALUE = /sequence::nextval\(\$(p\d+)\)/g;

/** Each attempt is won by someone, so this bounds the writers that can meet at once. */
export const COMMITS = 16;

interface Statement {
  text: string;
  values: Record<string, unknown>;
  /** Absent when it failed, having perhaps written part of its change. */
  answer?: unknown;
}

/**
 * A read that writes nowhere in its text, or one ignored insert, alone in its text,
 * that answers no row although it answers each row it writes.
 */
const wroteNothing = ({ text, answer }: Statement) => {
  if (SELECTS.test(text)) return !MAY_WRITE.test(text);
  const rest = text.replace(IGNORES_CONFLICT, "");
  return (
    rest !== text &&
    !(MAY_WRITE.test(rest) || ANSWERS_NOTHING.test(rest)) &&
    Array.isArray(answer) &&
    answer.length === 1 &&
    Array.isArray(answer[0]) &&
    answer[0].length === 0
  );
};

const asText = (answer: unknown) =>
  JSON.stringify(answer, (_key, value) =>
    typeof value === "bigint" ? `${value}n` : value
  );

/**
 * A connection holds 64 open transactions and refuses the next ("Too many open
 * transactions"), so the others wait for one to end, as they would for a pool.
 */
const OPEN_TRANSACTIONS = 64;

class Slots {
  #free = OPEN_TRANSACTIONS;
  readonly #waiting: (() => void)[] = [];

  async take(): Promise<void> {
    if (this.#free > 0) {
      this.#free -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
  }

  give(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#free += 1;
  }
}

const slotsOf = new WeakMap<Surreal, Slots>();

export class ReplayedTransaction {
  readonly #client: Surreal;
  readonly #slots: Slots;
  #open: SurrealTransaction;
  #ended = false;
  readonly #log: Statement[] = [];
  #conflicted = false;

  private constructor(client: Surreal, slots: Slots, open: SurrealTransaction) {
    this.#client = client;
    this.#slots = slots;
    this.#open = open;
  }

  static async begin(
    client: Surreal,
    maxWaitMs?: number
  ): Promise<ReplayedTransaction> {
    let slots = slotsOf.get(client);
    if (!slots) {
      slots = new Slots();
      slotsOf.set(client, slots);
    }
    const held = slots;
    await acquireWithMaxWait(
      () => held.take(),
      () => held.give(),
      maxWaitMs,
      { driverName: "surrealdb", form: "callback" }
    );
    try {
      return new ReplayedTransaction(
        client,
        slots,
        await client.beginTransaction()
      );
    } catch (error) {
      slots.give();
      throw error;
    }
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#slots.give();
  }

  /** A concurrent write changed what it was told, whatever the caller then did. */
  get conflicted(): boolean {
    return this.#conflicted;
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
      if (asText(answer) !== asText(statement.answer)) {
        this.#conflicted = true;
        throw new TransactionError(
          "A concurrent write changed what this transaction read, so it cannot go on. This transaction can be retried."
        );
      }
    }
  }

  /** A write conflict leaves nothing applied, so the statements can run again. */
  async commit(): Promise<void> {
    try {
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
    } catch (error) {
      // A replay that found another answer leaves its transaction open.
      await this.#open.cancel().catch(() => undefined);
      throw error;
    } finally {
      this.#end();
    }
  }

  async cancel(): Promise<void> {
    try {
      await this.#open.cancel();
    } finally {
      this.#end();
    }
  }
}
