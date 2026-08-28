/**
 * Exact SQL framing for Migration V1.
 *
 * The blob is the human review artifact. Execution slices UTF-8 byte ranges.
 * There is no delimiter parser, breakpoint marker, or comment search.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import type { Sha256 } from "./identity";
import { encodeSqlBlob } from "./v1-parse";
import type { MigrationDispatchV1, MigrationSqlRangeV1 } from "./v1-types";

const DISPLAY_SEPARATOR = new TextEncoder().encode("\n\n");

export function encodeSqlText(text: string): Uint8Array {
  if (text.includes("\r")) {
    throw new MigrationError(
      "Manual SQL fragments containing carriage returns are refused",
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
  if (text.startsWith("\uFEFF")) {
    throw new MigrationError(
      "SQL blobs must be UTF-8 without a BOM",
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
  return new TextEncoder().encode(text);
}

export function composeSqlBlob(fragments: readonly string[]): {
  bytes: Uint8Array;
  ranges: MigrationSqlRangeV1[];
  sqlHash: Sha256;
} {
  const encoded = fragments.map(encodeSqlText);
  let total = 0;
  for (let i = 0; i < encoded.length; i++) {
    if (i > 0) total += DISPLAY_SEPARATOR.length;
    total += encoded[i]!.length;
  }
  const bytes = new Uint8Array(total);
  const ranges: MigrationSqlRangeV1[] = [];
  let offset = 0;
  for (let i = 0; i < encoded.length; i++) {
    if (i > 0) {
      bytes.set(DISPLAY_SEPARATOR, offset);
      offset += DISPLAY_SEPARATOR.length;
    }
    const fragment = encoded[i]!;
    bytes.set(fragment, offset);
    ranges.push({
      dispatchId: "",
      offset,
      length: fragment.length,
    });
    offset += fragment.length;
  }
  return {
    bytes,
    sqlHash: encodeSqlBlob(bytes),
    ranges,
  };
}

export function validateSqlRanges(
  bytes: Uint8Array,
  dispatches: readonly MigrationDispatchV1[]
): void {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw new MigrationError(
      "SQL blobs must be UTF-8 without a BOM",
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
  if (bytes.includes(0x0d)) {
    throw new MigrationError(
      "SQL blobs must be UTF-8/LF without carriage returns",
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
  const sqlHash = encodeSqlBlob(bytes);
  const unique: MigrationDispatchV1[] = [];
  const seen = new Set<string>();
  for (const dispatch of dispatches) {
    if (seen.has(dispatch.dispatchId)) continue;
    seen.add(dispatch.dispatchId);
    unique.push(dispatch);
  }
  const ordered = unique.sort(
    (left, right) => left.offset - right.offset || left.length - right.length
  );
  let previousEnd = 0;
  for (let index = 0; index < ordered.length; index++) {
    const dispatch = ordered[index]!;
    if (dispatch.sqlHash !== sqlHash) {
      throw new MigrationError(
        "Dispatch sqlHash does not match the SQL blob",
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    if (
      !(
        Number.isSafeInteger(dispatch.offset) &&
        Number.isSafeInteger(dispatch.length)
      ) ||
      dispatch.offset < 0 ||
      dispatch.length < 0
    ) {
      throw new MigrationError(
        "SQL ranges must use non-negative safe integers",
        VibORMErrorCode.MIGRATION_INVALID_ESTATE
      );
    }
    if (dispatch.offset + dispatch.length > bytes.length) {
      throw new MigrationError(
        "SQL range exceeds the blob",
        VibORMErrorCode.MIGRATION_INVALID_ESTATE
      );
    }
    if (index === 0) {
      if (dispatch.offset !== 0) {
        throw new MigrationError(
          "SQL ranges must begin at byte zero",
          VibORMErrorCode.MIGRATION_INVALID_ESTATE
        );
      }
    } else {
      const expectedOffset = previousEnd + DISPLAY_SEPARATOR.length;
      if (dispatch.offset !== expectedOffset) {
        throw new MigrationError(
          dispatch.offset < expectedOffset
            ? "SQL ranges overlap or omit their separator"
            : "SQL ranges contain an unclaimed gap",
          VibORMErrorCode.MIGRATION_INVALID_ESTATE
        );
      }
      if (bytes[previousEnd] !== 0x0a || bytes[previousEnd + 1] !== 0x0a) {
        throw new MigrationError(
          "SQL range separators must be exactly two newline bytes",
          VibORMErrorCode.MIGRATION_INVALID_ESTATE
        );
      }
    }
    previousEnd = dispatch.offset + dispatch.length;
  }
  if (ordered.length === 0) {
    if (bytes.length === 0) return;
    throw new MigrationError(
      "A SQL blob without dispatches must be empty",
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
  if (previousEnd === bytes.length) return;
  if (previousEnd + 1 === bytes.length && bytes[previousEnd] === 0x0a) {
    return;
  }
  throw new MigrationError(
    "SQL blobs contain bytes after the final range",
    VibORMErrorCode.MIGRATION_INVALID_ESTATE
  );
}

export function sliceDispatch(
  bytes: Uint8Array,
  dispatch: MigrationDispatchV1
): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(dispatch.offset, dispatch.offset + dispatch.length)
  );
}

const MYSQL_DELIMITER = /(^|\s)DELIMITER\s/i;

export function refuseMysqlDelimiter(text: string): void {
  if (MYSQL_DELIMITER.test(text)) {
    throw new MigrationError(
      "MySQL DELIMITER is a client command, not server SQL",
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
}
