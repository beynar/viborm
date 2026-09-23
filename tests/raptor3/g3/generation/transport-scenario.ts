import assert from "node:assert/strict";
import type {
  DefaultObservation,
  OperationOutcome,
  ReplayTape,
  RunObservation,
  TransportReplayRecord,
} from "../../harness/protocol";
import { Recorder, recordingEventLimit } from "../../harness/recorder";
import { observeFailure } from "../../harness/sqlite-world";
import type { TransportProfileId } from "../../profiles";
import { ScriptedTransport } from "../../transport/driver";
import type { G3GeneratedRecipe } from "./recipe";
import { transportPlan, type TransportJob } from "./transport-plans";

function operationOutcome(
  settled: PromiseSettledResult<unknown>
): OperationOutcome {
  return settled.status === "fulfilled"
    ? { kind: "success", value: settled.value }
    : { kind: "failure", failure: observeFailure(settled.reason) };
}

export async function runG3TransportWorld(
  recipe: G3GeneratedRecipe,
  profile: TransportProfileId,
  replay?: ReplayTape
) {
  const recorder = new Recorder(
    recipe.seed,
    replay,
    recordingEventLimit("g3-generated-transport")
  );
  const defaults: DefaultObservation[] = [];
  const plan = transportPlan(recipe, recorder, defaults);
  let admissions = 0;
  let starts = 0;
  let settlements = 0;
  const reachedCuts: string[] = [];
  let jobs: TransportJob[] = [];
  let driver: ScriptedTransport | undefined;
  const outcomes: OperationOutcome[] = [];
  await recorder.control(async () => {
    driver = new ScriptedTransport([], recorder, profile);
    jobs = plan.jobs(driver, () => admissions++);
    driver.installScripts(
      jobs.flatMap((job) => (job.script ? [job.script] : []))
    );
    let physicalActors = 0;
    const settle = async (selected: readonly TransportJob[]) => {
      const pending = selected.map((job) => {
        starts++;
        return job.run().finally(() => settlements++);
      });
      physicalActors += selected.filter((job) => job.script).length;
      const work = Promise.allSettled(pending);
      return physicalActors > 0 ? driver!.drain(work, physicalActors) : work;
    };
    try {
      let next = 1;
      if (recipe.actors === 2) {
        const first = jobs.slice(0, 2);
        assert.equal(first.length, 2, "G3 transport actor budget");
        const pending = settle(first);
        assert.equal(starts, 2, "G3 transport requires two logical starts");
        assert.equal(
          settlements,
          0,
          "G3 transport overlap cut must precede either settlement"
        );
        const cut = "g3-generated-transport-actors-overlapped";
        reachedCuts.push(cut);
        recorder.record({ kind: "cut", name: cut });
        outcomes.push(...(await pending).map(operationOutcome));
        next = 2;
      } else {
        outcomes.push(...(await settle([jobs[0]!])).map(operationOutcome));
      }
      for (let index = next; index < jobs.length; index++)
        outcomes.push(...(await settle([jobs[index]!])).map(operationOutcome));
      driver.finish();
    } finally {
      await driver.disconnect();
    }
  });
  assert(driver);
  const completedDriver = driver;
  const tape = recorder.finish();
  const observation: RunObservation = {
    outcome: outcomes[0]!,
    ...(outcomes.length > 1 ? { subsequentOutcomes: outcomes.slice(1) } : {}),
    initial: {},
    final: { transport: completedDriver.dispatched },
    defaults,
    reachedCuts,
  };
  const record: TransportReplayRecord = {
    scenarioId: "g3-generated-transport",
    candidate: "commands",
    profile,
    seed: recipe.seed,
    transportVersion: "explicit-replies-v1",
    publicInput: { recipe },
    schema: plan.schema,
    observation,
    tape,
    statements: completedDriver.statements,
  };
  return {
    record,
    observation,
    statements: completedDriver.statements,
    fixture: {
      assert(observed: RunObservation) {
        assert.equal(admissions, recipe.operations);
        assert.deepEqual(observed.initial, {});
        assert.deepEqual(observed.defaults, plan.expectedDefaults);
        assert.deepEqual(observed.reachedCuts, reachedCuts);
        const observedOutcomes = [
          observed.outcome,
          ...(observed.subsequentOutcomes ?? []),
        ];
        assert.equal(observedOutcomes.length, jobs.length);
        jobs.forEach((job, index) => job.assert(observedOutcomes[index]!));
        assert.equal(
          tape.events.filter((event) => event.kind === "injected-failure")
            .length,
          recipe.fault === "none" ? 0 : 1
        );
        assert.equal(
          reachedCuts.includes("g3-generated-transport-actors-overlapped"),
          recipe.actors === 2
        );
        for (const script of jobs.flatMap((job) =>
          job.script ? [job.script] : []
        )) {
          const requests = completedDriver.dispatched.filter(
            (request) => request.actor === script.name
          );
          assert.deepEqual(
            requests.map((request) => request.request),
            script.replies.map((reply) => reply.name),
            `${script.name}: exact scripted request sequence`
          );
          assert(
            requests[0]?.parameters.some((parameters) =>
              parameters.includes(script.firstParameter)
            ),
            `${script.name}: public actor value reached its own provider request`
          );
        }
      },
    },
  };
}
