import { VibORMError, VibORMErrorCode, type VibORMErrorMeta } from "./base";

/**
 * Transaction errors
 */
export class TransactionError extends VibORMError {
  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      meta?: VibORMErrorMeta | undefined;
      code?: VibORMErrorCode | undefined;
    }
  ) {
    const opts: { cause?: Error; meta?: VibORMErrorMeta } = {};
    if (options?.cause) opts.cause = options.cause;
    if (options?.meta) opts.meta = options.meta;
    super(message, options?.code ?? VibORMErrorCode.TRANSACTION_FAILED, opts);
    this.name = "TransactionError";
  }
}

/**
 * Invalid input passed to $transaction array mode
 */
export class InvalidTransactionInputError extends VibORMError {
  constructor(options?: { meta?: VibORMErrorMeta }) {
    super(
      "$transaction array must contain only pending operations from client methods",
      VibORMErrorCode.INVALID_TRANSACTION_INPUT,
      { meta: options?.meta }
    );
    this.name = "InvalidTransactionInputError";
  }
}
