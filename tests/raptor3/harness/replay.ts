import assert from "node:assert/strict";
import { z } from "zod";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import {
  decodeEvidenceValue,
  encodeEvidenceValue,
} from "../../../benchmarks/operation-pipeline-evidence.mjs";
import { assertEquivalentRunObservations } from "../../../benchmarks/operation-pipeline-semantics.mjs";
import { G0_CAMPAIGN } from "../../../scripts/raptor3-manifest.mjs";
import {
  G0_CASE_IDS,
  G1_CASE_IDS,
  G1_LIFETIME_CASE_IDS,
  G1_VARIANT_IDENTITY_CASE_IDS,
  G2_KEY_CASE_IDS,
  G2_SINGULAR_CASE_IDS,
  G2_CAPTURED_KEY_CASE_IDS,
  G2_JUNCTION_CASE_IDS,
  G2_JUNCTION_IDENTITY_CASE_IDS,
  G2_MEMBERSHIP_OWN_WRITE_CASE_IDS,
  G2_SERIES_STALENESS_CASE_IDS,
  G2_REQUIRED_CASE_IDS,
  G2_OWN_WRITE_CASE_IDS,
  G2_OCCUPIED_KEY_CASE_IDS,
  G2_SUPPLIER_CASE_IDS,
  G2_LATTICE_CASE_IDS,
  G2_CONDITIONAL_UPSERT_CASE_IDS,
  G2_SHARED_KEY_SUPPLIER_CASE_IDS,
  G2_MIXED_KEY_CASE_IDS,
  G2_VARIANT_REMOVAL_CASE_IDS,
  G25_CASE_IDS,
  CS03_EXTENSION_CASE_IDS,
  HARNESS_CASE_IDS,
} from "../contracts";
import { G0_PROFILES, TRANSPORT_PROFILES, type ProfileId } from "../profiles";
import { fixedScenarios } from "../scenarios/contracts";
import { findReplayScenario } from "../scenarios";
import { extensionRecipeFromPublicInput } from "../core-structure/measurement/extension-recipes";
import { extensionScenario } from "../core-structure/measurement/extension-scenarios";
import {
  generatedRelations,
  recipeFromPublicInput,
} from "../generation/relations";
import {
  generatedTransitions,
  transitionRecipeFromPublicInput,
} from "../generation/transitions";
import { recordingEventLimit } from "./recorder";
import type {
  G0ReplayRecord,
  ReplayRecord,
  ScenarioDefinition,
} from "./protocol";
import {
  runTransportWorld,
  transportRecipeFromPublicInput,
} from "../transport/world";
import { type ObservedWorld, runSQLiteWorld } from "./sqlite-world";

const failureSchema = z.strictObject({
  name: z.string(),
  message: z.string(),
  code: z.string().optional(),
  meta: z.unknown().optional(),
  cause: z.unknown().optional(),
  errors: z.array(z.unknown()).optional(),
});
const defaultSchema = z.strictObject({
  name: z.string(),
  value: z.union([z.string(), z.number()]),
});
const statementSchema = z.strictObject({
  sql: z.string(),
  parameters: z.array(z.unknown()),
  rows: z.array(z.unknown()),
  transactionOpen: z.boolean(),
});
const eventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("clock"), value: z.number() }),
  z.strictObject({
    kind: z.literal("random"),
    source: z.enum(["uuid", "math"]),
    value: z.union([z.string(), z.number()]),
  }),
  z.strictObject({ kind: z.literal("default"), observation: defaultSchema }),
  z.strictObject({
    kind: z.literal("dispatch"),
    sql: z.string(),
    parameters: z.array(z.unknown()),
    transactionOpen: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("completion"),
    statement: statementSchema,
    releaseTurns: z.number().int().min(0).max(2),
  }),
  z.strictObject({
    kind: z.literal("dispatch-failure"),
    failure: failureSchema,
  }),
  z.strictObject({
    kind: z.literal("cleanup-failure"),
    failure: failureSchema,
  }),
  z.strictObject({
    kind: z.literal("transaction"),
    phase: z.enum(["begin", "commit", "rollback"]),
  }),
  z.strictObject({
    kind: z.literal("transaction-failure"),
    phase: z.enum(["begin", "commit", "rollback"]),
    failure: failureSchema,
  }),
  z.strictObject({ kind: z.literal("cut"), name: z.string() }),
  z.strictObject({ kind: z.literal("injected-failure"), cut: z.string() }),
  z.strictObject({
    kind: z.literal("release"),
    eligible: z.array(z.string()).nonempty(),
    selected: z.string(),
  }),
  z.strictObject({
    kind: z.literal("transport"),
    request: z.string(),
    actor: z.string(),
    correlationId: z.string(),
    phase: z.enum([
      "queued",
      "committed",
      "acknowledged",
      "returned",
      "rejected",
    ]),
  }),
]);
const stateSchema = z.record(z.string(), z.array(z.unknown()));
const outcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("success"), value: z.unknown() }),
  z.strictObject({ kind: z.literal("failure"), failure: failureSchema }),
]);
const sqliteRecordSchema = z.strictObject({
  candidate: z.literal("commands").optional(),
  specimen: z.literal("wrong-parent-world").optional(),
  scenarioId: z.enum([
    ...G0_CASE_IDS,
    ...G1_CASE_IDS,
    ...G1_LIFETIME_CASE_IDS,
    ...G1_VARIANT_IDENTITY_CASE_IDS,
    ...G2_KEY_CASE_IDS,
    ...G2_SINGULAR_CASE_IDS,
    ...G2_CAPTURED_KEY_CASE_IDS,
    ...G2_JUNCTION_CASE_IDS,
    ...G2_JUNCTION_IDENTITY_CASE_IDS,
    ...G2_MEMBERSHIP_OWN_WRITE_CASE_IDS,
    ...G2_SERIES_STALENESS_CASE_IDS,
    ...G2_REQUIRED_CASE_IDS,
    ...G2_OWN_WRITE_CASE_IDS,
    ...G2_OCCUPIED_KEY_CASE_IDS,
    ...G2_SUPPLIER_CASE_IDS,
    ...G2_LATTICE_CASE_IDS,
    ...G2_CONDITIONAL_UPSERT_CASE_IDS,
    ...G2_SHARED_KEY_SUPPLIER_CASE_IDS,
    ...G2_MIXED_KEY_CASE_IDS,
    ...G2_VARIANT_REMOVAL_CASE_IDS,
    ...G25_CASE_IDS,
    ...CS03_EXTENSION_CASE_IDS,
    ...HARNESS_CASE_IDS,
    "g1-generated-relations",
    "g2-generated-transitions",
  ]),
  profile: z.enum(G0_PROFILES),
  seed: z.number().int().nonnegative().safe(),
  fault: z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("before-dispatch"),
        times: z.number().int().min(1).max(8).optional(),
      }),
      z.strictObject({ kind: z.literal("at-cut"), cut: z.string() }),
      z.strictObject({ kind: z.literal("after-rollback") }),
    ])
    .optional(),
  publicInput: z.unknown(),
  schema: z.array(z.unknown()),
  sqliteVersion: z.string(),
  tape: z.strictObject({ events: z.array(eventSchema) }),
  observation: z.strictObject({
    outcome: outcomeSchema,
    subsequentOutcomes: z.array(outcomeSchema).optional(),
    initial: stateSchema,
    final: stateSchema,
    defaults: z.array(defaultSchema),
    reachedCuts: z.array(z.string()),
  }),
  statements: z.array(statementSchema),
}) satisfies z.ZodType<G0ReplayRecord>;

const recordSchema: z.ZodType<ReplayRecord> = z
  .union([
    sqliteRecordSchema,
    sqliteRecordSchema
      .omit({ sqliteVersion: true, fault: true, specimen: true })
      .extend({
        scenarioId: z.enum(["g1-transport", "g2-transport"]),
        candidate: z.literal("commands").optional(),
        profile: z.enum(TRANSPORT_PROFILES),
        transportVersion: z.literal("explicit-replies-v1"),
        specimen: z
          .enum(["wrong-publication", "lost-progress", "wrong-attribution"])
          .optional(),
      }),
  ])
  .refine(
    (record) =>
      record.tape.events.length <= recordingEventLimit(record.scenarioId),
    "Saved tape exceeds the admitted scenario's event budget"
  );

/** The fixed oracle runs on both worlds before the shared semantic comparator. */
export function verifyG0Pair(
  baseline: ObservedWorld,
  compared: ObservedWorld
): void {
  baseline.fixture.assert(baseline.observation);
  compared.fixture.assert(compared.observation);
  assertEquivalentRunObservations(
    baseline.record.scenarioId,
    baseline.observation,
    compared.observation
  );
}

export async function replayG0Run(record: ReplayRecord) {
  const replayed =
    "transportVersion" in record
      ? await runTransportWorld(
          transportRecipeFromPublicInput(record.publicInput),
          record.profile,
          {
            replay: record.tape,
            specimen: record.specimen,
            candidateName: record.candidate ?? "legacy",
          }
        )
      : await runSQLiteWorld(
          record.scenarioId.startsWith("cs03-extension-")
            ? extensionScenario(
                extensionRecipeFromPublicInput(record.publicInput)
              )
            : record.scenarioId === "g1-generated-relations"
              ? generatedRelations(
                  recipeFromPublicInput(record.publicInput),
                  record.specimen === "wrong-parent-world"
                )
              : record.scenarioId === "g2-generated-transitions"
                ? generatedTransitions(
                    transitionRecipeFromPublicInput(record.publicInput),
                    record.specimen === "wrong-parent-world"
                  )
                : findReplayScenario(record.scenarioId),
          record.profile,
          record.seed,
          {
            candidateName: record.candidate,
            candidateFactory:
              record.candidate === "commands" ? createCommandEngine : undefined,
            replay: record.tape,
            fault: record.fault,
          }
        );
  // Exact diagnostics belong to this same-source replay, never cross-engine equality.
  assert.deepEqual(
    encodeReplayRecords([replayed.record]),
    encodeReplayRecords([record]),
    "Saved world, input, provider, diagnostics or observations changed"
  );
  replayed.fixture.assert(replayed.observation);
  return replayed;
}

/** One fixed-case/profile admission rule serves the baseline and candidates. */
export function assertFixedInventory(
  scenarios: readonly ScenarioDefinition[],
  profiles: readonly ProfileId[]
): void {
  assert.deepEqual(
    scenarios.map((scenario) => scenario.id).sort(),
    [...G0_CASE_IDS].sort(),
    "Missing or duplicate fixed G0 case"
  );
  assert.deepEqual(
    [...profiles].sort(),
    [...G0_CAMPAIGN.profiles].sort(),
    "Missing or duplicate required G0 profile"
  );
}

export async function runG0Campaign(options: {
  firstSeed: number;
  seedCount: number;
  scenarios?: readonly ScenarioDefinition[];
  profiles?: readonly ProfileId[];
}) {
  const scenarios = options.scenarios ?? fixedScenarios;
  const profiles = options.profiles ?? G0_PROFILES;
  assert(
    Number.isSafeInteger(options.firstSeed) && options.firstSeed >= 0,
    "Invalid first schedule seed"
  );
  assert(
    Number.isSafeInteger(options.seedCount) &&
      options.seedCount > 0 &&
      options.seedCount <= 100,
    "Campaign requires 1–100 schedule seeds"
  );
  assertFixedInventory(scenarios, profiles);
  const records: G0ReplayRecord[] = [];
  let replays = 0;
  async function verifyCell(
    scenario: ScenarioDefinition,
    profile: (typeof G0_PROFILES)[number],
    seed: number
  ) {
    const baseline = await runSQLiteWorld(scenario, profile, seed);
    const compared = await runSQLiteWorld(scenario, profile, seed);
    verifyG0Pair(baseline, compared);
    for (let replay = 0; replay < 3; replay += 1) {
      await replayG0Run(baseline.record);
      replays += 1;
    }
    records.push(baseline.record);
  }
  for (const profile of profiles) {
    for (const scenario of scenarios)
      await verifyCell(scenario, profile, options.firstSeed);
    for (let offset = 0; offset < options.seedCount; offset += 1) {
      const seed = options.firstSeed + offset;
      const scenario = scenarios[seed % scenarios.length];
      assert(scenario, "Schedule selected no fixed scenario");
      await verifyCell(scenario, profile, seed);
    }
  }
  return {
    records,
    fixedCells: profiles.length * scenarios.length,
    seededCells: options.seedCount * profiles.length,
    replays,
    skipped: 0,
  };
}

/** Tags wrap every array/record, so user-shaped arrays cannot impersonate bigint/undefined. */
export function encodeReplayRecords(records: readonly ReplayRecord[]): unknown {
  return encodeEvidenceValue(records);
}

export function decodeReplayRecords(wire: unknown): ReplayRecord[] {
  const records = decodeEvidenceValue(wire);
  assertReplayRecords(records);
  return records;
}

function assertReplayRecords(
  records: unknown
): asserts records is ReplayRecord[] {
  // These schemas have no coercions/transforms. Keep the admitted wire objects
  // themselves, including public input key order, instead of Zod's shaped copies.
  z.array(recordSchema).nonempty().parse(records);
}
