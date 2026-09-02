import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  assertCreateRefetchIdentity,
  assertPortablePrimaryKeyUpdateInput,
  databaseAssignedRowKeyFields,
  getCreatedRowWhere,
  getPrimaryKeyValuesFromRecord,
  getProvidedPrimaryKeyWhere,
  getUpdatedPrimaryKeyValue,
  getUpdatedPrimaryKeyValues,
  getUpdatedPrimaryKeyWhere,
  planNestedCreateIdentity,
} from "@query-engine/operations/mutation-identity";
import {
  classifyTargetConstraintOverlap,
  exactTargetConstraintKey,
  getCreatedWhereUniqueTarget,
  getFilterTargetConstraint,
  getForeignKeyTargetFields,
  normalizeTargetConstraint,
  normalizeWhereUniqueTargetConstraint,
  predicateFieldSetsIntersect,
  unionPredicateFields,
} from "@query-engine/TargetConstraint";
import { QueryEngineError } from "@query-engine/types";
import { s } from "@schema";
import { isSql, sql } from "@sql";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const ID_NOT_KNOWN_BEFORE_EXECUTION_PATTERN =
  /primary key field 'id'.*known before execution/;
const SEQUENCE_NOT_KNOWN_BEFORE_EXECUTION_PATTERN =
  /primary key field 'sequence'.*known before execution/;
const SEQUENCE_MISSING_PATTERN = /primary key field 'sequence' is missing/;
const TENANT_ID_MISSING_PATTERN = /primary key field 'tenantId' is missing/;
const UNSUPPORTED_OPERATION_PATTERN = /unsupported operation/;
const DIVIDE_PRIMARY_KEY_BY_ZERO_PATTERN = /divide a primary key by zero/;
const UNSAFE_INTEGER_PATTERN = /unsafe integer/;
const NON_FINITE_NUMBER_PATTERN = /non-finite number/;
const SINGLE_UPDATE_OPERATION_PATTERN = /accepts exactly one update operation/;
const NOT_PORTABLE_NUMBER_PK_PATTERN = /not portable for number primary key/;
const NOT_PORTABLE_DECIMAL_PK_PATTERN = /not portable for decimal primary key/;
const DIVIDE_ID_FIELD_BY_ZERO_PATTERN = /divide primary key field 'id' by zero/;
const NON_FINITE_INCREMENT_PATTERN = /non-finite 'increment' operand/;

const target = s
  .model({
    id: s.int().id().map("target_id"),
    tenantId: s.int().map("tenant_id"),
    sequence: s.int().map("sequence_no"),
    externalId: s.bigInt().unique(),
    enabled: s.boolean(),
    code: s.string().unique(),
    occurredAt: s.dateTime().unique(),
    digest: s.blob(),
    amount: s.decimal({ precision: 16, scale: 2 }).unique(),
    generated: s.int().increment().unique(),
    defaulted: s
      .string()
      .default(() => "generated")
      .unique(),
  })
  .unique(["tenantId", "sequence"], { name: "tenant_sequence" });

const generatedIdentity = s.model({
  id: s.int().id().increment(),
  label: s.string(),
});
const manualIdentity = s.model({
  id: s.string().id(),
  label: s.string(),
});
const compoundIdentity = s
  .model({
    tenantId: s.int(),
    sequence: s.bigInt(),
    label: s.string(),
  })
  .id(["tenantId", "sequence"], { name: "tenant_sequence" });
const numericIdentities = {
  int: s.model({ id: s.int().id(), label: s.string() }),
  bigint: s.model({ id: s.bigInt().id(), label: s.string() }),
  number: s.model({ id: s.number().id(), label: s.string() }),
  decimal: s.model({
    id: s.decimal({ precision: 12, scale: 2 }).id(),
    label: s.string(),
  }),
};
const overlappingSelector = s
  .model({
    id: s.int().id(),
    tenantId: s.int(),
  })
  .unique(["id", "tenantId"], { name: "id_tenant" });
const indexedTarget = s
  .model({
    id: s.int().id(),
    region: s.string(),
    handle: s.string(),
    note: s.string(),
  })
  .index(["region", "handle"], { unique: true })
  .index(["note"]);
const otherTarget = s.model({ id: s.int().id() });
const byteTarget = s
  .model({
    id: s.int().id(),
    digest: s.blob(),
  })
  .unique(["digest"], { name: "digest_key" });

prepareSchema({
  target,
  generatedIdentity,
  manualIdentity,
  compoundIdentity,
  ...numericIdentities,
  overlappingSelector,
  indexedTarget,
  otherTarget,
  byteTarget,
});

const adapter = new PostgresAdapter();

function whereConstraint(where: Record<string, unknown>) {
  return normalizeWhereUniqueTargetConstraint(target, where);
}

describe("target constraint normalization", () => {
  test("normalizes scalar and compound selectors by model field name and sorted order", () => {
    const scalar = whereConstraint({ id: 7 });
    const compound = whereConstraint({
      tenant_sequence: { sequence: 2, tenantId: 1 },
    });

    expect([...scalar.fields.keys()]).toEqual(["id"]);
    expect([...compound.fields.keys()]).toEqual(["sequence", "tenantId"]);
    expect([...compound.fields.keys()]).not.toContain("sequence_no");
    expect(compound.certainty).toBe("exact");
  });

  test("proves equality only from exact type-tagged values", () => {
    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ tenant_sequence: { tenantId: 1, sequence: 2 } }),
        whereConstraint({
          tenant_sequence: { sequence: 2, tenantId: 1 },
        })
      )
    ).toBe("equal");
    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ externalId: 9n }),
        whereConstraint({ externalId: 9n })
      )
    ).toBe("equal");
    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ code: "same" }),
        whereConstraint({ code: "same" })
      )
    ).toBe("equal");
    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ amount: 1.25 }),
        whereConstraint({ amount: 1.25 })
      )
    ).toBe("equal");
    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ id: 1 }),
        whereConstraint({ externalId: 1n })
      )
    ).toBe("unknown");
  });

  test("proves disjointness only for unequal int, bigint, and boolean fields", () => {
    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ id: 1 }),
        whereConstraint({ id: 2 })
      )
    ).toBe("disjoint");
    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ externalId: 1n }),
        whereConstraint({ externalId: 2n })
      )
    ).toBe("disjoint");
    expect(
      classifyTargetConstraintOverlap(
        normalizeTargetConstraint(target, ["enabled"], { enabled: true }),
        normalizeTargetConstraint(target, ["enabled"], { enabled: false })
      )
    ).toBe("disjoint");
  });

  test("keeps collation and normalization-sensitive unequal values unknown", () => {
    const firstDate = normalizeTargetConstraint(target, ["occurredAt"], {
      occurredAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    const secondDate = normalizeTargetConstraint(target, ["occurredAt"], {
      occurredAt: new Date("2025-01-01T00:00:00.001Z"),
    });
    const firstBytes = normalizeTargetConstraint(target, ["digest"], {
      digest: new Uint8Array([1, 2]),
    });
    const secondBytes = normalizeTargetConstraint(target, ["digest"], {
      digest: new Uint8Array([1, 3]),
    });

    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ code: "Résumé" }),
        whereConstraint({ code: "resume" })
      )
    ).toBe("unknown");
    expect(classifyTargetConstraintOverlap(firstDate, secondDate)).toBe(
      "unknown"
    );
    expect(classifyTargetConstraintOverlap(firstBytes, secondBytes)).toBe(
      "unknown"
    );
    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ amount: 1.1 }),
        whereConstraint({ amount: 1.2 })
      )
    ).toBe("unknown");
  });

  test("recognizes identical date and byte values exactly", () => {
    const date = new Date("2025-01-01T00:00:00.000Z");
    const leftDate = normalizeTargetConstraint(target, ["occurredAt"], {
      occurredAt: date,
    });
    const rightDate = normalizeTargetConstraint(target, ["occurredAt"], {
      occurredAt: new Date(date),
    });
    const leftBytes = normalizeTargetConstraint(target, ["digest"], {
      digest: new Uint8Array([0, 128, 255]),
    });
    const rightBytes = normalizeTargetConstraint(target, ["digest"], {
      digest: new Uint8Array([0, 128, 255]),
    });

    expect(classifyTargetConstraintOverlap(leftDate, rightDate)).toBe("equal");
    expect(classifyTargetConstraintOverlap(leftBytes, rightBytes)).toBe(
      "equal"
    );
  });

  test("marks missing generated/default fields and non-literals unknown", () => {
    const generated = normalizeTargetConstraint(target, ["generated"], {});
    const defaulted = normalizeTargetConstraint(target, ["defaulted"], {});
    const envelope = normalizeTargetConstraint(target, ["id"], {
      id: { increment: 1 },
    });
    const fragment = normalizeTargetConstraint(target, ["id"], {
      id: sql`${1}`,
    });
    const filter = normalizeTargetConstraint(target, ["code"], {
      code: { equals: "x", mode: "insensitive" },
    });

    expect(generated.certainty).toBe("unknown");
    expect(defaulted.certainty).toBe("unknown");
    expect(envelope.certainty).toBe("unknown");
    expect(fragment.certainty).toBe("unknown");
    expect(filter.certainty).toBe("unknown");
  });

  test("marks conflicting overlapping discriminators unknown", () => {
    const constraint = normalizeWhereUniqueTargetConstraint(
      overlappingSelector,
      {
        id: 1,
        id_tenant: { id: 2, tenantId: 7 },
      }
    );

    expect(constraint.certainty).toBe("unknown");
    expect(constraint.fields.get("id")?.value.kind).toBe("unknown");
    expect(constraint.fields.get("tenantId")?.value).toEqual({
      kind: "number",
      value: 7,
    });
  });

  test("keys every exact value kind and leaves uncertain constraints unkeyed", () => {
    const exact = normalizeTargetConstraint(
      target,
      [
        "id",
        "externalId",
        "enabled",
        "code",
        "occurredAt",
        "digest",
        "tenantId",
      ],
      {
        id: null,
        externalId: 9n,
        enabled: true,
        code: "target",
        occurredAt: new Date("2026-08-30T12:00:00.000Z"),
        digest: new Uint8Array([0, 128, 255]),
        tenantId: 3,
      }
    );
    const key = exactTargetConstraintKey(exact);

    expect(key).toBeDefined();
    expect(key).toContain('"null"');
    expect(key).toContain('"bigint","9"');
    expect(key).toContain('"bytes",[0,128,255]');
    expect(
      exactTargetConstraintKey(
        normalizeTargetConstraint(target, ["id"], { id: Number.NaN })
      )
    ).toBeUndefined();
  });

  test("keeps different models incomparable", () => {
    expect(
      classifyTargetConstraintOverlap(
        whereConstraint({ id: 1 }),
        normalizeWhereUniqueTargetConstraint(otherTarget, { id: 1 })
      )
    ).toBe("unknown");
  });

  test("proves a created selector only from the exact create payload", () => {
    const created = getCreatedWhereUniqueTarget(target, { id: 7 }, { id: 7 });

    expect(created?.certainty).toBe("exact");
    expect(
      getCreatedWhereUniqueTarget(target, { id: 7 }, { id: 8 })
    ).toBeUndefined();
    expect(
      getCreatedWhereUniqueTarget(
        target,
        { id: 7, enabled: true },
        { id: 7, enabled: true }
      )
    ).toBeUndefined();
  });

  test("collects referenceable unique-index fields without non-unique indexes", () => {
    expect(getForeignKeyTargetFields(indexedTarget).sort()).toEqual([
      "handle",
      "id",
      "region",
    ]);
  });

  test("keeps unknown predicate field sets absorbing", () => {
    const union = unionPredicateFields(new Set(["id"]), new Set(["enabled"]));

    expect(union === "unknown" ? union : [...union].sort()).toEqual([
      "enabled",
      "id",
    ]);
    expect(unionPredicateFields("unknown", new Set(["id"]))).toBe("unknown");
    expect(predicateFieldSetsIntersect(new Set(), "unknown")).toBe(false);
    expect(predicateFieldSetsIntersect(new Set(["id"]), "unknown")).toBe(true);
  });

  test("extracts exact Date and byte filter values and refuses non-record filters", () => {
    const date = new Date("2026-08-30T12:00:00.000Z");
    const digest = new Uint8Array([1, 2, 3]);

    expect(
      getFilterTargetConstraint(target, { occurredAt: date }).fields.get(
        "occurredAt"
      )?.value
    ).toEqual({ kind: "date", value: date.getTime() });
    expect(
      getFilterTargetConstraint(byteTarget, { digest }).fields.get("digest")
        ?.value
    ).toEqual({ kind: "bytes", value: [1, 2, 3] });
    expect(getFilterTargetConstraint(target, null).certainty).toBe("unknown");
  });
});

describe("mutation row identity", () => {
  test("separates caller-owned and database-assigned create identity", () => {
    expect(databaseAssignedRowKeyFields(generatedIdentity, {})).toEqual(["id"]);
    expect(databaseAssignedRowKeyFields(generatedIdentity, { id: 7 })).toEqual(
      []
    );
    expect(
      planNestedCreateIdentity(generatedIdentity, { label: "generated" })
    ).toEqual({ identity: {}, databaseAssigned: ["id"] });
    expect(
      planNestedCreateIdentity(manualIdentity, {
        id: "manual-1",
        label: "manual",
      })
    ).toEqual({
      identity: { id: "manual-1" },
      databaseAssigned: [],
    });
    expect(() =>
      planNestedCreateIdentity(manualIdentity, { label: "missing" })
    ).toThrow(ID_NOT_KNOWN_BEFORE_EXECUTION_PATTERN);
    expect(() =>
      planNestedCreateIdentity(compoundIdentity, {
        tenantId: 1,
        label: "partial",
      })
    ).toThrow(SEQUENCE_NOT_KNOWN_BEFORE_EXECUTION_PATTERN);
  });

  test("builds only refetch identities that are atomically knowable", () => {
    const manualScope = scopeFor(adapter, manualIdentity);
    const generatedScope = scopeFor(adapter, generatedIdentity);
    const compoundScope = scopeFor(adapter, compoundIdentity);

    expect(() =>
      assertCreateRefetchIdentity(manualScope, { id: "manual-1" }, "manual")
    ).not.toThrow();
    expect(() =>
      assertCreateRefetchIdentity(generatedScope, {}, "generated")
    ).not.toThrow();
    expect(() =>
      assertCreateRefetchIdentity(compoundScope, { tenantId: 1 }, "compound")
    ).toThrow(QueryEngineError);

    expect(
      getCreatedRowWhere(manualScope, { id: "manual-1" }, "manual")
    ).toEqual({ id: "manual-1" });
    const generatedWhere = getCreatedRowWhere(generatedScope, {}, "generated");
    expect(isSql(generatedWhere.id)).toBe(true);
  });

  test("requires every captured row-key field and preserves compound order", () => {
    expect(
      getPrimaryKeyValuesFromRecord(
        compoundIdentity,
        { tenantId: 1, sequence: 2n, label: "before" },
        "compound"
      )
    ).toEqual({ tenantId: 1, sequence: 2n });
    expect(() =>
      getPrimaryKeyValuesFromRecord(
        compoundIdentity,
        { tenantId: 1 },
        "compound"
      )
    ).toThrow(SEQUENCE_MISSING_PATTERN);
    expect(() =>
      getPrimaryKeyValuesFromRecord(
        compoundIdentity,
        { tenantId: null, sequence: 2n },
        "compound"
      )
    ).toThrow(TENANT_ID_MISSING_PATTERN);
    expect(
      getPrimaryKeyValuesFromRecord(
        compoundIdentity,
        { tenantId: 1 },
        "compound",
        ["tenantId"]
      )
    ).toEqual({ tenantId: 1 });
  });

  test("computes portable int and bigint primary-key transitions", () => {
    const intScope = scopeFor(adapter, numericIdentities.int);
    const bigintScope = scopeFor(adapter, numericIdentities.bigint);

    expect(
      getUpdatedPrimaryKeyValues(
        intScope,
        { id: 9, label: "before" },
        { label: "after" },
        "int"
      )
    ).toEqual({ id: 9 });
    expect(
      getUpdatedPrimaryKeyValues(
        intScope,
        { id: 9 },
        { id: { increment: 3 } },
        "int"
      )
    ).toEqual({ id: 12 });
    expect(
      getUpdatedPrimaryKeyWhere(
        intScope,
        { id: 9 },
        { id: { divide: 2 } },
        "int"
      )
    ).toEqual({ id: 4 });
    expect(
      getUpdatedPrimaryKeyValue(
        numericIdentities.bigint,
        "id",
        "12",
        { decrement: 2 },
        "bigint"
      )
    ).toBe(10n);
    expect(
      getUpdatedPrimaryKeyValue(
        numericIdentities.bigint,
        "id",
        3n,
        { multiply: "4" },
        "bigint"
      )
    ).toBe(12n);
    expect(
      getUpdatedPrimaryKeyValues(
        bigintScope,
        { id: 9n },
        { id: { divide: 2n } },
        "bigint"
      )
    ).toEqual({ id: 4n });
  });

  test("refuses ambiguous, lossy, and invalid primary-key transitions", () => {
    expect(() =>
      getUpdatedPrimaryKeyValue(
        numericIdentities.int,
        "id",
        1,
        { increment: 1, decrement: 1 },
        "int"
      )
    ).toThrow(UNSUPPORTED_OPERATION_PATTERN);
    expect(() =>
      getUpdatedPrimaryKeyValue(
        numericIdentities.int,
        "id",
        1,
        { divide: 0 },
        "int"
      )
    ).toThrow(DIVIDE_PRIMARY_KEY_BY_ZERO_PATTERN);
    expect(() =>
      getUpdatedPrimaryKeyValue(
        numericIdentities.bigint,
        "id",
        1n,
        { divide: 0n },
        "bigint"
      )
    ).toThrow(DIVIDE_PRIMARY_KEY_BY_ZERO_PATTERN);
    expect(() =>
      getUpdatedPrimaryKeyValue(
        numericIdentities.int,
        "id",
        Number.MAX_SAFE_INTEGER,
        { increment: 1 },
        "int"
      )
    ).toThrow(UNSAFE_INTEGER_PATTERN);
    expect(() =>
      getUpdatedPrimaryKeyValue(
        numericIdentities.number,
        "id",
        Number.MAX_VALUE,
        { multiply: 2 },
        "number"
      )
    ).toThrow(NON_FINITE_NUMBER_PATTERN);
    expect(() =>
      getUpdatedPrimaryKeyValue(
        numericIdentities.int,
        "id",
        "not-a-number",
        { increment: 1 },
        "int"
      )
    ).toThrow(UNSUPPORTED_OPERATION_PATTERN);
    expect(() =>
      getUpdatedPrimaryKeyValue(
        numericIdentities.bigint,
        "id",
        Number.MAX_SAFE_INTEGER + 1,
        { increment: 1 },
        "bigint"
      )
    ).toThrow(UNSUPPORTED_OPERATION_PATTERN);
  });

  test("rejects non-portable update envelopes before planning", () => {
    expect(() =>
      assertPortablePrimaryKeyUpdateInput(numericIdentities.int, "update", {
        data: { id: { increment: 1, decrement: 1 } },
      })
    ).toThrow(SINGLE_UPDATE_OPERATION_PATTERN);
    expect(() =>
      assertPortablePrimaryKeyUpdateInput(
        numericIdentities.number,
        "updateMany",
        { data: { id: { increment: 1 } } }
      )
    ).toThrow(NOT_PORTABLE_NUMBER_PK_PATTERN);
    expect(() =>
      assertPortablePrimaryKeyUpdateInput(numericIdentities.decimal, "upsert", {
        update: { id: { multiply: 2 } },
      })
    ).toThrow(NOT_PORTABLE_DECIMAL_PK_PATTERN);
    expect(() =>
      assertPortablePrimaryKeyUpdateInput(
        numericIdentities.bigint,
        "updateManyAndReturn",
        { data: { id: { divide: 0n } } }
      )
    ).toThrow(DIVIDE_ID_FIELD_BY_ZERO_PATTERN);
    expect(() =>
      assertPortablePrimaryKeyUpdateInput(numericIdentities.int, "update", {
        data: { id: { increment: Number.POSITIVE_INFINITY } },
      })
    ).toThrow(NON_FINITE_INCREMENT_PATTERN);
    expect(() =>
      assertPortablePrimaryKeyUpdateInput(numericIdentities.int, "update", {
        data: { id: { set: 3 } },
      })
    ).not.toThrow();
    expect(() =>
      assertPortablePrimaryKeyUpdateInput(numericIdentities.int, "delete", {})
    ).not.toThrow();
    expect(() =>
      assertPortablePrimaryKeyUpdateInput(
        numericIdentities.int,
        "update",
        "not an args object"
      )
    ).not.toThrow();
  });

  test("accepts only complete literal caller-provided identities", () => {
    expect(
      getProvidedPrimaryKeyWhere(compoundIdentity, {
        tenantId: 1,
        sequence: 2n,
      })
    ).toEqual({ tenant_sequence: { tenantId: 1, sequence: 2n } });
    expect(getProvidedPrimaryKeyWhere(manualIdentity, {})).toBeUndefined();
    expect(
      getProvidedPrimaryKeyWhere(manualIdentity, { id: null })
    ).toBeUndefined();
    expect(
      getProvidedPrimaryKeyWhere(manualIdentity, { id: sql`${"dynamic"}` })
    ).toBeUndefined();
    expect(
      getProvidedPrimaryKeyWhere(generatedIdentity, { id: undefined })
    ).toBeUndefined();
  });
});
