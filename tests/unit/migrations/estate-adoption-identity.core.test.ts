/**
 * `adopts` on a parent transition: optional, hashed only when present, and
 * admitted by the closed parser only in its one canonical encoding.
 */

import { VibORMErrorCode } from "@src/errors";
import { utf8Bytes } from "@src/migrations/identity";
import { renderMigrationReview } from "@src/migrations/public-view";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import {
  encodeDispatchIdentity,
  encodeStateManifest,
  encodeTransitionHash,
  parseStateManifest,
} from "@src/migrations/v1-parse";
import type { MigrationParentTransitionV1 } from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";

describe("the adopts field of a transition", () => {
  // The body `generate-destructive-approval.core.test.ts` pins against the
  // 1.1.0 encoder: absent adopts must leave its ids exactly as they were.
  const blob = composeSqlBlob([
    'ALTER TABLE "account" DROP COLUMN "legacyCode"',
  ]);
  const execute = {
    dispatchId: encodeDispatchIdentity(blob.sqlHash, 0, blob.bytes.length, []),
    sqlHash: blob.sqlHash,
    offset: 0,
    length: blob.bytes.length,
    parameters: [],
  };
  const body: Omit<MigrationParentTransitionV1, "transitionHash"> = {
    fromState: null,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [
      {
        id: "op",
        label: "Drop column account.legacyCode",
        origin: "generated",
        risk: "destructive",
        steps: [{ retry: "opaque", execute }],
      },
    ],
    rollback: { kind: "irreversible", reason: "drop" },
  };
  const manifest = (
    parent: Omit<MigrationParentTransitionV1, "transitionHash">
  ) =>
    encodeStateManifest({
      format: "1",
      estateHash: "e".repeat(64),
      name: "drop",
      snapshotHash: "5".repeat(64),
      sqlHash: blob.sqlHash,
      destinationChecks: [],
      parents: [{ ...parent, transitionHash: encodeTransitionHash(parent) }],
    });

  test("a transition without adopts keeps the ids it had before adoption existed", () => {
    expect(encodeTransitionHash(body)).toBe(
      "d56a04963d90212d68ab3501e206209b1774d8f19791f381e7dd45b32f980e23"
    );
    expect(manifest(body).stateId).toBe(
      "e279d164de32d723a9abd1ccbd31afb609aae99ecf7e804d4984c8e9ad8b8cfb"
    );
    expect(new TextDecoder().decode(manifest(body).bytes)).not.toContain(
      "adopts"
    );
  });

  test("adopts are part of the transition hash, survive the parser and show in review", () => {
    const adopting = { ...body, adopts: ["dependency", "fts_index"] };
    const encoded = manifest(adopting);
    expect(encodeTransitionHash(adopting)).not.toBe(encodeTransitionHash(body));
    const parsed = parseStateManifest(encoded.bytes, encoded.stateId);
    expect(parsed.parents[0]!.adopts).toEqual(["dependency", "fts_index"]);
    expect(renderMigrationReview(parsed.parents, [], blob.bytes)).toContain(
      "-- Adopts existing table dependency: no DDL"
    );

    const tampered = utf8Bytes(
      new TextDecoder()
        .decode(encoded.bytes)
        .replace('"fts_index"', '"fts_other"')
    );
    expect(() => parseStateManifest(tampered, encoded.stateId)).toThrow(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_CORRUPTION })
    );
  });

  test.each([
    [[], "must be a non-empty array"],
    ["dependency", "must be a non-empty array"],
    [[""], "must be a non-empty physical table name"],
    [[7], "must be a non-empty physical table name"],
    [["b", "a"], "must be sorted and free of repeats"],
    [["a", "a"], "must be sorted and free of repeats"],
  ])("the parser refuses adopts %j", (adopts, message) => {
    const encoded = manifest(body);
    const parsed = JSON.parse(new TextDecoder().decode(encoded.bytes));
    parsed.parents[0].adopts = adopts;
    expect(() =>
      parseStateManifest(utf8Bytes(JSON.stringify(parsed)), encoded.stateId)
    ).toThrow(message);
  });
});
