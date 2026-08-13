export type TransportAtomicity = "statement" | "operation" | "segment";

export interface TransactionEnvelopeCensus {
  readonly begin: number;
  readonly commit: number;
  readonly rollback: number;
  readonly savepoints: number;
}

/**
 * The transport costs observed by a test substrate.
 *
 * `executeCalls` counts single-statement driver body calls. Native provider
 * batch bodies are counted separately, so their sum is the total number of
 * driver body calls. `providerRequests` remains `"not-measured"` unless the
 * fixture observes the real remote protocol boundary.
 */
export interface TransportCensus {
  readonly sqlStatements: number;
  readonly executeCalls: number;
  readonly nativeBatchCalls: number;
  readonly providerRequests: number | "not-measured";
  readonly atomicity: TransportAtomicity;
  readonly committedWriteSegments: number;
  readonly transactionEnvelope: TransactionEnvelopeCensus;
}

export interface TransportCensusOptions {
  readonly providerRequests: number | "not-measured";
  readonly atomicity: TransportAtomicity;
}

export class TransportCensusRecorder {
  private readonly options: TransportCensusOptions;
  private sqlStatements = 0;
  private executeCalls = 0;
  private nativeBatchCalls = 0;
  private providerRequests: number | "not-measured";
  private committedWriteSegments = 0;
  private begin = 0;
  private commit = 0;
  private rollback = 0;
  private savepoints = 0;

  constructor(options: TransportCensusOptions) {
    this.options = options;
    this.providerRequests = options.providerRequests;
  }

  recordExecuteCall(): void {
    this.executeCalls += 1;
    this.sqlStatements += 1;
  }

  recordNativeBatchCall(statementCount: number): void {
    this.nativeBatchCalls += 1;
    this.sqlStatements += statementCount;
  }

  recordProviderRequest(): void {
    if (this.providerRequests === "not-measured") {
      throw new Error("Provider requests are not measured by this census.");
    }
    this.providerRequests += 1;
  }

  recordCommittedWriteSegment(): void {
    this.committedWriteSegments += 1;
  }

  recordBegin(): void {
    this.begin += 1;
  }

  recordCommit(): void {
    this.commit += 1;
  }

  recordRollback(): void {
    this.rollback += 1;
  }

  recordSavepoint(): void {
    this.savepoints += 1;
  }

  reset(): void {
    this.sqlStatements = 0;
    this.executeCalls = 0;
    this.nativeBatchCalls = 0;
    this.providerRequests =
      this.options.providerRequests === "not-measured" ? "not-measured" : 0;
    this.committedWriteSegments = 0;
    this.begin = 0;
    this.commit = 0;
    this.rollback = 0;
    this.savepoints = 0;
  }

  snapshot(): TransportCensus {
    return {
      sqlStatements: this.sqlStatements,
      executeCalls: this.executeCalls,
      nativeBatchCalls: this.nativeBatchCalls,
      providerRequests: this.providerRequests,
      atomicity: this.options.atomicity,
      committedWriteSegments: this.committedWriteSegments,
      transactionEnvelope: {
        begin: this.begin,
        commit: this.commit,
        rollback: this.rollback,
        savepoints: this.savepoints,
      },
    };
  }
}
