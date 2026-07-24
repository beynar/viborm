import { VibORMError, VibORMErrorCode, type VibORMErrorMeta } from "./base";
import type { DiagnosticDisclosure } from "./diagnostics";

/**
 * Transaction errors
 */
export class TransactionError extends VibORMError {
  static override readonly diagnosticName = "TransactionError";

  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      diagnostics?: DiagnosticDisclosure | undefined;
      meta?: VibORMErrorMeta | undefined;
      code?: VibORMErrorCode | undefined;
    }
  ) {
    const opts: {
      cause?: Error;
      diagnostics?: DiagnosticDisclosure;
      meta?: VibORMErrorMeta;
    } = {};
    if (options?.cause) opts.cause = options.cause;
    if (options?.diagnostics) opts.diagnostics = options.diagnostics;
    if (options?.meta) opts.meta = options.meta;
    super(message, options?.code ?? VibORMErrorCode.TRANSACTION_FAILED, opts);
  }
}

/**
 * Invalid input passed to $transaction array mode
 */
export class InvalidTransactionInputError extends VibORMError {
  static override readonly diagnosticName = "InvalidTransactionInputError";

  constructor(options?: { meta?: VibORMErrorMeta }) {
    super(
      "$transaction array must contain only pending operations from client methods",
      VibORMErrorCode.INVALID_TRANSACTION_INPUT,
      { meta: options?.meta }
    );
  }
}
