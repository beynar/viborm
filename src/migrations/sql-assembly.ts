/**
 * One SQL blob builder. Every check and effect dispatch in a state shares
 * one content-addressed blob. No second blob for rollback.
 */

import type { Sha256 } from "./identity";
import { composeSqlBlob, refuseMysqlDelimiter } from "./sql-blob";
import { encodeDispatchIdentity } from "./v1-parse";
import type { MigrationDispatchV1, MigrationParameterV1 } from "./v1-types";

interface PendingFragment {
  readonly text: string;
  readonly parameters: readonly MigrationParameterV1[];
}

export class SqlAssembly {
  private readonly pending: PendingFragment[] = [];

  add(text: string, parameters: readonly MigrationParameterV1[] = []): number {
    refuseMysqlDelimiter(text);
    this.pending.push({ text, parameters });
    return this.pending.length - 1;
  }

  seal(): {
    readonly bytes: Uint8Array;
    readonly sqlHash: Sha256;
    readonly dispatches: readonly MigrationDispatchV1[];
  } {
    const blob = composeSqlBlob(this.pending.map((fragment) => fragment.text));
    const dispatches = this.pending.map((fragment, index) => {
      const range = blob.ranges[index]!;
      return {
        dispatchId: encodeDispatchIdentity(
          blob.sqlHash,
          range.offset,
          range.length,
          fragment.parameters
        ),
        sqlHash: blob.sqlHash,
        offset: range.offset,
        length: range.length,
        parameters: fragment.parameters,
      };
    });
    return { bytes: blob.bytes, sqlHash: blob.sqlHash, dispatches };
  }
}
