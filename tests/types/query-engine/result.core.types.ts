import type { RawQueryResult, ResultParser } from "@src/query-engine/types";

const rowCountParser: ResultParser<number> = (raw: RawQueryResult) =>
  Array.isArray(raw) ? raw.length : raw.rowCount;

const parsedCount: number = rowCountParser([{ id: "1" }]);

// @ts-expect-error - parsers preserve their declared output type
const refusedCount: string = rowCountParser({ rowCount: 1 });

void parsedCount;
void refusedCount;
