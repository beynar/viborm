import assert from "node:assert/strict";
import { it } from "vitest";
import { assertEquivalentRunObservations } from "../../benchmarks/operation-pipeline-semantics.mjs";
import type { ScenarioDefinition } from "./harness/protocol";
import { assertFixedInventory } from "./harness/replay";
import { runSQLiteWorld } from "./harness/sqlite-world";
import { G0_PROFILES } from "./profiles";
import { fixedScenarios } from "./scenarios/contracts";

it("refuses a requested candidate that the fixture silently bypasses", async () => {
  const original = fixedScenarios.find(
    (scenario) => scenario.id === "s3-empty"
  )!;
  const bypassed: ScenarioDefinition = {
    ...original,
    prepare(controls) {
      const fixture = original.prepare(controls);
      return {
        ...fixture,
        invoke(driver) {
          return fixture.invoke(driver);
        },
      };
    },
  };
  await assert.rejects(
    runSQLiteWorld(bypassed, "sqlite-interactive", 0, {
      candidateFactory: () => ({
        async execute() {
          throw new Error("This deliberately ignored candidate must not run");
        },
        async prepareBatch() {
          throw new Error("This deliberately ignored candidate must not run");
        },
      }),
    }),
    /Unexpected candidate execution count/
  );
});

it("refuses duplicate cases even when the fixed case count is unchanged", () => {
  const duplicated = fixedScenarios.map((scenario) =>
    scenario.id === "s3-empty" ? fixedScenarios[0]! : scenario
  );
  assert.throws(
    () => assertFixedInventory(duplicated, G0_PROFILES),
    /Missing or duplicate fixed G0 case/
  );
});

it("refuses duplicate profiles even when the profile count is unchanged", () => {
  assert.throws(
    () =>
      assertFixedInventory(fixedScenarios, [
        "sqlite-interactive",
        "sqlite-interactive",
      ]),
    /Missing or duplicate required G0 profile/
  );
});

it("compares correlation identity without prescribing another engine's UUID draws", async () => {
  const scenario = fixedScenarios.find(
    (entry) => entry.id === "s1-parent-rollback"
  )!;
  const { observation } = await runSQLiteWorld(
    scenario,
    "sqlite-interactive",
    0
  );
  if (observation.outcome.kind !== "failure")
    throw new Error("The rollback witness must fail");
  const original = observation.outcome.failure;
  const metadata = original.meta as Record<string, unknown>;
  const correlated = (outer: unknown) => ({
    ...observation,
    outcome: {
      kind: "failure" as const,
      failure: {
        ...original,
        meta: { ...metadata, correlationId: outer },
      },
    },
  });
  const equal = correlated("one");
  assertEquivalentRunObservations("renamed", equal, correlated("another"));
  for (const invalid of [
    correlated(undefined),
    correlated(""),
    correlated(42),
  ]) {
    assert.throws(() =>
      assertEquivalentRunObservations("invalid", equal, invalid)
    );
  }
  for (const metadata of [{ model: "wrong-model" }, { operation: "delete" }]) {
    const changed = correlated("another");
    Object.assign(changed.outcome.failure.meta, metadata);
    assert.throws(() =>
      assertEquivalentRunObservations("attribution", equal, changed)
    );
  }
  const absent = correlated("another");
  delete (absent.outcome.failure.meta as Record<string, unknown>).correlationId;
  assert.throws(() => assertEquivalentRunObservations("absent", equal, absent));
});

it("does not rename correlation-looking keys in public results or database rows", () => {
  const observation = {
    outcome: {
      kind: "success" as const,
      value: { correlationId: "user-value" },
    },
    initial: {},
    final: {},
    defaults: [],
    reachedCuts: [],
  };
  assert.throws(() =>
    assertEquivalentRunObservations("public value", observation, {
      ...observation,
      outcome: {
        kind: "success",
        value: { correlationId: "changed-user-value" },
      },
    })
  );
  assert.throws(() =>
    assertEquivalentRunObservations(
      "stored value",
      {
        ...observation,
        final: { rows: [{ correlationId: "user-value" }] },
      },
      {
        ...observation,
        final: { rows: [{ correlationId: "changed-user-value" }] },
      }
    )
  );
});

it("preserves opaque Error causes even when they resemble error observations", async () => {
  const scenario = fixedScenarios.find((entry) => entry.id === "s3-empty")!;
  const observe = (correlationId: string) =>
    runSQLiteWorld(scenario, "sqlite-interactive", 0, {
      candidateFactory: () => ({
        async execute() {
          throw new Error("Deliberate opaque cause", {
            cause: {
              name: "payload",
              message: "caller-owned value",
              meta: { correlationId },
            },
          });
        },
        async prepareBatch() {
          throw new Error("Deliberate opaque cause");
        },
      }),
    });
  const baseline = await observe("caller-value-a");
  const changed = await observe("caller-value-b");
  assert.throws(() =>
    assertEquivalentRunObservations(
      "opaque cause",
      baseline.observation,
      changed.observation
    )
  );
});
