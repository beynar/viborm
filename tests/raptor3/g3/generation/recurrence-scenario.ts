import assert from "node:assert/strict";
import type {
  OperationOutcome,
  PreparedScenario,
  ScenarioControls,
  ScenarioDefinition,
} from "../../harness/protocol";
import { observeFailure } from "../../harness/sqlite-world";
import type { G3GeneratedRecipe } from "./recipe";
import { recurrenceCompoundWorld } from "./recurrence-compound-world";
import { recurrenceOrdinaryWorld } from "./recurrence-ordinary-world";
import { recurrenceVariantWorld } from "./recurrence-variant-world";
import type { RecurrenceRecipe, RecurrenceWorld } from "./recurrence-world";

function settledOutcome(
  settled: PromiseSettledResult<unknown>
): OperationOutcome {
  return settled.status === "fulfilled"
    ? { kind: "success", value: settled.value }
    : { kind: "failure", failure: observeFailure(settled.reason) };
}

function preparedRecurrence(
  recipe: RecurrenceRecipe,
  controls: ScenarioControls,
  world: RecurrenceWorld
): PreparedScenario {
  let starts = 0;
  let settlements = 0;
  const overlapCut = "g3-generated-recurrence-actors-overlapped";
  const providerCut = "g3-generated-recurrence-provider-completed";
  return {
    publicInput: { recipe },
    expectedExecutions: recipe.operations,
    requiredCuts: [providerCut, ...(recipe.actors === 2 ? [overlapCut] : [])],
    seed: world.seed,
    inspect: world.inspect,
    async invoke(driver, candidateFactory) {
      assert(
        candidateFactory,
        "G3 generated worlds require the command engine"
      );
      const candidate = candidateFactory({ schema: world.schema, driver });
      const execute = (index: number) => {
        const operation = world.operations[index];
        assert(operation, "g3-generated-recurrence:operation");
        starts++;
        return candidate
          .execute(operation.model, operation.operation, operation.args)
          .finally(() => settlements++);
      };
      const outcomes: PromiseSettledResult<unknown>[] = [];
      let next = 1;
      const first = execute(0);
      if (recipe.actors === 2) {
        assert(recipe.operations >= 2, "g3-generated-recurrence:actor-budget");
        const second = execute(1);
        assert.equal(starts, 2, "g3-generated-recurrence:two-starts");
        assert.equal(
          settlements,
          0,
          "g3-generated-recurrence:overlapping-lifetimes"
        );
        controls.recordCut(overlapCut);
        outcomes.push(...(await Promise.allSettled([first, second])));
        next = 2;
      } else {
        const [settled] = await Promise.allSettled([first]);
        assert(settled);
        outcomes.push(settled);
      }
      for (let index = next; index < recipe.operations; index++) {
        const [settled] = await Promise.allSettled([execute(index)]);
        assert(settled);
        outcomes.push(settled);
      }
      return outcomes.map(settledOutcome);
    },
    afterStatement() {
      return providerCut;
    },
    assert(observation) {
      assert.deepEqual(
        observation.initial,
        world.initial,
        "g3-generated-recurrence:initial-world"
      );
      assert.deepEqual(
        observation.final,
        world.final,
        "g3-generated-recurrence:final-world"
      );
      assert.equal(observation.outcome.kind, "success");
      if (observation.outcome.kind !== "success") return;
      assert(Array.isArray(observation.outcome.value));
      assert.equal(observation.outcome.value.length, recipe.operations);
      for (const [index, outcome] of observation.outcome.value.entries()) {
        assert(
          outcome && typeof outcome === "object" && "kind" in outcome,
          "g3-generated-recurrence:outcome"
        );
        if (recipe.fault !== "none" && index === 0) {
          assert.equal(outcome.kind, "failure");
          assert("failure" in outcome);
          assert(
            outcome.failure &&
              typeof outcome.failure === "object" &&
              "name" in outcome.failure
          );
          assert.equal(outcome.failure.name, "QueryError");
          continue;
        }
        assert.equal(outcome.kind, "success");
        assert("value" in outcome);
        assert.deepEqual(outcome.value, world.operations[index]?.expected);
      }
    },
  };
}

/** Fixed schema families vary only the admitted public recurrence recipe. */
export function generatedRecurrenceScenario(
  recipe: Extract<G3GeneratedRecipe, { contract: "C11" }>
): ScenarioDefinition {
  return {
    id: "g3-generated-depth-recurrence",
    family: "C11",
    contracts: ["C11", "C10", "C13"],
    sources: [
      "tests/raptor3/g3/depth-recurrence-contract.test.ts",
      "tests/contracts/engine/write/depth-seam-behavior.ts",
      "tests/contracts/engine/write/record-series-contract.test.ts",
      "tests/contracts/engine/write/polymorphic-collection-write-family.test.ts",
      "tests/contracts/engine/write/compound-junction.test.ts",
    ],
    prepare(controls) {
      const world =
        recipe.shape === "ordinary"
          ? recurrenceOrdinaryWorld(recipe, false)
          : recipe.shape === "repeated"
            ? recurrenceOrdinaryWorld(recipe, true)
            : recipe.shape === "compound"
              ? recurrenceCompoundWorld(recipe)
              : recurrenceVariantWorld(recipe);
      return preparedRecurrence(recipe, controls, world);
    },
  };
}
