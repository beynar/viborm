/** The reads the query page runs: a delegate's, never a write. Shared with the page, which lists them. */
export const QUERY_OPERATIONS = [
  "findMany",
  "findFirst",
  "findUnique",
  "count",
  "aggregate",
  "groupBy",
] as const;

export type QueryOperation = (typeof QUERY_OPERATIONS)[number];
