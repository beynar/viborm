/** Internal execution-kind metadata for prepared batch queries. */

const VERBATIM_BATCH_QUERY = Symbol("viborm.verbatimBatchQuery");

/** Mark a prepared raw statement that must retain verbatim driver semantics. */
export function markVerbatimBatchQuery<T extends object>(query: T): T {
  Object.defineProperty(query, VERBATIM_BATCH_QUERY, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return query;
}

/** Whether a prepared statement came from an unsafe or legacy raw call. */
export function isVerbatimBatchQuery(query: object): boolean {
  return Reflect.get(query, VERBATIM_BATCH_QUERY) === true;
}
