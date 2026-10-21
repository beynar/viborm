/** findUnique batching on PGlite: one read per tick, each caller its own answer. */

import type { QueryExecutionContext } from "@drivers/driver";
import { PGliteDriver } from "@drivers/pglite";
import type { QueryResult } from "@drivers/types";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import {
  type RecordingDriver,
  runFindUniqueBatchingBehavior,
} from "@tests/contracts/public-client/find-unique-batching-behavior";

class RecordingPGliteDriver extends PGliteDriver implements RecordingDriver {
  readonly statements: string[] = [];
  failWhen: ((statement: string) => boolean) | undefined;

  protected override async execute<T>(
    client: PGlite | Transaction,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    if (this.failWhen?.(statement))
      throw new Error("injected statement failure");
    return super.execute<T>(client, statement, parameters, context);
  }
}

runFindUniqueBatchingBehavior({
  name: "PGlite",
  createDriver: () => new RecordingPGliteDriver(),
});
