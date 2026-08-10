import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import type { PolymorphicStorageColumn } from "@schema/relation";
import {
  buildTargetProjection,
  capturedTargetConstraint,
  capturedTargetFilters,
  capturedTargetValues,
  capturedTargetWhere,
  targetProjectionOutputs,
  targetProjectionRowKeySelect,
} from "@src/query-engine/write-engine/target-projection";
import { describe, expect, test } from "vitest";

/**
 * C1 — `TargetProjection` owns which target values a selected-record probe
 * publishes, and its `identityFields` is the target's ROW KEY: the complete
 * primary key in schema order. These are the unit facts every relation owner's
 * captured UPDATE/DELETE/guard selector is built on.
 *
 * A reference key that is not the row key belongs in `fields`, never in
 * `identityFields` — CONTEXT.md keeps "which fields address one record" and
 * "which fields a relation points at" as different questions, and this file
 * pins that they stay different here.
 */

const schema = (() => {
  const scalarPk = s
    .model({
      id: s.string().id(),
      tenantId: s.string(),
      code: s.string(),
      label: s.string(),
    })
    .map("tp_scalar_pk");
  const compoundPk = s
    .model({
      tenantId: s.string(),
      slot: s.string(),
      note: s.string(),
    })
    .id(["tenantId", "slot"])
    .map("tp_compound_pk");
  // Declaration order and KEY order disagree on purpose: every other compound
  // fixture in the estate declares its members in the same order it keys them,
  // which cannot tell the two hypotheses apart.
  const reorderedPk = s
    .model({
      tenantId: s.string(),
      slot: s.string(),
      note: s.string(),
    })
    .id(["slot", "tenantId"])
    .map("tp_reordered_pk");
  return { scalarPk, compoundPk, reorderedPk };
})();

hydrateSchemaNames(schema);

const scalarPk = schema.scalarPk as Model<any>;
const compoundPk = schema.compoundPk as Model<any>;
const reorderedPk = schema.reorderedPk as Model<any>;

const typeColumn: PolymorphicStorageColumn = {
  name: "ownerType",
  scalar: s.string(),
  nullable: true,
};
const idColumn: PolymorphicStorageColumn = {
  name: "ownerId",
  scalar: s.string(),
  nullable: true,
};

describe("buildTargetProjection", () => {
  test("one scalar primary key: the row key is the single member and leads fields", () => {
    const projection = buildTargetProjection(scalarPk);
    expect(projection).toEqual({
      identityFields: ["id"],
      fields: ["id"],
      columns: [],
    });
    expect(targetProjectionRowKeySelect(projection)).toEqual({ id: true });
  });

  test("two-member primary key: both members, in schema order", () => {
    const projection = buildTargetProjection(compoundPk, ["note"]);
    expect(projection.identityFields).toEqual(["tenantId", "slot"]);
    expect(projection.fields).toEqual(["tenantId", "slot", "note"]);
    expect(targetProjectionRowKeySelect(projection)).toEqual({
      tenantId: true,
      slot: true,
    });
  });

  test("required non-primary-key referenced fields join fields, never identityFields", () => {
    // The relation points at (tenantId, code); the row key is [id]. Both are
    // published, and only the row key addresses the record.
    const projection = buildTargetProjection(scalarPk, ["tenantId", "code"]);
    expect(projection.identityFields).toEqual(["id"]);
    expect(projection.fields).toEqual(["id", "tenantId", "code"]);
  });

  test("private polymorphic columns stay outside fields and trail the outputs", () => {
    const projection = buildTargetProjection(
      scalarPk,
      ["label"],
      [typeColumn, idColumn]
    );
    expect(projection.fields).toEqual(["id", "label"]);
    expect(projection.columns).toEqual([typeColumn, idColumn]);
    // Output ORDER is the contract: every field, then every column.
    expect(Object.keys(targetProjectionOutputs(projection))).toEqual([
      "id",
      "label",
      "ownerType",
      "ownerId",
    ]);
    expect(targetProjectionOutputs(projection, true).id).toEqual({
      kind: "firstRowField",
      field: "id",
      optional: true,
    });
  });

  test("schema order is the KEY's order, not the field declaration's", () => {
    // Both orders are byte-visible: they are the probe's SELECT list, the output
    // key list, and the conjunct sequence of every captured guard.
    const projection = buildTargetProjection(reorderedPk, ["note"]);
    expect(projection.identityFields).toEqual(["slot", "tenantId"]);
    expect(projection.fields).toEqual(["slot", "tenantId", "note"]);
    expect(Object.keys(targetProjectionRowKeySelect(projection))).toEqual([
      "slot",
      "tenantId",
    ]);
    expect(
      capturedTargetFilters(reorderedPk, projection, {
        tenantId: "t1",
        slot: "s1",
        note: "n",
      })
    ).toEqual([{ slot: { equals: "s1" } }, { tenantId: { equals: "t1" } }]);
  });

  test("a requested field that repeats the row key is published once", () => {
    const projection = buildTargetProjection(compoundPk, [
      "slot",
      "note",
      "note",
      "tenantId",
    ]);
    expect(projection.fields).toEqual(["tenantId", "slot", "note"]);
    expect(Object.keys(targetProjectionOutputs(projection))).toEqual([
      "tenantId",
      "slot",
      "note",
    ]);
  });
});

describe("captured row-key selectors", () => {
  test("a scalar row key stays a flat whereUnique and one filter conjunct", () => {
    const projection = buildTargetProjection(scalarPk, ["code"]);
    const captured = { id: "iCaptured", code: "c1" };
    expect(capturedTargetValues(scalarPk, projection, captured)).toEqual({
      id: "iCaptured",
    });
    expect(capturedTargetWhere(scalarPk, projection, captured)).toEqual({
      id: "iCaptured",
    });
    expect(capturedTargetFilters(scalarPk, projection, captured)).toEqual([
      { id: { equals: "iCaptured" } },
    ]);
  });

  test("a compound row key nests under its constraint and yields one conjunct per member", () => {
    const projection = buildTargetProjection(compoundPk, ["note"]);
    const captured = { tenantId: "t1", slot: "s1", note: "n" };
    expect(capturedTargetWhere(compoundPk, projection, captured)).toEqual({
      tenantId_slot: { tenantId: "t1", slot: "s1" },
    });
    expect(capturedTargetFilters(compoundPk, projection, captured)).toEqual([
      { tenantId: { equals: "t1" } },
      { slot: { equals: "s1" } },
    ]);
  });

  test("the captured constraint is exact over the row key alone", () => {
    const projection = buildTargetProjection(compoundPk, ["note"]);
    const constraint = capturedTargetConstraint(compoundPk, projection, {
      tenantId: "t1",
      slot: "s1",
      note: "n",
    });
    expect(constraint.certainty).toBe("exact");
    expect([...constraint.fields.keys()]).toEqual(["slot", "tenantId"]);
    expect(constraint.fields.get("tenantId")?.value).toEqual({
      kind: "string",
      value: "t1",
    });
  });

  test("the projection names the members read, and an unpublished one raises", () => {
    // `TargetProjection` is an exported interface, so `buildTargetProjection` is
    // not the only way one reaches these owners. What the projection DECLARES is
    // what gets read: if the declared list and the values read came from two
    // sources, a member present in one and absent from the other would arrive as
    // an absent value, and the where builder drops an absent conjunct without
    // complaint — a guard silently narrowed to fewer members than it names.
    const declared = {
      identityFields: ["id", "tenantId"],
      fields: ["id", "tenantId"],
      columns: [],
    } as const;
    expect(
      capturedTargetValues(scalarPk, declared, { id: "i1", tenantId: "t1" })
    ).toEqual({ id: "i1", tenantId: "t1" });
    expect(() =>
      capturedTargetValues(scalarPk, declared, { id: "i1" })
    ).toThrow(
      "Cannot refetch mutation result for model 'scalarPk' because primary key field 'tenantId' is missing."
    );
  });

  test("a missing captured row-key member raises the shared extractor's error", () => {
    const projection = buildTargetProjection(compoundPk, ["note"]);
    // The wording is INHERITED from `getPrimaryKeyValuesFromRecord`, the one
    // extractor for "the row key inside this record"; a reworded copy here
    // would be a second extractor in all but name.
    expect(() =>
      capturedTargetWhere(compoundPk, projection, { tenantId: "t1" })
    ).toThrow(
      "Cannot refetch mutation result for model 'compoundPk' because primary key field 'slot' is missing."
    );
  });
});
