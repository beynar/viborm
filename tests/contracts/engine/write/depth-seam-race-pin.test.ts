import type { WriteStep } from "@src/query-engine/write-engine/OperationFragment";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import {
  depthSeamSchema,
  makeSeamEngine,
} from "@tests/contracts/engine/write/depth-seam-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// N6-U1 STRUCTURAL: the nested create-arm `racePin`, and its deliberate absence.
//
// These witnesses inspect a COMPILED fragment and never execute one, so this file
// boots no database at all: a `PGliteDriver` with no client creates its PGlite
// lazily, on connect, and nothing here connects. That is why the arms live apart
// from the depth-seam injection harnesses, each of which needs a fresh instance.
//
// The driver therefore comes from the SHARED FIXTURE's factory rather than being
// constructed here. Both spellings build the same lazy driver, but the test manifest
// reads a driver construction in the file's own source as "this suite pays for a
// PGlite instance" and gives the file a process to itself (`buildsOwnInstance`,
// `scripts/credential-free-test-manifest.mjs`). That is a false positive for a file
// that never connects, and borrowing the factory is what makes the classification
// match the measurement. Anything added here that DOES execute an operation would
// boot an instance of its own and belongs in one of the harness files instead.
//
// The behavior suite proves the create arm RUNS when the filter excludes the
// located row. This proves that arm is not RETRYABLE, which no state assertion
// can see — a withheld pin and an attached one persist identical rows.
//
// A `racePin` claims "the probe proved unique key K was free, so a violation on K
// is someone else taking it between our read and our write — re-plan and adopt".
// A FILTERED probe proves something strictly weaker: no row matches `K AND
// filters`. A row on K may exist and be EXCLUDED by the filter, and then the
// INSERT's violation is a genuine conflict that re-planning reproduces forever —
// one pointless retry, and a real conflict mis-reported as a race. This is the
// root's rule (`UpsertOperation.createArmRacePin`, pinned in
// `extended-where-unique.test.ts`) reaching depth, and it lives inside
// `childRacePin` so that no call site can forget it.
//
// The PLAIN-selector test is the falsification: without it these assertions would
// pass just as well against an implementation that never pins a nested arm at all.
// ---------------------------------------------------------------------------

/** The write steps of a nested upsert whose child probe found NOTHING — the arm
 *  under test. The root locate still yields its row (the tree must compile); only
 *  the CHILD probe's emptiness selects the create arm. */
function nestedUpsertCreateArmWrites(
  where: Record<string, unknown>
): WriteStep[] {
  const engine = makeSeamEngine(createInMemoryPGliteDriver());
  const operation = new UpdateOperation(engine, depthSeamSchema.workspace, {
    where: { id: 2 },
    data: {
      projects: {
        upsert: {
          where,
          create: { id: 30, code: "P-FRESH", title: "fresh" },
          update: { title: "updated" },
        },
      },
    },
  });
  const planning = operation.planning();
  const known: Record<string, unknown> = {};
  for (const step of planning.steps) known[`${step.id}.rows`] = [];
  const [rootLocate] = planning.steps;
  if (rootLocate) known[`${rootLocate.id}.rows`] = [{ id: 2 }];
  return operation
    .compile(known)
    .steps.filter((step): step is WriteStep => step.kind === "write");
}

/** The same arm at the JUNCTION position. `RelationJunctionPart`'s upsert create arm
 *  is a second call site of `childInsert`, and it is the one no test stood in front of:
 *  the `connectOrCreate` witness in `m2m-mutation.test.ts` pins the ADOPT slot's insert,
 *  and the pair below pins a to-many Part — neither compiles this slot. The membership
 *  and global probes are both driven empty here, which is the create arm. */
function junctionUpsertCreateArmWrites(
  where: Record<string, unknown>
): WriteStep[] {
  const engine = makeSeamEngine(createInMemoryPGliteDriver());
  const operation = new UpdateOperation(engine, depthSeamSchema.album, {
    where: { id: 1 },
    data: {
      photos: {
        upsert: {
          where,
          create: { id: 30, slug: "fresh", caption: "f" },
          update: { caption: "updated" },
        },
      },
    },
  });
  const planning = operation.planning();
  const known: Record<string, unknown> = {};
  for (const step of planning.steps) known[`${step.id}.rows`] = [];
  const [rootLocate] = planning.steps;
  if (rootLocate) known[`${rootLocate.id}.rows`] = [{ id: 1 }];
  return operation
    .compile(known)
    .steps.filter((step): step is WriteStep => step.kind === "write");
}

describe("N6-U1 nested create-arm racePin", () => {
  test("a PLAIN nested selector pins the create arm as raceable", () => {
    const pinned = nestedUpsertCreateArmWrites({ code: "P-FRESH" }).filter(
      (step) => step.racePin
    );
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.racePin?.fields).toEqual(["code"]);
  });

  test("an EXTENDED nested selector withholds the create-arm racePin", () => {
    const writes = nestedUpsertCreateArmWrites({
      code: "P-FRESH",
      title: "not-the-title",
    });
    expect(writes.every((step) => step.racePin === undefined)).toBe(true);
  });

  test("the withheld pin is about the FILTER, not the discriminator's shape", () => {
    // Same discriminator, the filter smuggled through a boolean combinator.
    const writes = nestedUpsertCreateArmWrites({
      code: "P-FRESH",
      AND: [{ title: "not-the-title" }],
    });
    expect(writes.every((step) => step.racePin === undefined)).toBe(true);
  });

  test("the JUNCTION upsert's create arm obeys the same rule at its own site", () => {
    // The behavior file proves this arm RUNS on an excluding filter; this proves the
    // insert it emits carries the pin under a plain selector and none under an
    // extended one. Both halves at once, because at this site they are one fact: the
    // slot hands its selector to `childInsert`, and `childRacePin` decides. Only the
    // junction row follows the child INSERT, and it pins nothing.
    const plain = junctionUpsertCreateArmWrites({ slug: "fresh" }).filter(
      (step) => step.racePin
    );
    expect(plain).toHaveLength(1);
    expect(plain[0]?.racePin?.fields).toEqual(["slug"]);
    const extended = junctionUpsertCreateArmWrites({
      slug: "fresh",
      caption: "not-the-caption",
    });
    expect(extended.every((step) => step.racePin === undefined)).toBe(true);
  });
});
