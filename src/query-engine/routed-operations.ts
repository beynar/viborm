/**
 * The client operation vocabulary, retained at the C-01 cutover.
 *
 * These four names are the only part of the deleted shipped routing module that
 * owners OUTSIDE the engine consume: the client (`isWriteOperation`), the
 * official cache (`isWriteOperation`), the extension surface
 * (`ROUTED_OPERATIONS`) and the query-interception seam (`isReadOperation`).
 * The text below is the deleted `write-engine/routing.ts` definitions verbatim,
 * so no operation changes classification at the cutover.
 */

const READ_OPERATIONS: ReadonlySet<string> = new Set([
  "findMany",
  "findUnique",
  "findFirst",
  "findUniqueOrThrow",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "exist",
]);

/** Whether a public operation routes through the engine's read owner. */
export function isReadOperation(operation: string): boolean {
  return READ_OPERATIONS.has(operation);
}

/**
 * The operation names the engine owns a construction path for. Every client
 * operation family is here; a name outside it (there is none on the client path)
 * resolves to `undefined`.
 */
export const ROUTED_OPERATIONS: ReadonlySet<string> = new Set([
  ...READ_OPERATIONS,
  "create",
  "update",
  "delete",
  "upsert",
  "createMany",
  "updateMany",
  "deleteMany",
]);

/** Whether a public operation routes through the engine's write owner. */
export function isWriteOperation(operation: string): boolean {
  return ROUTED_OPERATIONS.has(operation) && !isReadOperation(operation);
}
