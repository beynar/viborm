import { VibORMError, VibORMErrorCode, type VibORMErrorMeta } from "./base";
import type { DiagnosticDisclosure } from "./diagnostics";

/**
 * Every code {@link TransactionError} can carry.
 *
 * A family, not a single literal: the driver error mapping raises the same class for a plain
 * failure, a timeout, a deadlock and a serialization failure, and the retry policy reads the
 * code to tell them apart. `INVALID_TRANSACTION_INPUT` is in the union too — the transaction
 * OPTION refusals (`drivers/shared/transaction-options.ts`) raise it through this class, while
 * {@link InvalidTransactionInputError} owns the `$transaction([...])` array-form refusal.
 * Measured at the construction sites; the two are told apart by class, not by code.
 */
export type TransactionErrorCode =
  | typeof VibORMErrorCode.TRANSACTION_FAILED
  | typeof VibORMErrorCode.TRANSACTION_TIMEOUT
  | typeof VibORMErrorCode.DEADLOCK
  | typeof VibORMErrorCode.SERIALIZATION_FAILURE
  | typeof VibORMErrorCode.INVALID_TRANSACTION_INPUT;

/**
 * Transaction errors
 */
export class TransactionError extends VibORMError {
  static override readonly diagnosticName = "TransactionError";

  /** Discriminant: one of {@link TransactionErrorCode}, never a code outside the family. */
  declare readonly code: TransactionErrorCode;

  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      diagnostics?: DiagnosticDisclosure | undefined;
      meta?: VibORMErrorMeta | undefined;
      code?: TransactionErrorCode | undefined;
    }
  ) {
    super(message, options?.code ?? VibORMErrorCode.TRANSACTION_FAILED, options);
  }
}

/**
 * Invalid input passed to $transaction array mode
 */
export class InvalidTransactionInputError extends VibORMError {
  static override readonly diagnosticName = "InvalidTransactionInputError";

  /** Literal discriminant: this class always carries `INVALID_TRANSACTION_INPUT`. */
  declare readonly code: typeof VibORMErrorCode.INVALID_TRANSACTION_INPUT;

  constructor(options?: { meta?: VibORMErrorMeta }) {
    super(
      "$transaction array must contain only pending operations from client methods",
      VibORMErrorCode.INVALID_TRANSACTION_INPUT,
      options
    );
  }
}
