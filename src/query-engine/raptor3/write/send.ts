/**
 * How a call's statements reach the database: one unit at a time. A dialogue
 * sends each statement once the one before answered, inside a transaction;
 * atomic batches send the statements that go together as one batch. Both
 * send the same statements.
 */
import type { AnyDriver } from "@drivers";
import { deriveStatementExecutionContext } from "@drivers/execution-context";
import { transferPreparedStatement } from "@drivers/prepared-statement-provenance";
import type { QueryExecutionContext } from "@drivers/types";
import { NestedWriteAssertionError } from "@errors";
import type { AnyModel } from "@schema/model";
import type { Sql } from "@sql";
import type { PreparedGuardFailure } from "../../types";
import type { Input } from "../shared/schema";
import type { SqlOperationContext } from "../shared/sql-operation-context";

/** What the database says of one statement. */
export interface Sent {
  readonly rows: Input[];
  readonly rowCount: number;
  readonly insertId?: unknown;
}

/** One statement, which suffices by itself, and the model it is sent in the name of. */
export interface Statement {
  readonly sql: Sql;
  readonly model: AnyModel;
  /** What it refuses with where it stops its unit. */
  readonly stops?: PreparedGuardFailure;
  /**
   * It stops its unit on what the call believed, not on what it may do: a
   * row it took to be there (`presumed`), or what it read (`read`). The call
   * is then run again on what the database says.
   */
  readonly believed?: "presumed" | "read";
  /** Its question by itself, where a provider does not say which statement stopped a batch. */
  readonly probe?: Sql;
  /** The answer a question asked for its own sake needs. */
  readonly premise?: "exists" | "notExists";
}

/** A unit stopped by one of its own statements: nothing of it was written. */
export class Stopped {
  readonly statement: Statement;
  constructor(statement: Statement) {
    this.statement = statement;
  }
}

/** How a unit of the call's statements reaches the database. */
export interface Transport {
  /** Rows the call read are held until its unit ends: no statement asks for them again. */
  readonly holds: boolean;
  /** Sends statements that go together and answers for each; `last` where the call has no more to say. */
  send(statements: readonly Statement[], last: boolean): Promise<Sent[]>;
  /** Ends the unit: undone where the call `failed`. */
  end(failed?: unknown): Promise<void>;
}

/** The context one statement is sent under: the operation's, named for the model it touches. */
export const contextOf = (
  operation: SqlOperationContext,
  model: AnyModel
): QueryExecutionContext => {
  const whole = operation.attribution;
  const name = model["~"].names.ts!;
  return whole.model === name
    ? whole
    : deriveStatementExecutionContext(whole, name);
};

/**
 * A dialogue: each statement is sent once the one before answered, inside
 * the unit `open` opens. On `driver` itself where there is none to open, or
 * where the call is one statement.
 */
export function dialogue(
  operation: SqlOperationContext,
  driver: AnyDriver,
  open?: (body: (inside: AnyDriver) => Promise<void>) => Promise<unknown>
): Transport {
  let entered: Promise<AnyDriver> | undefined;
  let unit: Promise<unknown> | undefined;
  let leave: (failed?: unknown) => void;
  const enter = () =>
    (entered ??= new Promise<AnyDriver>((inside, refused) => {
      unit = open!(
        (transport) =>
          new Promise<void>((done, undo) => {
            leave = (failed) => (failed === undefined ? done() : undo(failed));
            inside(transport);
          })
      );
      unit.catch(refused);
    }));
  return {
    holds: true,
    async send(statements, last) {
      const transport =
        !open || (last && !entered && statements.length === 1)
          ? driver
          : await enter();
      const answers: Sent[] = [];
      for (const statement of statements) {
        const at = contextOf(operation, statement.model);
        // What the call believed is asked, not asserted: a dialogue hears
        // the answer, and a statement that fails would undo its unit.
        const sent = await transport
          ._execute<Input>(
            statement.believed ? statement.probe! : statement.sql,
            at
          )
          .catch((error) => {
            if (process.env.VIBORM_DEBUG_SQL)
              console.error(
                "FAILED",
                transport._prepare(statement.sql, at).sql,
                error?.cause ?? error
              );
            throw statement.stops && error instanceof NestedWriteAssertionError
              ? new Stopped(statement)
              : error;
          });
        if (
          statement.believed &&
          sent.rows.length > 0 !== (statement.premise === "exists")
        )
          throw new Stopped(statement);
        answers.push(sent);
      }
      return answers;
    },
    async end(failed) {
      if (!entered) return;
      leave(failed);
      await (failed === undefined ? unit : unit!.catch(() => undefined));
    },
  };
}

/** One statement as a batch takes it. */
export const prepared = (
  operation: SqlOperationContext,
  driver: AnyDriver,
  statement: Statement
) => {
  const at = contextOf(operation, statement.model);
  const query = driver._prepare(statement.sql, at);
  return transferPreparedStatement(query, {
    sql: query.sql,
    params: query.params ?? [],
    context: at,
  });
};

/** Atomic batches: the statements that go together are one batch, durable once it answers. */
export function batches(
  operation: SqlOperationContext,
  driver: AnyDriver
): Transport {
  const send = async (
    statements: readonly Statement[],
    last = true
  ): Promise<Sent[]> => {
    const [alone] = statements;
    // What is more than one statement is one unit, or is not sent.
    if (statements.length > 1 || !last) operation.requireAtomicUnit();
    try {
      return statements.length === 1
        ? [
            await driver._execute<Input>(
              alone!.sql,
              contextOf(operation, alone!.model)
            ),
          ]
        : await driver._executeBatch<Input>(
            statements.map((statement) =>
              prepared(operation, driver, statement)
            ),
            undefined,
            operation.attribution
          );
    } catch (error) {
      if (!(error instanceof NestedWriteAssertionError)) throw error;
      // The statement that stopped the batch is the one the provider points
      // at. Where it points at none, what was asked for its own sake is
      // asked again together, then each judgement; where all still hold, it
      // is the first that judged its rows amid the batch's writes.
      const index = error.meta.statementIndex;
      const stopping = statements.filter((statement) => statement.stops);
      // The one statement that may stop the batch is the one that did.
      let stopped =
        typeof index === "number"
          ? statements[index]
          : stopping.length === 1
            ? stopping[0]
            : undefined;
      if (!stopped) {
        const asked = statements.filter((statement) => statement.premise);
        const answers =
          asked.length > 0
            ? await send(
                asked.map(({ probe, model }) => ({ sql: probe!, model }))
              )
            : [];
        stopped = asked.find(
          ({ premise }, at) =>
            answers[at]!.rows.length > 0 !== (premise === "exists")
        );
        for (const statement of stopped ? [] : statements) {
          if (statement.premise || !statement.probe) continue;
          stopped = await send([
            { sql: statement.probe, model: statement.model },
          ]).then(
            () => undefined,
            () => statement
          );
          if (stopped) break;
        }
      }
      stopped ??= statements.find(
        (statement) => statement.stops && !statement.probe
      );
      throw stopped?.stops ? new Stopped(stopped) : error;
    }
  };
  return { holds: false, send, end: async () => undefined };
}
