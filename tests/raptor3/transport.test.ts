import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { afterEach, describe, it } from "vitest";
import {
  captureRaptor3Identity,
  RAPTOR3_ROOT,
} from "../../scripts/raptor3-manifest.mjs";
import type { ReplayRecord } from "./harness/protocol";
import { selectRaptor3EvidenceDirectory } from "./harness/evidence-directory";
import {
  decodeReplayRecords,
  encodeReplayRecords,
  replayG0Run,
} from "./harness/replay";
import { TRANSPORT_PROFILES, type TransportProfileId } from "./profiles";
import { runTransportWorld, type TransportRecipe } from "./transport/world";

const modes = ["create", "coc-found", "coc-missing"] as const;
const faultPositions = [
  "producer-rejected",
  "producer-empty",
  "producer-rejected-after-commit",
  "consumer-rejected",
  "consumer-rejected-after-commit",
  "consumer-malformed",
] as const;
const evidenceDirectoryContract =
  process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY_CONTRACT === "1";

async function replaySuccess(record: ReplayRecord) {
  const saved = decodeReplayRecords(encodeReplayRecords([record]));
  for (let replay = 0; replay < 3; replay++) await replayG0Run(saved[0]!);
}

async function saveCorpus(name: string, records: ReplayRecord[]) {
  const directory = await selectRaptor3EvidenceDirectory(
    "viborm-raptor3-transport-"
  );
  const corpus = {
    formatVersion: 1,
    identity: captureRaptor3Identity(),
    records: encodeReplayRecords(records),
  };
  await writeFile(
    join(directory, `${name}-corpus.json`),
    JSON.stringify(corpus)
  );
  return decodeReplayRecords(corpus.records);
}

async function checkedWorld(
  recipe: TransportRecipe,
  profile: TransportProfileId
) {
  const world = await runTransportWorld(recipe, profile);
  world.fixture.assert(world.observation);
  await replaySuccess(world.record);
  return world;
}

if (!evidenceDirectoryContract)
  describe.each(
    TRANSPORT_PROFILES
  )("G1 explicit transport replies: %s", (profile) => {
  for (const mode of modes) {
    it(`executes and exactly replays ${mode}`, async () => {
      await checkedWorld(
        { seed: 1000, mode, actors: 1, fault: "none", multiFault: false },
        profile
      );
    });
  }

  for (const mode of ["create", "coc-missing"] as const) {
    for (const fault of faultPositions) {
      it(`preserves ${mode} ${fault} and its healthy new-call suffix`, async () => {
        await checkedWorld(
          { seed: 1001, mode, actors: 1, fault, multiFault: false },
          profile
        );
      });
    }
  }

  it("queues two creates before release and explores both first actors with exact replay", async () => {
    const selectedFirst = new Set<string>();
    const records: ReplayRecord[] = [];
    // A fixed range, not a search that discards inconvenient schedules.
    for (let seed = 1000; seed < 1016; seed++) {
      const world = await checkedWorld(
        { seed, mode: "create", actors: 2, fault: "none", multiFault: false },
        profile
      );
      const first = world.record.tape.events.find(
        (event) => event.kind === "release"
      );
      assert(first?.kind === "release");
      assert.deepEqual(first.eligible, [
        "actor-1:producer",
        "actor-2:producer",
      ]);
      selectedFirst.add(first.selected);
      records.push(world.record);
    }
    assert.deepEqual([...selectedFirst].sort(), [
      "actor-1:producer",
      "actor-2:producer",
    ]);
    await saveCorpus(`transport-overlap-${profile}`, records);
  });

  it("records two failed calls and a healthy third call on one reusable engine", async () => {
    const world = await checkedWorld(
      {
        seed: 1017,
        mode: "create",
        actors: 1,
        fault: "none",
        multiFault: true,
      },
      profile
    );
    await saveCorpus(`transport-multifault-${profile}`, [world.record]);
  });

  for (const specimen of ["wrong-publication", "lost-progress"] as const) {
    it(`rejects ${specimen}, saves its full trace, and repeats the same failure three times`, async () => {
      const recipe: TransportRecipe =
        specimen === "wrong-publication"
          ? {
              seed: 1018,
              mode: "coc-found",
              actors: 1,
              fault: "none",
              multiFault: false,
            }
          : {
              seed: 1019,
              mode: "create",
              actors: 1,
              fault: "consumer-rejected",
              multiFault: false,
            };
      const control = await runTransportWorld(recipe, profile);
      control.fixture.assert(control.observation);
      const broken = await runTransportWorld(recipe, profile, { specimen });
      const property =
        specimen === "wrong-publication"
          ? /exact-publication-parameters/
          : /durable and uncertain progress must remain distinct/;
      assert.throws(() => broken.fixture.assert(broken.observation), property);
      const saved = await saveCorpus(`transport-${specimen}-${profile}`, [
        control.record,
        broken.record,
      ]);
      // The shared replay API first compares the whole encoded record, then invokes
      // the independent oracle. A different failure does not count as a replay.
      for (let replay = 0; replay < 3; replay++) {
        await replayG0Run(saved[0]!);
        await assert.rejects(() => replayG0Run(saved[1]!), property);
      }
    });
  }

  it("rejects corrupted failure attribution without changing transport progress", async () => {
    const world = await runTransportWorld(
      {
        seed: 1022,
        mode: "create",
        actors: 1,
        fault: "consumer-rejected",
        multiFault: false,
      },
      profile
    );
    world.fixture.assert(world.observation);
    const corruptions = [
      ["model", /failure model attribution/],
      ["operation", /failure operation attribution/],
      ["correlationId", /failure operation identity/],
      ["cause", /redacted provider cause/],
    ] as const;
    for (const [field, property] of corruptions) {
      const broken = structuredClone(world.observation);
      assert(broken.outcome.kind === "failure");
      const failure = broken.outcome.failure;
      const meta = failure.meta;
      assert(meta !== null && typeof meta === "object");
      if (field === "cause") {
        failure.cause = {
          name: "Error",
          message: "Wrong provider failure",
          code: "57014",
        };
      } else if (field === "correlationId") {
        Reflect.deleteProperty(meta, field);
      } else {
        Reflect.set(meta, field, `wrong-${field}`);
      }
      assert.throws(() => world.fixture.assert(broken), property);
    }
  });

  it("keeps an unknown response sticky when the caller swallows the second public call's failure", async () => {
    let swallowed: Promise<unknown> | undefined;
    await assert.rejects(
      () =>
        runTransportWorld(
          {
            seed: 1020,
            mode: "create",
            actors: 1,
            fault: "none",
            multiFault: false,
          },
          profile,
          {
            candidateFactory(config) {
              const engine = createCommandEngine(config);
              return {
                async execute(model, operation, rawArgs) {
                  const first = await engine.execute(model, operation, rawArgs);
                  // Deliberately broken caller: a new operation has no script and its
                  // rejection is hidden behind the first operation's plausible value.
                  swallowed = engine
                    .execute(model, operation, rawArgs)
                    .catch(() => first);
                  return await swallowed;
                },
                prepareBatch: (...args) => engine.prepareBatch(...args),
              };
            },
          }
        ),
      /Unknown or ambiguous scripted actor/
    );
    assert(swallowed, "The falsifier must reach the second public call");
    assert.deepEqual(await swallowed, { id: "account-1020-1", code: 101 });
  });

  it("rejects omitted provider work even when the caller returns the expected public row", async () => {
    await assert.rejects(
      () =>
        runTransportWorld(
          {
            seed: 1021,
            mode: "create",
            actors: 1,
            fault: "none",
            multiFault: false,
          },
          profile,
          {
            // This is a harness falsifier, never an implementation or expected-answer source.
            candidateFactory: () => ({
              execute: async () => ({ id: "account-1021-1", code: 101 }),
              prepareBatch: async () => undefined,
            }),
          }
        ),
      /Unconsumed explicit replies: actor-1/
    );
  });
  });

if (evidenceDirectoryContract) {
  const environmentKey = "VIBORM_RAPTOR3_EVIDENCE_DIRECTORY";
  const originalDirectory = process.cwd();
  const hadOriginalValue = Object.hasOwn(process.env, environmentKey);
  const originalValue = process.env[environmentKey];
  const temporaryDirectories: string[] = [];

  const temporaryDirectory = (prefix: string) => {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
  };

  const rootCorpusSnapshot = () =>
    Object.fromEntries(
      readdirSync(RAPTOR3_ROOT)
        .filter((name) => name.endsWith("-corpus.json"))
        .sort()
        .map((name) => [
          name,
          createHash("sha256")
            .update(readFileSync(resolve(RAPTOR3_ROOT, name)))
            .digest("hex"),
        ])
    );

  const transportProbeRecord = async () => {
    const world = await runTransportWorld(
      {
        seed: 1099,
        mode: "create",
        actors: 1,
        fault: "none",
        multiFault: false,
      },
      "scripted-returning-weak"
    );
    world.fixture.assert(world.observation);
    return world.record;
  };

  afterEach(() => {
    process.chdir(originalDirectory);
    if (hadOriginalValue && originalValue !== undefined)
      process.env[environmentKey] = originalValue;
    else delete process.env[environmentKey];
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  describe("transport corpus evidence-directory caller", () => {
    it("uses a private temporary directory when the variable is unset", async () => {
      const isolated = temporaryDirectory("viborm-raptor3-unset-cwd-");
      process.chdir(isolated);
      delete process.env[environmentKey];
      const name = `unset-${randomUUID()}`;
      await saveCorpus(name, [await transportProbeRecord()]);
      assert.equal(existsSync(join(isolated, `${name}-corpus.json`)), false);
    });

    it("treats an empty variable as unset instead of the working directory", async () => {
      const isolated = temporaryDirectory("viborm-raptor3-empty-cwd-");
      process.chdir(isolated);
      process.env[environmentKey] = "";
      const name = `empty-${randomUUID()}`;
      await saveCorpus(name, [await transportProbeRecord()]);
      assert.equal(existsSync(join(isolated, `${name}-corpus.json`)), false);
    });

    it("writes into an explicit evidence directory", async () => {
      const isolated = temporaryDirectory("viborm-raptor3-explicit-cwd-");
      const explicit = temporaryDirectory("viborm-raptor3-explicit-");
      process.chdir(isolated);
      process.env[environmentKey] = explicit;
      const name = `explicit-${randomUUID()}`;
      await saveCorpus(name, [await transportProbeRecord()]);
      assert.equal(existsSync(join(explicit, `${name}-corpus.json`)), true);
      assert.equal(existsSync(join(isolated, `${name}-corpus.json`)), false);
    });

    it("cannot add or rewrite repository-root corpora from an empty value", async () => {
      const before = rootCorpusSnapshot();
      const isolated = temporaryDirectory("viborm-raptor3-growth-cwd-");
      process.chdir(isolated);
      process.env[environmentKey] = "";
      await saveCorpus(`growth-${randomUUID()}`, [await transportProbeRecord()]);
      assert.deepEqual(rootCorpusSnapshot(), before);
    });
  });
}
