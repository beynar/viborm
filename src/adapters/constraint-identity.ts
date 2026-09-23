/** The exact normalized provider evidence that identifies one constraint. */
export interface NormalizedConstraintDescriptor {
  readonly table?: string;
  readonly constraint?: string;
  readonly columns?: readonly string[];
}

export interface ConstraintIdentity {
  readonly name: string;
  readonly normalizedError: NormalizedConstraintDescriptor;
}

/** Private adapter projection from a schema key to its physical identity. */
export interface ConstraintIdentities {
  readonly primaryKey: (
    tableName: string,
    columns: readonly string[]
  ) => ConstraintIdentity;
  readonly unique: (
    tableName: string,
    keyName: string,
    columns: readonly string[]
  ) => ConstraintIdentity;
}

/** PostgreSQL/MySQL errors identify named constraints and their table. */
export function createNamedConstraintIdentities(
  primaryKeyName: (tableName: string) => string
): ConstraintIdentities {
  const identity = (tableName: string, name: string): ConstraintIdentity => ({
    name,
    normalizedError: { table: tableName, constraint: name },
  });
  return {
    primaryKey: (tableName) => identity(tableName, primaryKeyName(tableName)),
    unique: (tableName, keyName) =>
      identity(tableName, `${tableName}_${keyName}_key`),
  };
}

/** SQLite errors identify a constraint through qualified physical columns. */
export const sqliteConstraintIdentities: ConstraintIdentities = {
  primaryKey: (tableName, columns) => ({
    name: `${tableName}_pkey`,
    normalizedError: {
      columns: columns.map((column) => `${tableName}.${column}`),
    },
  }),
  unique: (tableName, keyName, columns) => ({
    name: `${tableName}_${keyName}_key`,
    normalizedError: {
      columns: columns.map((column) => `${tableName}.${column}`),
    },
  }),
};
