import {
  Operation,
  OperationPayload,
  OperationResult,
} from "./operations/defintion";
import type { Schema } from "./schema";

export type Client<S extends Schema> = {
  [K in keyof S]: {
    [O in Operation]: <P extends OperationPayload<O, S[K]>>(
      args: P
    ) => OperationResult<O, S[K], P>;
  };
};
