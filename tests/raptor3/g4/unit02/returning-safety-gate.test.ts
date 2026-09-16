/**
 * G4-02 author check (repair round 3) — what `returningSafeProjection` answers,
 * kind by kind.
 *
 * The phase-2 note described a per-field `PreparedProjectionField.returningSafe`
 * that never landed, and the function that did land widened the deleted
 * `namesRelation` kind-test by one kind (`distance`) that nothing in the
 * qualified provider set can witness (independent review, finding 5). The
 * repair keeps the RELOCATION — the projection owner answers, not a physical
 * owner — and restores the witnessed rule: a projection rides a mutation's
 * `RETURNING` exactly when every field is a column of the mutated row.
 *
 * These cells are the falsifier for that statement. They ask the gate directly,
 * over prepared projections of every kind the owner can produce, so the
 * `distance` arm is pinned by what the gate ANSWERS rather than by a fold no
 * provider here can perform.
 */
import assert from "node:assert/strict";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  Queries,
  returningSafeProjection,
} from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { describe, it } from "vitest";

const note = s
  .model({
    id: s.int().id(),
    body: s.string(),
    spotId: s.int(),
    spot: s
      .toOne(() => spot)
      .fields("spotId")
      .references("id"),
  })
  .map("g4u2g_notes");

const spot = s
  .model({
    id: s.int().id(),
    name: s.string(),
    at: s.point(),
    notes: s.toMany(() => note),
  })
  .map("g4u2g_spots");

const gateSchema = { spot, note };

function gate(select: Record<string, unknown>, postgis = false): boolean {
  const adapter = postgis
    ? new PostgresAdapter("public", true)
    : new SQLiteAdapter();
  const queries = new Queries(new EngineSchema(gateSchema), adapter);
  return returningSafeProjection(queries.prepareProjection(spot, { select }));
}

describe("G4-02 — a projection rides RETURNING when every field is the row's own column", () => {
  it("admits a scalar-only projection", () => {
    assert.equal(gate({ id: true, name: true }), true);
  });

  it("admits the default whole-row projection", () => {
    const queries = new Queries(
      new EngineSchema(gateSchema),
      new SQLiteAdapter()
    );
    assert.equal(
      returningSafeProjection(queries.prepareProjection(spot, {})),
      true
    );
  });

  it("refuses a relation carrier", () => {
    assert.equal(gate({ id: true, notes: true }), false);
  });

  it("refuses a _count slot", () => {
    assert.equal(
      gate({ id: true, _count: { select: { notes: true } } }),
      false
    );
  });

  it("refuses a _distance field, the one kind no qualified provider can witness", () => {
    // A `_distance` IS an expression over the mutated row's own columns, so a
    // wider gate would be defensible — but no provider in the qualified set
    // declares the distance tier, so nothing could fail if the arm were wrong.
    // The gate therefore stays where `namesRelation` had it, and this cell is
    // what goes red the day the arm is widened again.
    assert.equal(
      gate(
        {
          id: true,
          at: { _distance: { to: { longitude: 2.35, latitude: 48.85 } } },
        },
        true
      ),
      false
    );
  });
});
