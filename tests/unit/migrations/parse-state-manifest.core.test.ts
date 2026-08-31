/**
 * Hostile admission of a Migration V1 state manifest.
 *
 * `parseStateManifest` is the ONE door every stored transition, operation,
 * step and boolean check comes through, so the refusals below are the parser's
 * public contract rather than internal branches: each one names the exact field
 * it rejects and the error code a caller can dispatch on.
 */

import { VibORMErrorCode } from "@src/errors";
import { canonicalizeJson } from "@src/migrations/canonical-json";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import {
  compareFromState,
  encodeDispatchIdentity,
  encodeStateManifest,
  encodeTransitionHash,
  parseMigrationTarget,
  parseStateManifest,
  sortParents,
} from "@src/migrations/v1-parse";
import type { MigrationParentTransitionV1 } from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";

const ZERO = "0".repeat(64);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const blob = composeSqlBlob(["SELECT 1"]);
const execute = {
  dispatchId: encodeDispatchIdentity(blob.sqlHash, 0, blob.bytes.length, []),
  sqlHash: blob.sqlHash,
  offset: 0,
  length: blob.bytes.length,
  parameters: [],
};

function check(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    equals: true,
    id: "check",
    kind: "driver",
    query: execute,
    ...overrides,
  };
}

function operation(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "op",
    label: "Operation",
    origin: "generated",
    risk: "safe",
    steps: [{ execute, retry: "opaque" }],
    ...overrides,
  };
}

function parent(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    fromState: null,
    operations: [],
    originChecks: [],
    requestedForwardBoundary: null,
    rollback: { kind: "irreversible", reason: "root" },
    transitionHash: ZERO,
    ...overrides,
  };
}

/**
 * Canonical bytes for a manifest carrying `parents`, with every manifest-level
 * field already well formed.
 *
 * The hashes are placeholders on purpose: every refusal exercised through this
 * helper fires while the parents are being admitted, which is strictly before
 * the manifest is re-canonicalized and before either identity is recomputed.
 */
function manifestBytes(
  parents: unknown,
  overrides: Record<string, unknown> = {}
): Uint8Array {
  return canonicalizeJson({
    destinationChecks: [],
    estateHash: HASH_A,
    format: "1",
    name: "state",
    parents,
    snapshotHash: HASH_A,
    sqlHash: blob.sqlHash,
    stateId: ZERO,
    ...overrides,
  });
}

function admit(parents: unknown, overrides: Record<string, unknown> = {}) {
  return () => parseStateManifest(manifestBytes(parents, overrides), ZERO);
}

function sealedParent(
  transition: Omit<MigrationParentTransitionV1, "transitionHash">
): MigrationParentTransitionV1 {
  return { ...transition, transitionHash: encodeTransitionHash(transition) };
}

const rootTransition: Omit<MigrationParentTransitionV1, "transitionHash"> = {
  fromState: null,
  operations: [],
  originChecks: [],
  requestedForwardBoundary: null,
  rollback: { kind: "irreversible", reason: "root" },
};

function manifestFrom(
  parents: readonly MigrationParentTransitionV1[],
  name = "state"
) {
  return encodeStateManifest({
    destinationChecks: [],
    estateHash: HASH_A,
    format: "1",
    name,
    parents,
    snapshotHash: HASH_A,
    sqlHash: blob.sqlHash,
  });
}

interface ParentRefusal {
  readonly name: string;
  readonly transition: Record<string, unknown>;
  readonly message: string;
}

const parentRefusals: readonly ParentRefusal[] = [
  {
    name: "a check kind outside the closed set",
    transition: parent({ originChecks: [check({ kind: "sidecar" })] }),
    message: "kind must be driver or trusted-read",
  },
  {
    name: "an unnamed check",
    transition: parent({ originChecks: [check({ id: "" })] }),
    message: "originChecks[0].id must be a non-empty string",
  },
  {
    name: "a non-boolean expected check answer",
    transition: parent({ originChecks: [check({ equals: "true" })] }),
    message: "equals must be boolean",
  },
  {
    name: "a step whose retry class is neither proven nor opaque",
    transition: parent({
      operations: [operation({ steps: [{ execute, retry: "eventually" }] })],
    }),
    message: "steps[0].retry must be proven or opaque",
  },
  {
    name: "a dispatch whose byte offset is not a safe integer",
    transition: parent({
      operations: [
        operation({
          steps: [{ execute: { ...execute, offset: 0.5 }, retry: "opaque" }],
        }),
      ],
    }),
    message: "steps[0].execute.offset must be a safe integer",
  },
  {
    name: "an unidentified operation",
    transition: parent({ operations: [operation({ id: "" })] }),
    message: "operations[0].id is required",
  },
  {
    name: "an unlabelled operation",
    transition: parent({ operations: [operation({ label: "" })] }),
    message: "operations[0].label is required",
  },
  {
    name: "an operation origin outside the closed set",
    transition: parent({ operations: [operation({ origin: "imported" })] }),
    message: "origin must be generated or manual",
  },
  {
    name: "a risk class V1 does not define",
    transition: parent({ operations: [operation({ risk: "mild" })] }),
    message: "risk is not a V1 risk class",
  },
  {
    name: "an operation with no steps",
    transition: parent({ operations: [operation({ steps: [] })] }),
    message: "steps must be a non-empty array",
  },
  {
    name: "an untagged rollback",
    transition: parent({ rollback: "none" }),
    message: "state.parents[0].rollback must be a tagged rollback",
  },
  {
    name: "a rollback kind V1 does not define",
    transition: parent({ rollback: { kind: "compensating" } }),
    message: "rollback.kind is not a V1 rollback",
  },
  {
    name: "schema rollback operations that are not an array",
    transition: parent({ rollback: { kind: "schema", operations: "none" } }),
    message: "state.parents[0].rollback.operations must be an array",
  },
  {
    name: "a manual rollback boundary outside the closed set",
    transition: parent({
      rollback: {
        kind: "manual",
        operations: [],
        requestedBoundary: "eventually",
      },
    }),
    message: "requestedBoundary must be transactional or stepwise",
  },
  {
    name: "manual rollback operations that are not an array",
    transition: parent({
      rollback: {
        kind: "manual",
        operations: "none",
        requestedBoundary: "stepwise",
      },
    }),
    message: "state.parents[0].rollback.operations must be an array",
  },
  {
    name: "a forward boundary outside the closed set",
    transition: parent({ requestedForwardBoundary: "eventually" }),
    message: "requestedForwardBoundary is invalid",
  },
  {
    name: "origin checks that are not an array",
    transition: parent({ originChecks: "none" }),
    message: "state.parents[0].originChecks must be an array",
  },
  {
    name: "operations that are not an array",
    transition: parent({ operations: "none" }),
    message: "state.parents[0].operations must be an array",
  },
];

interface ManifestRefusal {
  readonly name: string;
  readonly overrides: Record<string, unknown>;
  readonly message: string;
}

const manifestRefusals: readonly ManifestRefusal[] = [
  {
    name: "destination checks that are not an array",
    overrides: { destinationChecks: "none" },
    message: "destinationChecks must be an array",
  },
  {
    name: "an unnamed state",
    overrides: { name: "" },
    message: "name must be a non-empty string",
  },
];

describe("state manifest parent admission", () => {
  test.each(parentRefusals)("refuses $name", ({ transition, message }) => {
    expect(admit([transition])).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
        message: expect.stringContaining(message),
      })
    );
  });

  test("refuses a parent transition that is not an object", () => {
    // The exact-key admission runs before any field is read, so a scalar in
    // the parents array is refused as a shape rather than as a missing key.
    expect(admit(["root"])).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
        message: expect.stringContaining("state.parents[0] must be an object"),
      })
    );
  });

  test("refuses a well-formed parent whose transition hash authenticates nothing", () => {
    expect(admit([parent()])).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_CORRUPTION,
        message: expect.stringContaining(
          "transitionHash does not match its transition"
        ),
      })
    );
  });
});

describe("state manifest field admission", () => {
  test.each(manifestRefusals)("refuses $name", ({ overrides, message }) => {
    expect(admit([sealedParent(rootTransition)], overrides)).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
        message: expect.stringContaining(message),
      })
    );
  });

  test("refuses a manifest whose stateId is not the identity of its own bytes", () => {
    const encoded = manifestFrom([sealedParent(rootTransition)]);
    const rewritten = JSON.parse(
      new TextDecoder().decode(encoded.bytes)
    ) as Record<string, unknown>;
    rewritten.stateId = HASH_B;

    expect(() =>
      parseStateManifest(canonicalizeJson(rewritten), HASH_B)
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_CORRUPTION,
        message: expect.stringContaining(
          "stateId does not match the canonical manifest or filename"
        ),
      })
    );
  });
});

describe("state manifest parent ordering", () => {
  test("encodes a merge with the root parent first and reads it back", () => {
    const merge = sealedParent({ ...rootTransition, fromState: HASH_B });
    const root = sealedParent(rootTransition);
    const encoded = manifestFrom([merge, root], "merge");

    const parsed = parseStateManifest(encoded.bytes, encoded.stateId);
    expect(parsed.parents.map((entry) => entry.fromState)).toEqual([
      null,
      HASH_B,
    ]);
    expect(parsed.stateId).toBe(encoded.stateId);
  });

  test("refuses parents that are not strictly ascending by fromState", () => {
    const first = sealedParent({ ...rootTransition, fromState: HASH_B });
    const second = sealedParent({ ...rootTransition, fromState: HASH_A });

    expect(admit([first, second])).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
        message: expect.stringContaining(
          "parents must be sorted by fromState with null first"
        ),
      })
    );
  });

  test("refuses two transitions that arrive from the same parent state", () => {
    // Strict ascent is what rejects the repeat: equal fromState values are not
    // ascending, so the ordering refusal is the one a duplicate meets.
    const twice = sealedParent({ ...rootTransition, fromState: HASH_A });

    expect(admit([twice, twice])).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
        message: expect.stringContaining(
          "parents must be sorted by fromState with null first"
        ),
      })
    );
  });

  test("orders fromState with the root first and hashes lexicographically", () => {
    expect(compareFromState(null, null)).toBe(0);
    expect(compareFromState(HASH_A, HASH_A)).toBe(0);
    expect(compareFromState(null, HASH_A)).toBe(-1);
    expect(compareFromState(HASH_A, null)).toBe(1);
    expect(compareFromState(HASH_A, HASH_B)).toBe(-1);
    expect(compareFromState(HASH_B, HASH_A)).toBe(1);

    const merge = sealedParent({ ...rootTransition, fromState: HASH_B });
    const root = sealedParent(rootTransition);
    expect(sortParents([merge, root]).map((entry) => entry.fromState)).toEqual([
      null,
      HASH_B,
    ]);
  });
});

describe("coverage low value", () => {
  test("a migration target must be an object before its dialect is read", () => {
    expect(() => parseMigrationTarget("sqlite", "estate.json.target")).toThrow(
      "estate.json.target must be an object"
    );
  });
});
