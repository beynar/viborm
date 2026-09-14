import assert from "node:assert/strict";
import { NestedWriteError, VibORMErrorCode } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { describe, it } from "vitest";
import type { CandidateEngineFactory } from "../harness/protocol";
import {
  liveProvider,
  runLiveWorld,
  type LiveFixture,
} from "../transitions/live-world";

const shelfTable = "g29_native_member_shelves";
const binTable = "g29_native_member_bins";
const ticketTable = "g29_native_member_tickets";
const textType = liveProvider === "pg" ? "TEXT" : "VARCHAR(191)";

function memberDependencySchema(nextTicketId: () => string) {
  const shelf = s
    .model({
      id: s.string().id(),
      label: s.string(),
      bins: s.toMany(() => bin).name("nativeShelfBins"),
      tickets: s.toMany(() => ticket).name("nativeShelfTickets"),
    })
    .map(shelfTable);
  const bin = s
    .model({
      id: s.string().id(),
      shelfId: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("nativeShelfBins"),
      tickets: s.toMany(() => ticket).name("nativeBinTickets"),
    })
    .map(binTable);
  const ticket = s
    .model({
      id: s.string().id().default(nextTicketId),
      note: s.string(),
      binId: s.string().nullable(),
      bin: s
        .toOne(() => bin)
        .fields("binId")
        .references("id")
        .name("nativeBinTickets"),
      shelfId: s.string().nullable(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("nativeShelfTickets"),
    })
    .map(ticketTable);
  return { shelf, bin, ticket };
}

function updateShelf(id: string) {
  return {
    where: { id },
    data: {
      label: "prefix",
      bins: {
        updateMany: {
          where: {},
          data: { tickets: { create: { note: "created" } } },
        },
      },
      tickets: {
        update: {
          where: { id: "wanted" },
          data: { note: "looked-up" },
        },
      },
    },
  };
}

async function runMemberDependencyWorld(
  factory: CandidateEngineFactory,
  substrate: "interactive" | "atomic-batch"
) {
  let activeIds: readonly string[] = [];
  let activeIndex = 0;
  const admittedIds: string[] = [];
  const schema = memberDependencySchema(() => {
    const id = activeIds[activeIndex++];
    assert(id, "Every captured member must have one test-owned admitted id");
    admittedIds.push(id);
    return id;
  });
  const initial = {
    shelves: [
      { id: "s-fail", label: "initial" },
      { id: "s-ok", label: "initial" },
    ],
    bins: [
      { id: "b-fail", shelfId: "s-fail" },
      { id: "b-ok", shelfId: "s-ok" },
    ],
    tickets: [
      { id: "wanted", note: "independent", binId: null, shelfId: "s-ok" },
    ],
  };
  let dependencyFailure: unknown;
  const fixture: LiveFixture = {
    expectedExecutions: 2,
    initial,
    tables: {
      shelves: { name: shelfTable, order: ["id"] },
      bins: { name: binTable, order: ["id"] },
      tickets: { name: ticketTable, order: ["id"] },
    },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      const candidate = candidateFactory({ schema, driver });

      activeIds = ["other", "other2"];
      activeIndex = 0;
      const disjoint = await candidate.execute(
        "shelf",
        "update",
        updateShelf("s-ok")
      );

      activeIds = ["other", "wanted"];
      activeIndex = 0;
      try {
        await candidate.execute("shelf", "update", updateShelf("s-fail"));
      } catch (failure) {
        dependencyFailure = failure;
      }
      return disjoint;
    },
    assert(observation) {
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: { id: "s-ok", label: "prefix" },
      });
      assert(dependencyFailure instanceof NestedWriteError);
      assert.equal(dependencyFailure.code, VibORMErrorCode.NESTED_WRITE_FAILED);
      assert.equal(dependencyFailure.meta.operation, "update");
      assert.equal(dependencyFailure.meta.relation, "tickets");
      assert.equal(dependencyFailure.meta.conflictsWith, "create");
      assert.deepEqual(admittedIds, ["other", "other2", "other", "wanted"]);
      assert.deepEqual(observation.final, {
        shelves: [
          {
            id: "s-fail",
            label: substrate === "atomic-batch" ? "prefix" : "initial",
          },
          { id: "s-ok", label: "prefix" },
        ],
        bins: initial.bins,
        tickets: [
          { id: "other2", note: "created", binId: "b-ok", shelfId: null },
          { id: "wanted", note: "looked-up", binId: null, shelfId: "s-ok" },
        ],
      });
    },
  };

  const world = await runLiveWorld(
    fixture,
    (names) => ({
      [shelfTable]: `${names.quote("id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("label")} ${textType} NOT NULL`,
      [binTable]: `${names.quote("id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("shelfId")} ${textType} NOT NULL,FOREIGN KEY(${names.quote("shelfId")}) REFERENCES ${names.table(shelfTable)}(${names.quote("id")})`,
      [ticketTable]: `${names.quote("id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("note")} ${textType} NOT NULL,${names.quote("binId")} ${textType} NULL,${names.quote("shelfId")} ${textType} NULL,FOREIGN KEY(${names.quote("binId")}) REFERENCES ${names.table(binTable)}(${names.quote("id")}),FOREIGN KEY(${names.quote("shelfId")}) REFERENCES ${names.table(shelfTable)}(${names.quote("id")})`,
    }),
    factory,
    substrate
  );
  if (world.terminalFailure !== undefined) throw world.terminalFailure;
  fixture.assert(world.observation);
  world.assertHealthy();
}

describe(`G2.9 native ${liveProvider} captured-member dependencies`, () => {
  it(
    "refuses a dynamic member dependency and preserves a disjoint control interactively",
    () => runMemberDependencyWorld(createCommandEngine, "interactive"),
    30_000
  );
  it(
    "refuses a dynamic member dependency and preserves a disjoint control in a batch",
    () => runMemberDependencyWorld(createCommandEngine, "atomic-batch"),
    30_000
  );
});
