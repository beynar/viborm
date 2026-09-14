import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "@validation/value-guards";
import { afterAll, describe, it } from "vitest";
import { captureRaptor3Identity } from "../../scripts/raptor3-manifest.mjs";
import type { ReplayRecord } from "./harness/protocol";
import {
  decodeReplayRecords,
  encodeReplayRecords,
  replayG0Run,
} from "./harness/replay";
import { TRANSPORT_PROFILES, type TransportProfileId } from "./profiles";
import {
  runTransportWorld,
  type TransportRecipe,
  verifyTransportPair,
} from "./transport/world";

const records: ReplayRecord[] = [];
afterAll(async () => {
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (directory)
    await writeFile(
      join(directory, "g2-transport-corpus.json"),
      JSON.stringify({
        formatVersion: 1,
        identity: captureRaptor3Identity(),
        records: encodeReplayRecords(records),
      })
    );
});

function recipe(
  overrides: Partial<Extract<TransportRecipe, { mode: "key-update" }>> = {}
): TransportRecipe {
  return {
    seed: 2000,
    mode: "key-update",
    actors: 1,
    fault: "none",
    multiFault: false,
    ...overrides,
  };
}

async function checked(input: TransportRecipe, profile: TransportProfileId) {
  const baseline = await runTransportWorld(input, profile, {
    candidateName: "legacy",
  });
  records.push(baseline.record);
  const world = await runTransportWorld(input, profile);
  records.push(world.record);
  verifyTransportPair(baseline, world);
  if (
    input.fault === "consumer-malformed" &&
    profile === "scripted-returning-ack"
  ) {
    const outcome = world.observation.outcome;
    assert.equal(outcome.kind, "failure");
    assert(isRecord(outcome.failure.meta));
    const meta = outcome.failure.meta;
    const progress = meta.recordSeriesProgress;
    assert(isRecord(progress));
    for (const changedMeta of [
      { ...meta, operation: "create" },
      { ...meta, scalarType: "string" },
      {
        ...meta,
        recordSeriesProgress: { ...progress, phase: "member" },
      },
      {
        ...meta,
        recordSeriesProgress: { ...progress, memberPath: [0] },
      },
    ])
      assert.throws(() =>
        verifyTransportPair(baseline, {
          ...world,
          observation: {
            ...world.observation,
            outcome: {
              ...outcome,
              failure: { ...outcome.failure, meta: changedMeta },
            },
          },
        })
      );
  }
  if (
    input.fault === "consumer-rejected-after-commit" &&
    profile === "scripted-returning-ack"
  ) {
    const outcome = world.observation.outcome;
    assert.equal(outcome.kind, "failure");
    assert(isRecord(outcome.failure.meta));
    const poisonedObservation = {
      ...world.observation,
      outcome: {
        ...outcome,
        failure: {
          ...outcome.failure,
          meta: Object.assign(
            Object.create(Object.getPrototypeOf(outcome.failure.meta)),
            outcome.failure.meta,
            { unapprovedDiagnostic: true }
          ),
        },
      },
    };
    world.fixture.assert(poisonedObservation);
    assert.throws(() =>
      verifyTransportPair(baseline, {
        ...world,
        observation: poisonedObservation,
      })
    );
  }
  for (const saved of decodeReplayRecords(
    encodeReplayRecords([baseline.record, world.record])
  ))
    for (let replay = 0; replay < 3; replay++) await replayG0Run(saved);
  return world;
}

describe.each(
  TRANSPORT_PROFILES
)("G2 key-transition transport: %s", (profile) => {
  it("publishes the final key and reference to the consumer", async () => {
    await checked(recipe(), profile);
  });
  for (const fault of [
    "consumer-rejected",
    "consumer-rejected-after-commit",
    "consumer-malformed",
  ] as const)
    it(`preserves ${fault} and completes a healthy later call`, async () => {
      await checked(recipe({ seed: 2001, fault }), profile);
    });
  it("queues both selected records and explores both first actors", async () => {
    const firstActors = new Set<string>();
    for (let seed = 2000; seed < 2016; seed++) {
      const world = await checked(recipe({ seed, actors: 2 }), profile);
      const release = world.record.tape.events.find(
        (event) => event.kind === "release"
      );
      assert(release?.kind === "release");
      assert.deepEqual(release.eligible, ["actor-1:lookup", "actor-2:lookup"]);
      firstActors.add(release.selected);
    }
    assert.deepEqual([...firstActors].sort(), [
      "actor-1:lookup",
      "actor-2:lookup",
    ]);
  });
  it("preserves two failed calls and a healthy third call", async () => {
    await checked(recipe({ seed: 2017, multiFault: true }), profile);
  });
  for (const specimen of ["wrong-publication", "wrong-attribution"] as const)
    it(`rejects and exactly replays ${specimen}`, async () => {
      const input = recipe({
        seed: 2018,
        fault:
          specimen === "wrong-attribution"
            ? "consumer-rejected-after-commit"
            : "none",
      });
      await checked(input, profile);
      const world = await runTransportWorld(input, profile, { specimen });
      records.push(world.record);
      const property =
        specimen === "wrong-publication"
          ? /exact-publication-parameters/
          : /failure operation attribution/;
      assert.throws(() => world.fixture.assert(world.observation), property);
      const saved = decodeReplayRecords(
        encodeReplayRecords([world.record])
      )[0]!;
      for (let replay = 0; replay < 3; replay++)
        await assert.rejects(() => replayG0Run(saved), property);
    });
});
