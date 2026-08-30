import { Sql } from "@sql";

const preparedStatements = new WeakMap<object, Sql>();

/** Retain the typed Sql behind a rendered batch query without publishing it. */
export function registerPreparedStatement(query: object, statement: Sql): void {
  preparedStatements.set(query, statement);
}

/** Preserve private provenance when an internal owner snapshots a batch query. */
export function transferPreparedStatement<Output extends object>(
  source: object,
  output: Output
): Output {
  const statement = preparedStatements.get(source);
  if (statement !== undefined) preparedStatements.set(output, statement);
  return output;
}

/** Preserve provenance with the exact detached values a batch will execute. */
export function snapshotPreparedStatement<Output extends object>(
  source: object,
  output: Output,
  values: readonly unknown[]
): Output {
  const statement = preparedStatements.get(source);
  if (statement !== undefined) {
    preparedStatements.set(
      output,
      new Sql([...statement.strings], [...values])
    );
  }
  return output;
}

/** Read provenance only at the trusted typed-statement execution boundary. */
export function readPreparedStatement(query: object): Sql | undefined {
  return preparedStatements.get(query);
}
