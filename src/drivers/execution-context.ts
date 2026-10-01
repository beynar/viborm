import type { ResolvedExtensionChain } from "@extensions/chain";
import type { QueryExecutionContext } from "./types";

interface TrustedExecutionContext {
  readonly correlationId?: string;
  readonly correlationIdGetter?: () => string;
  readonly extensionChain?: ResolvedExtensionChain;
  readonly model?: string;
  readonly operation?: string;
  readonly transactionPhases?: TransactionPhaseNotifications;
}

/** Private exact transaction lifecycle facts attached only to trusted contexts. */
export interface TransactionPhaseNotifications {
  readonly readyToCommit: () => void;
  readonly committed: () => void;
}

/**
 * A context this owner created. The private field is the trust mark: nothing
 * outside this class can set or read it, so a caller cannot forge one, and
 * checking it is cheaper than the per-query WeakMap entry it replaces.
 */
class TrustedSnapshot {
  readonly #values: TrustedExecutionContext;
  readonly model?: string;
  readonly operation: string | undefined;
  readonly correlationId?: string;
  constructor(values: TrustedExecutionContext) {
    this.#values = values;
    if (values.model) this.model = values.model;
    this.operation = values.operation;
    if (values.correlationIdGetter) {
      Object.defineProperty(this, "correlationId", {
        configurable: false,
        enumerable: true,
        get: values.correlationIdGetter,
      });
    } else if (values.correlationId) this.correlationId = values.correlationId;
    Object.freeze(this);
  }
  static values(context: object): TrustedExecutionContext | undefined {
    return #values in context
      ? (context as TrustedSnapshot).#values
      : undefined;
  }
}
const trusted = (context: object) => TrustedSnapshot.values(context);

export function createExecutionContext(
  values: QueryExecutionContext,
  correlationIdFactory?: () => string,
  extensionChain?: ResolvedExtensionChain
): QueryExecutionContext {
  if (!correlationIdFactory) {
    return snapshotExecutionContext(
      values,
      undefined,
      undefined,
      extensionChain
    );
  }

  let correlationId: string | undefined;
  const correlationIdGetter = () => {
    correlationId ??= correlationIdFactory();
    return correlationId;
  };
  return createTrustedExecutionContext({
    correlationIdGetter,
    extensionChain,
    model: readString(values, "model"),
    operation: readString(values, "operation"),
  });
}

export function snapshotExecutionContext(
  context: QueryExecutionContext | undefined,
  boundContext?: QueryExecutionContext,
  fallbackOperation?: string,
  extensionChainOverride?: ResolvedExtensionChain
): QueryExecutionContext {
  const trustedContext = context ? trusted(context) : undefined;
  const contextValues =
    trustedContext ?? snapshotExternalExecutionContext(context);
  const trustedBoundContext = boundContext ? trusted(boundContext) : undefined;
  const boundValues =
    context === boundContext
      ? contextValues
      : (trustedBoundContext ?? snapshotExternalExecutionContext(boundContext));
  const model = contextValues.model ?? boundValues.model;
  const operation =
    contextValues.operation ?? boundValues.operation ?? fallbackOperation;
  const correlationIdGetter =
    contextValues.correlationIdGetter ??
    (contextValues.correlationId === undefined
      ? boundValues.correlationIdGetter
      : undefined);
  const correlationId = correlationIdGetter
    ? undefined
    : (contextValues.correlationId ?? boundValues.correlationId);
  const extensionChain =
    contextValues.extensionChain ??
    boundValues.extensionChain ??
    extensionChainOverride;
  const transactionPhases =
    contextValues.transactionPhases ?? boundValues.transactionPhases;

  if (
    context &&
    trustedContext &&
    representsExecutionContext(
      trustedContext,
      model,
      operation,
      correlationId,
      correlationIdGetter,
      extensionChain,
      transactionPhases
    )
  ) {
    return context;
  }
  if (
    boundContext &&
    trustedBoundContext &&
    representsExecutionContext(
      trustedBoundContext,
      model,
      operation,
      correlationId,
      correlationIdGetter,
      extensionChain,
      transactionPhases
    )
  ) {
    return boundContext;
  }

  return createTrustedExecutionContext({
    correlationId,
    correlationIdGetter,
    extensionChain,
    model,
    operation,
    transactionPhases,
  });
}

/**
 * Re-attribute a trusted context to the model one statement addresses, keeping
 * the correlation id and extension provenance of the operation
 * it belongs to. Only the snapshot owner can do this without losing the private
 * values, which is why the query engine asks for it rather than rebuilding one.
 */
export function deriveStatementExecutionContext(
  context: QueryExecutionContext,
  model: string
): QueryExecutionContext {
  const values = trusted(context) ?? snapshotExternalExecutionContext(context);
  return createTrustedExecutionContext({ ...values, model });
}

/** Read only the chain attached by the trusted context owner. */
export function getExecutionExtensionChain(
  context: QueryExecutionContext | undefined
): ResolvedExtensionChain | undefined {
  if (!context) return undefined;
  return trusted(context)?.extensionChain;
}

/** Attach private lifecycle notifications without accepting caller-spoofed state. */
export function bindExecutionTransactionPhases(
  context: QueryExecutionContext,
  transactionPhases: TransactionPhaseNotifications
): QueryExecutionContext {
  const values = trusted(context) ?? snapshotExternalExecutionContext(context);
  return createTrustedExecutionContext({ ...values, transactionPhases });
}

/** Add one private lifecycle reader without replacing an existing consumer. */
export function appendExecutionTransactionPhases(
  context: QueryExecutionContext,
  appendedPhases: TransactionPhaseNotifications
): QueryExecutionContext {
  const values = trusted(context) ?? snapshotExternalExecutionContext(context);
  const existingPhases = values.transactionPhases;
  if (existingPhases === undefined) {
    return createTrustedExecutionContext({
      ...values,
      transactionPhases: appendedPhases,
    });
  }
  return createTrustedExecutionContext({
    ...values,
    transactionPhases: {
      readyToCommit: () => {
        appendedPhases.readyToCommit();
        existingPhases.readyToCommit();
      },
      committed: () => {
        appendedPhases.committed();
        existingPhases.committed();
      },
    },
  });
}

/** Read lifecycle notifications only from a context created by this owner. */
export function getExecutionTransactionPhases(
  context: QueryExecutionContext | undefined
): TransactionPhaseNotifications | undefined {
  if (!context) return undefined;
  return trusted(context)?.transactionPhases;
}

function createTrustedExecutionContext(
  values: TrustedExecutionContext
): QueryExecutionContext {
  return new TrustedSnapshot(values) as QueryExecutionContext;
}

function snapshotExternalExecutionContext(
  value: QueryExecutionContext | undefined
): TrustedExecutionContext {
  return {
    correlationId: readString(value, "correlationId"),
    model: readString(value, "model"),
    operation: readString(value, "operation"),
  };
}

function representsExecutionContext(
  values: TrustedExecutionContext,
  model: string | undefined,
  operation: string | undefined,
  correlationId: string | undefined,
  correlationIdGetter: (() => string) | undefined,
  extensionChain: ResolvedExtensionChain | undefined,
  transactionPhases: TransactionPhaseNotifications | undefined
): boolean {
  return (
    values.model === model &&
    values.operation === operation &&
    values.correlationId === correlationId &&
    values.correlationIdGetter === correlationIdGetter &&
    values.extensionChain === extensionChain &&
    values.transactionPhases === transactionPhases
  );
}

function readString(
  value: QueryExecutionContext | undefined,
  key: keyof QueryExecutionContext
): string | undefined {
  const member = readProperty(value, key);
  return typeof member === "string" ? member : undefined;
}

function readProperty(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || !value) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}
