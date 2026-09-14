import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { z } from "zod";
import { assertEquivalentRunObservations } from "../../../benchmarks/operation-pipeline-semantics.mjs";
import type {
  CandidateEngineFactory,
  DefaultObservation,
  OperationOutcome,
  ReplayTape,
  RunObservation,
  TransportReplayRecord,
} from "../harness/protocol";
import { Recorder, recordingEventLimit } from "../harness/recorder";
import { observeFailure } from "../harness/sqlite-world";
import type { TransportProfileId } from "../profiles";
import { type ActorScript, type Reply, ScriptedTransport } from "./driver";

const faults = [
  "none",
  "producer-rejected",
  "producer-empty",
  "producer-rejected-after-commit",
  "consumer-rejected",
  "consumer-rejected-after-commit",
  "consumer-malformed",
] as const;
const g1RecipeSchema = z
  .object({
    seed: z.number().int().min(1000).max(1999),
    mode: z.enum(["create", "coc-found", "coc-missing"]),
    actors: z.union([z.literal(1), z.literal(2)]),
    fault: z.enum(faults),
    multiFault: z.boolean(),
  })
  .strict()
  .refine(
    (recipe) =>
      recipe.mode !== "coc-found" ||
      (recipe.fault === "none" && !recipe.multiFault),
    "Found COC has no generated-output fault cut"
  )
  .refine(
    (recipe) =>
      !recipe.multiFault || (recipe.actors === 1 && recipe.fault === "none"),
    "The explicit multifault witness owns two sequential failed calls and one healthy call"
  );

const transitionFaults = [
  "none",
  "consumer-rejected",
  "consumer-rejected-after-commit",
  "consumer-malformed",
] as const;
const g2RecipeSchema = z
  .strictObject({
    seed: z.number().int().min(2000).max(7099),
    mode: z.literal("key-update"),
    actors: z.union([z.literal(1), z.literal(2)]),
    fault: z.enum(transitionFaults),
    multiFault: z.boolean(),
  })
  .refine(
    (recipe) =>
      !recipe.multiFault || (recipe.actors === 1 && recipe.fault === "none"),
    "The explicit multifault witness owns two failed updates and a healthy call"
  );
const recipeSchema = z.union([g1RecipeSchema, g2RecipeSchema]);

export type TransportRecipe = z.infer<typeof recipeSchema>;

export function generateTransportRecipe(seed: number): TransportRecipe {
  if (seed >= 2000)
    return g2RecipeSchema.parse({
      seed,
      mode: "key-update",
      actors: seed % 4 === 0 ? 2 : 1,
      fault:
        seed % 4 === 1
          ? transitionFaults[1 + (Math.floor(seed / 4) % 3)]
          : "none",
      multiFault: false,
    });
  const faulty = seed % 4 === 1;
  return recipeSchema.parse({
    seed,
    mode: faulty
      ? Math.floor(seed / 4) % 2 === 0
        ? "create"
        : "coc-missing"
      : ["create", "coc-found", "coc-missing"][seed % 3],
    actors: seed % 4 === 0 ? 2 : 1,
    fault: faulty ? faults[1 + (Math.floor(seed / 4) % 6)] : "none",
    multiFault: false,
  });
}

export function transportRecipeFromPublicInput(
  publicInput: unknown
): TransportRecipe {
  return z.object({ recipe: recipeSchema }).parse(publicInput).recipe;
}

function faultsForRecipe(recipe: TransportRecipe): TransportRecipe["fault"][] {
  if (recipe.multiFault)
    return recipe.mode === "key-update"
      ? ["consumer-rejected", "consumer-rejected-after-commit", "none"]
      : ["producer-rejected", "consumer-rejected", "none"];
  return [
    recipe.fault,
    ...(recipe.actors === 2 ? ["none" as const] : []),
    ...(recipe.fault !== "none" ? ["none" as const] : []),
  ];
}

interface PublicActor {
  name: string;
  model: "account" | "token";
  accountId: string;
  finalAccountId: string;
  tokenId: string;
  code: number;
  operation: "create" | "update";
  admittedLabel: string;
  fault: TransportRecipe["fault"];
  args: unknown;
}

/** Explicit values below describe transport behavior, never simulated database truth. */
function actorScript(
  actor: PublicActor,
  mode: TransportRecipe["mode"],
  candidate: "commands" | "legacy"
): ActorScript {
  const replies: Reply[] = [];
  if (mode === "key-update") {
    replies.push({
      name: `${actor.name}:lookup`,
      via: "execute",
      committed: false,
      statements: [
        {
          action: "SELECT",
          parameters:
            candidate === "legacy" ? [actor.accountId] : [actor.accountId, 1],
        },
      ],
      outcome: {
        kind: "rows",
        responses: [
          {
            rows: [
              {
                id: actor.accountId,
                code: actor.code - 7,
                label: `Stored-${actor.name}`,
              },
            ],
            rowCount: 1,
          },
        ],
      },
    });
    const rejected =
      actor.fault === "consumer-rejected" ||
      actor.fault === "consumer-rejected-after-commit";
    const malformed = actor.fault === "consumer-malformed";
    replies.push({
      name: `${actor.name}:consumer`,
      via: "batch",
      committed: actor.fault !== "consumer-rejected",
      ...(rejected || malformed ? { injected: true as const } : {}),
      statements: [
        {
          action: "SELECT",
          parameters:
            candidate === "legacy"
              ? [actor.accountId]
              : [actor.accountId, actor.accountId, 1],
        },
        ...(candidate === "legacy"
          ? [
              {
                action: "INSERT" as const,
                parameters: [actor.tokenId, actor.code - 7],
              },
              {
                action: "UPDATE" as const,
                parameters: [actor.finalAccountId, actor.code, actor.accountId],
              },
            ]
          : [
              {
                action: "UPDATE" as const,
                parameters: [actor.finalAccountId, actor.code, actor.accountId],
              },
              {
                action: "INSERT" as const,
                parameters: [actor.tokenId, actor.code],
              },
            ]),
        { action: "SELECT", parameters: [actor.finalAccountId] },
      ],
      outcome: rejected
        ? {
            kind: "failure",
            code: "57014",
            message: `${actor.name}: consumer rejected`,
          }
        : {
            kind: "rows",
            responses: [
              { rows: [{ __viborm_assert__: 1 }], rowCount: 1 },
              { rows: [], rowCount: 1 },
              { rows: [], rowCount: 1 },
              {
                rows: [
                  {
                    id: actor.finalAccountId,
                    code: malformed ? "not-an-integer" : actor.code,
                  },
                ],
                rowCount: 1,
              },
            ],
          },
    });
    return { name: actor.name, firstParameter: actor.accountId, replies };
  }
  const found = mode === "coc-found";
  if (mode !== "create")
    replies.push({
      name: `${actor.name}:lookup`,
      via: "execute",
      committed: false,
      statements: [{ action: "SELECT", parameters: [actor.accountId, 1] }],
      outcome: {
        kind: "rows",
        responses: [
          {
            rows: found
              ? [
                  {
                    id: actor.accountId,
                    code: actor.code,
                    label: `Stored-${actor.name}`,
                  },
                ]
              : [],
            rowCount: found ? 1 : 0,
          },
        ],
      },
    });
  if (!found) {
    const rejected =
      actor.fault === "producer-rejected" ||
      actor.fault === "producer-rejected-after-commit";
    const empty = actor.fault === "producer-empty";
    replies.push({
      name: `${actor.name}:producer`,
      via: "batch",
      statements: [
        {
          action: "INSERT",
          parameters: [actor.accountId, actor.admittedLabel],
        },
      ],
      committed: actor.fault !== "producer-rejected",
      ...(rejected || empty ? { injected: true as const } : {}),
      outcome: rejected
        ? {
            kind: "failure",
            code: "57014",
            message: `${actor.name}: producer rejected`,
          }
        : {
            kind: "rows",
            responses: [
              {
                rows: empty ? [] : [{ id: actor.accountId, code: actor.code }],
                rowCount: empty ? 0 : 1,
              },
            ],
          },
    });
    if (rejected || empty)
      return { name: actor.name, firstParameter: actor.accountId, replies };
  }
  const rejected =
    actor.fault === "consumer-rejected" ||
    actor.fault === "consumer-rejected-after-commit";
  const malformed = actor.fault === "consumer-malformed";
  const publicRow =
    mode === "create"
      ? { id: actor.accountId, code: malformed ? "not-an-integer" : actor.code }
      : {
          id: actor.tokenId,
          accountCode: malformed ? "not-an-integer" : actor.code,
        };
  replies.push({
    name: `${actor.name}:consumer`,
    via: "batch",
    statements: [
      {
        action: "SELECT",
        // A found supplier retains its captured identity; a produced supplier
        // proves its acknowledged row and non-primary generated output.
        parameters: found
          ? [actor.accountId, actor.accountId]
          : [actor.accountId, actor.code],
      },
      { action: "INSERT", parameters: [actor.tokenId, actor.code] },
      {
        action: "SELECT",
        parameters: [mode === "create" ? actor.accountId : actor.tokenId],
      },
    ],
    committed: actor.fault !== "consumer-rejected",
    ...(rejected || malformed ? { injected: true as const } : {}),
    outcome: rejected
      ? {
          kind: "failure",
          code: "57014",
          message: `${actor.name}: consumer rejected`,
        }
      : {
          kind: "rows",
          responses: [
            { rows: [{ __viborm_assert__: 1 }], rowCount: 1 },
            { rows: [], rowCount: 1 },
            { rows: [publicRow], rowCount: 1 },
          ],
        },
  });
  return { name: actor.name, firstParameter: actor.accountId, replies };
}

function assertActorOutcome(
  actor: PublicActor,
  outcome: OperationOutcome,
  profile: TransportProfileId,
  correlationId: string | undefined,
  candidate: "commands" | "legacy"
) {
  if (actor.fault === "none") {
    assert.deepEqual(outcome, {
      kind: "success",
      value:
        actor.model === "account"
          ? { id: actor.finalAccountId, code: actor.code }
          : { id: actor.tokenId, accountCode: actor.code },
    });
    return;
  }
  assert.equal(
    outcome.kind,
    "failure",
    `${actor.name}: terminal fault must not publish success`
  );
  if (outcome.kind !== "failure") return;
  const malformed =
    actor.fault === "producer-empty" || actor.fault === "consumer-malformed";
  const ordinary = actor.operation === "update";
  const preciseMalformed =
    malformed &&
    (ordinary ||
      (candidate === "commands" && actor.fault === "consumer-malformed"));
  assert.equal(
    outcome.failure.name,
    malformed ? "QueryEngineError" : "QueryError"
  );
  assert.equal(outcome.failure.code, malformed ? "V9001" : "V2001");
  assert.equal(
    outcome.failure.message,
    malformed
      ? preciseMalformed
        ? `Driver "${profile}" returned a malformed int scalar for operation "${actor.operation}": the value is not a canonical integer.`
        : "Record-series execution failed at a committed-segment boundary."
      : "Query execution failed"
  );
  const ack = profile === "scripted-returning-ack";
  const producer = actor.fault.startsWith("producer-");
  const afterCommit = actor.fault.endsWith("after-commit");
  const precedingSegments = actor.operation === "create" && !producer ? 1 : 0;
  const segments = malformed
    ? precedingSegments + 1
    : precedingSegments + (ack && afterCommit ? 1 : 0);
  const uncertain = !(ack || malformed);
  const meta = z.record(z.string(), z.unknown()).parse(outcome.failure.meta);
  if (preciseMalformed) {
    assert.equal(meta.driver, profile);
    assert.equal(meta.operation, actor.operation);
    assert.equal(meta.scalarType, "int");
  }
  if (!malformed) {
    // One producer statement identifies account; an opaque consumer batch identifies its root.
    assert.equal(
      meta.model,
      producer ? "account" : actor.model,
      `${actor.name}: failure model attribution`
    );
    assert.equal(
      meta.operation,
      actor.operation,
      `${actor.name}: failure operation attribution`
    );
    assert.equal(
      meta.correlationId,
      correlationId,
      `${actor.name}: failure operation identity`
    );
    assert.deepEqual(
      outcome.failure.cause,
      {
        name: "Error",
        message: "Underlying error details redacted",
        code: "57014",
      },
      `${actor.name}: redacted provider cause`
    );
  }
  if (ordinary) {
    const progress =
      candidate === "commands" &&
      (actor.fault === "consumer-malformed" || (ack && afterCommit))
        ? {
            atomicity: "segment",
            phase: actor.fault === "consumer-malformed" ? "result" : "member",
            committedSegments: 1,
            completedMembers: 0,
            committedWriteMembers: 1,
          }
        : undefined;
    assert.deepEqual(
      meta.recordSeriesProgress,
      progress,
      candidate === "commands"
        ? "Commands ordinary UPDATE must retain only acknowledged progress"
        : "Legacy ordinary UPDATE retains its prior no-progress contract"
    );
    if (malformed) {
      const { recordSeriesProgress: _recordSeriesProgress, ...scalarMeta } =
        meta;
      assert.deepEqual(scalarMeta, {
        driver: profile,
        operation: "update",
        scalarType: "int",
      });
    }
    return;
  }
  if (segments === 0 && !uncertain) {
    assert.equal(
      meta.recordSeriesProgress,
      undefined,
      "An unacknowledged rejection must not invent committed progress"
    );
    return;
  }
  assert.deepEqual(
    meta.recordSeriesProgress,
    {
      atomicity: "segment",
      phase: malformed || (ack && afterCommit) ? "result" : "member",
      committedSegments: segments,
      completedMembers: 0,
      committedWriteMembers: segments > 0 ? 1 : 0,
      ...(uncertain ? { mayHaveCommittedSegment: true } : {}),
    },
    `${actor.name}: durable and uncertain progress must remain distinct`
  );
}

export async function runTransportWorld(
  input: TransportRecipe,
  profile: TransportProfileId,
  options: {
    replay?: ReplayTape;
    specimen?: "wrong-publication" | "lost-progress" | "wrong-attribution";
    candidateFactory?: CandidateEngineFactory;
    candidateName?: "commands" | "legacy";
  } = {}
) {
  const recipe = recipeSchema.parse(input);
  const candidate = options.candidateName ?? "commands";
  const scenarioId =
    recipe.mode === "key-update" ? "g2-transport" : "g1-transport";
  const recorder = new Recorder(
    recipe.seed,
    options.replay,
    recordingEventLimit(scenarioId)
  );
  const defaults: DefaultObservation[] = [];
  let admissions = 0;
  const account = s
    .model({
      id: s.string().id(),
      code: s.int().increment().unique(),
      label: s.string().default(() => {
        const observation = {
          name: "account.label",
          value: `admitted-${++admissions}`,
        };
        defaults.push(observation);
        recorder.record({ kind: "default", observation });
        return observation.value;
      }),
      tokens: s.toMany(() => token),
    })
    .map("g1_transport_accounts");
  const accountReference = s
    .toOne(() => account)
    .fields("accountCode")
    .references("code");
  const token = s
    .model({
      id: s.string().id(),
      accountCode: s.int(),
      account:
        recipe.mode === "key-update"
          ? accountReference.onUpdate("cascade")
          : accountReference,
    })
    .map("g1_transport_tokens");
  const actorFaults = faultsForRecipe(recipe);
  const actors: PublicActor[] = actorFaults.map((fault, index) => {
    const name = `actor-${index + 1}`;
    const accountId = `account-${recipe.seed}-${index + 1}`;
    const finalAccountId =
      recipe.mode === "key-update" ? `${accountId}-moved` : accountId;
    const tokenId = `token-${recipe.seed}-${index + 1}`;
    const code =
      101 * (index + 1) + (recipe.mode === "key-update" ? recipe.seed % 97 : 0);
    let args: unknown;
    if (recipe.mode === "key-update")
      args = {
        where: { id: accountId },
        data: { id: finalAccountId, code, tokens: { create: { id: tokenId } } },
        select: { id: true, code: true },
      };
    else if (recipe.mode === "create")
      args = {
        data: { id: accountId, tokens: { create: { id: tokenId } } },
        select: { id: true, code: true },
      };
    else
      args = {
        data: {
          id: tokenId,
          account: {
            connectOrCreate: {
              where: { id: accountId },
              create:
                recipe.mode === "coc-found"
                  ? { id: `unused-${accountId}`, code: -999 }
                  : { id: accountId },
            },
          },
        },
        select: { id: true, accountCode: true },
      };
    return {
      name,
      accountId,
      finalAccountId,
      tokenId,
      model:
        recipe.mode === "create" || recipe.mode === "key-update"
          ? "account"
          : "token",
      operation: recipe.mode === "key-update" ? "update" : "create",
      code,
      admittedLabel: `admitted-${index + 1}`,
      fault,
      args,
    };
  });
  const scripts = actors.map((actor) =>
    actorScript(actor, recipe.mode, candidate)
  );
  const driver = new ScriptedTransport(
    scripts,
    recorder,
    profile,
    options.specimen
  );
  let executions = 0;
  const outcomes: OperationOutcome[] = [];
  await recorder.control(async () => {
    const config = {
      schema: { account, token },
      driver,
    };
    const client =
      options.candidateName === "legacy" ? createClient(config) : undefined;
    const engine = client
      ? {
          async execute(model: string, operation: string, args: unknown) {
            const modelClient = Reflect.get(client, model);
            return await Reflect.apply(
              Reflect.get(modelClient, operation),
              modelClient,
              [args]
            );
          },
        }
      : (options.candidateFactory ?? createCommandEngine)(config);
    const execute = async (actor: PublicActor): Promise<OperationOutcome> => {
      executions++;
      try {
        return {
          kind: "success",
          value: await engine.execute(actor.model, actor.operation, actor.args),
        };
      } catch (failure) {
        return { kind: "failure", failure: observeFailure(failure) };
      }
    };
    try {
      if (recipe.multiFault) {
        for (const [index, actor] of actors.entries())
          outcomes.push(await driver.drain(execute(actor), index + 1));
      } else {
        // Each execute starts before drain can release either actor's first reply.
        const initialWork = actors.slice(0, recipe.actors).map(execute);
        outcomes.push(
          ...(await driver.drain(Promise.all(initialWork), recipe.actors))
        );
        if (actors.length > recipe.actors)
          outcomes.push(
            await driver.drain(execute(actors[recipe.actors]!), actors.length)
          );
      }
      driver.finish();
    } finally {
      await driver.disconnect();
    }
  });
  const tape = recorder.finish();
  if (options.specimen === "lost-progress") {
    let changed = false;
    for (const outcome of outcomes) {
      if (outcome.kind !== "failure") continue;
      const meta = z
        .record(z.string(), z.unknown())
        .parse(outcome.failure.meta);
      if (meta.recordSeriesProgress === undefined) continue;
      delete meta.recordSeriesProgress;
      outcome.failure.meta = meta;
      changed = true;
    }
    assert(
      changed,
      "Lost-progress specimen requires an observed progress-bearing failure"
    );
  }
  if (options.specimen === "wrong-attribution") {
    const failed = outcomes.find((outcome) => outcome.kind === "failure");
    assert(
      failed?.kind === "failure",
      "Wrong-attribution specimen requires an observed failure"
    );
    const meta = z.record(z.string(), z.unknown()).parse(failed.failure.meta);
    meta.operation = "create";
    failed.failure.meta = meta;
  }
  const observation: RunObservation = {
    outcome: outcomes[0]!,
    ...(outcomes.length > 1 ? { subsequentOutcomes: outcomes.slice(1) } : {}),
    initial: {},
    final: { transport: driver.dispatched },
    defaults,
    reachedCuts: [],
  };
  const record: TransportReplayRecord = {
    scenarioId,
    ...(options.candidateName === "legacy"
      ? {}
      : { candidate: "commands" as const }),
    profile,
    seed: recipe.seed,
    transportVersion: "explicit-replies-v1",
    ...(options.specimen ? { specimen: options.specimen } : {}),
    publicInput: {
      recipe,
      requests: actors.map(({ name, model, operation, args }) => ({
        actor: name,
        model,
        operation,
        args,
      })),
    },
    schema: [
      {
        model: "account",
        table: "g1_transport_accounts",
        fields: {
          id: "string primary key",
          code: "generated integer unique",
          label: "per-admission string default",
        },
      },
      {
        model: "token",
        table: "g1_transport_tokens",
        fields: {
          id: "string primary key",
          accountCode:
            recipe.mode === "key-update"
              ? "integer reference to account.code ON UPDATE CASCADE"
              : "integer reference to account.code",
        },
      },
    ],
    observation,
    tape,
    statements: driver.statements,
  };
  return {
    record,
    observation,
    statements: driver.statements,
    fixture: {
      assert(observed: RunObservation) {
        assert.equal(executions, actors.length);
        assert.deepEqual(observed.initial, {});
        assert.deepEqual(observed.reachedCuts, []);
        assert.deepEqual(
          observed.defaults,
          actors
            .filter((actor) => actor.operation === "create")
            .map((actor) => ({
              name: "account.label",
              value: actor.admittedLabel,
            }))
        );
        const dispatched = z
          .array(
            z
              .object({
                actor: z.string(),
                request: z.string(),
                parameters: z.array(z.array(z.unknown())),
              })
              .strict()
          )
          .parse(observed.final.transport);
        assert.deepEqual(Object.keys(observed.final), ["transport"]);
        assert.equal(
          dispatched.length,
          scripts.reduce((sum, script) => sum + script.replies.length, 0)
        );
        for (const script of scripts)
          assert.deepEqual(
            dispatched.filter((request) => request.actor === script.name),
            script.replies.map((reply) => ({
              actor: script.name,
              request: reply.name,
              parameters: reply.statements.map(
                (statement) => statement.parameters
              ),
            })),
            `${script.name}: exact-publication-parameters`
          );
        const observedOutcomes = [
          observed.outcome,
          ...(observed.subsequentOutcomes ?? []),
        ];
        assert.equal(observedOutcomes.length, actors.length);
        actors.forEach((actor, index) =>
          assertActorOutcome(
            actor,
            observedOutcomes[index]!,
            profile,
            tape.events.flatMap((event) =>
              event.kind === "transport" &&
              event.actor === actor.name &&
              event.phase === "queued"
                ? [event.correlationId]
                : []
            )[0],
            candidate
          )
        );
        assert.deepEqual(
          tape.events.flatMap((event) =>
            event.kind === "injected-failure" ? [event.cut] : []
          ),
          scripts.flatMap((script) =>
            script.replies
              .filter((reply) => reply.injected)
              .map((reply) => reply.name)
          ),
          "Every declared fault must be released and recorded"
        );
        for (const script of scripts)
          for (const reply of script.replies) {
            const phases = tape.events.flatMap((event) =>
              event.kind === "transport" &&
              event.actor === script.name &&
              event.request === reply.name
                ? [event.phase]
                : []
            );
            assert.deepEqual(phases, [
              "queued",
              ...(reply.committed
                ? [
                    "committed",
                    ...(profile === "scripted-returning-ack" &&
                    reply.via === "batch" &&
                    options.candidateName !== "legacy"
                      ? ["acknowledged"]
                      : []),
                  ]
                : []),
              reply.outcome.kind === "rows" ? "returned" : "rejected",
            ]);
          }
        if (recipe.actors === 2) {
          const firstRelease = tape.events.findIndex(
            (event) => event.kind === "release"
          );
          assert(firstRelease >= 0);
          const queued = tape.events
            .slice(0, firstRelease)
            .filter(
              (event) => event.kind === "transport" && event.phase === "queued"
            );
          assert.equal(
            queued.length,
            2,
            "Both actors must be physically queued before the first completion is released"
          );
        }
      },
    },
  };
}

type TransportWorld = Awaited<ReturnType<typeof runTransportWorld>>;

function normalizedTransportBaseline(
  baseline: TransportWorld,
  candidate: TransportWorld
): RunObservation {
  assert.equal(baseline.record.candidate, undefined);
  assert.equal(candidate.record.candidate, "commands");
  assert.equal(baseline.record.profile, candidate.record.profile);
  assert.deepEqual(baseline.record.publicInput, candidate.record.publicInput);
  const recipe = transportRecipeFromPublicInput(baseline.record.publicInput);
  const actorFaults = faultsForRecipe(recipe);
  const baselineOutcomes = [
    baseline.observation.outcome,
    ...(baseline.observation.subsequentOutcomes ?? []),
  ];
  const candidateOutcomes = [
    candidate.observation.outcome,
    ...(candidate.observation.subsequentOutcomes ?? []),
  ];
  assert.equal(baselineOutcomes.length, actorFaults.length);
  assert.equal(candidateOutcomes.length, actorFaults.length);
  const outcomes = baselineOutcomes.map((outcome, index) => {
    const fault = actorFaults[index];
    const approvedMalformed =
      recipe.mode === "key-update" && fault === "consumer-malformed";
    const approvedAcknowledgedRejection =
      recipe.mode === "key-update" &&
      baseline.record.profile === "scripted-returning-ack" &&
      fault === "consumer-rejected-after-commit";
    if (!(approvedMalformed || approvedAcknowledgedRejection)) return outcome;
    const candidateOutcome = candidateOutcomes[index]!;
    assert.equal(outcome.kind, "failure");
    assert.equal(candidateOutcome.kind, "failure");
    const baselineMeta = z
      .record(z.string(), z.unknown())
      .parse(outcome.failure.meta);
    const candidateMeta = z
      .record(z.string(), z.unknown())
      .parse(candidateOutcome.failure.meta);
    assert(Object.hasOwn(candidateMeta, "recordSeriesProgress"));
    return {
      ...outcome,
      failure: {
        ...outcome.failure,
        meta: Object.assign(
          Object.create(Object.getPrototypeOf(outcome.failure.meta)),
          baselineMeta,
          { recordSeriesProgress: candidateMeta.recordSeriesProgress }
        ),
      },
    };
  });
  return {
    ...baseline.observation,
    outcome: outcomes[0]!,
    ...(outcomes.length > 1 ? { subsequentOutcomes: outcomes.slice(1) } : {}),
  };
}

/** Exact engine oracles run before the two approved diagnostic deltas. */
export function verifyTransportPair(
  baseline: TransportWorld,
  candidate: TransportWorld
): void {
  baseline.fixture.assert(baseline.observation);
  candidate.fixture.assert(candidate.observation);
  assertEquivalentRunObservations(
    "g2-transport",
    { ...normalizedTransportBaseline(baseline, candidate), final: {} },
    { ...candidate.observation, final: {} }
  );
}
