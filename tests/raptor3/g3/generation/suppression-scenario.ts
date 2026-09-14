import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import { overrideTransactionOperation } from "@tests/fixtures/transaction-operation";
import type {
  CandidateEngineFactory,
  OperationOutcome,
  ScenarioDefinition,
} from "../../harness/protocol";
import { observeFailure } from "../../harness/sqlite-world";
import type { G3GeneratedRecipe } from "./recipe";

type SuppressionRecipe = Extract<G3GeneratedRecipe, { contract: "C09" }>;
type Candidate = ReturnType<CandidateEngineFactory>;

function settledOutcome(
  settled: PromiseSettledResult<unknown>
): OperationOutcome {
  return settled.status === "fulfilled"
    ? { kind: "success", value: settled.value }
    : { kind: "failure", failure: observeFailure(settled.reason) };
}

function transactionArray(
  client: object,
  operations: readonly unknown[]
): Promise<unknown[]> {
  const transaction = Reflect.get(client, "$transaction");
  assert.equal(typeof transaction, "function");
  return Reflect.apply(transaction, client, [operations]);
}

function postId(recipe: SuppressionRecipe, offset: number) {
  return recipe.seed * 1000 + offset;
}

/** C09 varies public scope semantics by admitted transport capability. */
export function generatedSuppressionScenario(
  recipe: SuppressionRecipe
): ScenarioDefinition {
  return {
    id: "g3-generated-suppression-retry",
    family: "C09",
    contracts: ["C09", "C10", "C13"],
    sources: ["tests/raptor3/g3/suppression-retry-contract.test.ts"],
    prepare(controls) {
      const author = s
        .model({
          id: s.int().id(),
          name: s.string().unique(),
          posts: s.toMany(() => post),
        })
        .map("g3_generated_scope_authors");
      const post = s
        .model({
          id: s.int().id(),
          title: s.string(),
          authorId: s.int(),
          author: s
            .toOne(() => author)
            .fields("authorId")
            .references("id"),
          notes: s.toMany(() => note),
        })
        .map("g3_generated_scope_posts");
      const note = s
        .model({
          id: s.string().id(),
          slug: s.string().unique(),
          postId: s.int(),
          post: s
            .toOne(() => post)
            .fields("postId")
            .references("id"),
        })
        .map("g3_generated_scope_notes");
      const schema = { author, post, note };
      const existingPostId = postId(recipe, 0);
      const prefixId = postId(recipe, 1);
      const suffixId = postId(recipe, 2);
      const prefixAuthorId = postId(recipe, 1001);
      const ghostAuthorId = postId(recipe, 1002);
      const suffixAuthorId = postId(recipe, 1003);
      const isAtomicBatch = controls.profile === "sqlite-atomic-batch";
      const atomicDescendant =
        isAtomicBatch && recipe.conflict === "descendant";
      const primaryArgs =
        isAtomicBatch && recipe.conflict === "root"
          ? {
              data: [
                { id: prefixId, title: "prefix", authorId: 1 },
                { id: existingPostId, title: "duplicate-root", authorId: 1 },
                { id: suffixId, title: "series-suffix", authorId: 1 },
              ],
              skipDuplicates: true,
              select: { id: true, title: true },
            }
          : recipe.conflict === "root"
            ? {
                data: [
                  {
                    id: prefixId,
                    title: "prefix",
                    author: {
                      create: { id: prefixAuthorId, name: "prefix-author" },
                    },
                  },
                  {
                    id: existingPostId,
                    title: "duplicate-root",
                    author: {
                      create: { id: ghostAuthorId, name: "ghost-author" },
                    },
                  },
                  {
                    id: suffixId,
                    title: "series-suffix",
                    author: {
                      create: { id: suffixAuthorId, name: "suffix-author" },
                    },
                  },
                ],
                skipDuplicates: true,
                select: { id: true, title: true },
              }
            : {
                data: [
                  {
                    id: prefixId,
                    title: "prefix",
                    author: {
                      create: { id: prefixAuthorId, name: "prefix-author" },
                    },
                  },
                  {
                    id: suffixId,
                    title: "doomed",
                    author: {
                      create: { id: ghostAuthorId, name: "ghost-author" },
                    },
                    notes: {
                      create: { id: `doomed-${recipe.seed}`, slug: "taken" },
                    },
                  },
                ],
                skipDuplicates: true,
                select: { id: true, title: true },
              };
      const providerCut = "g3-generated-suppression-provider-completed";
      const overlapCut = "g3-generated-suppression-actors-overlapped";
      let starts = 0;
      let settlements = 0;
      const initial = {
        authors: [{ id: 1, name: "existing" }],
        posts: [{ id: existingPostId, title: "kept", authorId: 1 }],
        notes:
          recipe.conflict === "descendant"
            ? [{ id: "seed-note", slug: "taken", postId: existingPostId }]
            : [],
      };
      const primaryReachesProvider = !atomicDescendant;
      const primarySucceeds =
        recipe.conflict === "root" && recipe.fault === "none";
      const injectedFailureIndex =
        recipe.fault === "none" ? undefined : primaryReachesProvider ? 0 : 1;
      const successfulHealthy = (index: number) =>
        index > 0 && index !== injectedFailureIndex;
      const final = structuredClone(initial);
      if (primarySucceeds) {
        final.posts.push(
          {
            id: prefixId,
            title: "prefix",
            authorId: isAtomicBatch ? 1 : prefixAuthorId,
          },
          {
            id: suffixId,
            title: "series-suffix",
            authorId: isAtomicBatch ? 1 : suffixAuthorId,
          }
        );
        if (!isAtomicBatch)
          final.authors.push(
            { id: prefixAuthorId, name: "prefix-author" },
            { id: suffixAuthorId, name: "suffix-author" }
          );
      }
      for (let index = 1; index < recipe.operations; index++) {
        if (!successfulHealthy(index)) continue;
        final.posts.push({
          id: postId(recipe, 100 + index),
          title: `healthy-${index}`,
          authorId: 1,
        });
      }
      final.authors.sort((left, right) => left.id - right.id);
      final.posts.sort((left, right) => left.id - right.id);

      return {
        publicInput: { recipe },
        requiredCuts: [
          providerCut,
          ...(recipe.actors === 2 ? [overlapCut] : []),
        ],
        expectedExecutions: recipe.operations,
        seed(database) {
          database.exec(`
            CREATE TABLE g3_generated_scope_authors(
              id INTEGER PRIMARY KEY,
              name TEXT NOT NULL UNIQUE
            ) STRICT;
            CREATE TABLE g3_generated_scope_posts(
              id INTEGER PRIMARY KEY,
              title TEXT NOT NULL,
              authorId INTEGER NOT NULL REFERENCES g3_generated_scope_authors(id)
            ) STRICT;
            CREATE TABLE g3_generated_scope_notes(
              id TEXT PRIMARY KEY,
              slug TEXT NOT NULL UNIQUE,
              postId INTEGER NOT NULL REFERENCES g3_generated_scope_posts(id)
            ) STRICT;
          `);
          database
            .prepare("INSERT INTO g3_generated_scope_authors VALUES(?,?)")
            .run(1, "existing");
          database
            .prepare("INSERT INTO g3_generated_scope_posts VALUES(?,?,?)")
            .run(existingPostId, "kept", 1);
          if (recipe.conflict === "descendant")
            database
              .prepare("INSERT INTO g3_generated_scope_notes VALUES(?,?,?)")
              .run("seed-note", "taken", existingPostId);
        },
        async invoke(driver, candidateFactory) {
          assert(
            candidateFactory,
            "G3 generated worlds require the command engine"
          );
          const candidate = candidateFactory({ schema, driver });
          const client = atomicDescendant
            ? createClient({ schema, driver })
            : undefined;
          const executePrimary = () => {
            if (!atomicDescendant)
              return candidate.execute("post", "createMany", primaryArgs);
            assert(client, "g3-generated-suppression:array-client");
            const operation = overrideTransactionOperation(
              client.post.findMany(),
              {
                prepare: () => undefined,
                prepareBatch: () =>
                  candidate.prepareBatch("post", "createMany", primaryArgs),
              }
            );
            return transactionArray(client, [operation]);
          };
          const execute = (index: number) => {
            starts++;
            const pending =
              index === 0
                ? executePrimary()
                : candidate.execute("post", "createMany", {
                    data: [
                      {
                        id: postId(recipe, 100 + index),
                        title: `healthy-${index}`,
                        authorId: 1,
                      },
                    ],
                    select: { id: true },
                  });
            return pending.finally(() => settlements++);
          };
          const outcomes: PromiseSettledResult<unknown>[] = [];
          let next = 1;
          const primary = execute(0);
          if (recipe.actors === 2) {
            assert(
              recipe.operations >= 2,
              "g3-generated-suppression:actor-budget"
            );
            const peer = execute(1);
            assert.equal(starts, 2, "g3-generated-suppression:two-starts");
            assert.equal(
              settlements,
              0,
              "g3-generated-suppression:overlapping-lifetimes"
            );
            controls.recordCut(overlapCut);
            outcomes.push(...(await Promise.allSettled([primary, peer])));
            next = 2;
          } else {
            const [settled] = await Promise.allSettled([primary]);
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
        inspect(database) {
          return {
            authors: database
              .prepare(
                "SELECT id,name FROM g3_generated_scope_authors ORDER BY id"
              )
              .all(),
            posts: database
              .prepare(
                "SELECT id,title,authorId FROM g3_generated_scope_posts ORDER BY id"
              )
              .all(),
            notes: database
              .prepare(
                "SELECT id,slug,postId FROM g3_generated_scope_notes ORDER BY id"
              )
              .all(),
          };
        },
        afterStatement() {
          return providerCut;
        },
        assert(observation) {
          assert.deepEqual(
            observation.initial,
            initial,
            "g3-generated-suppression:initial-world"
          );
          assert.deepEqual(
            observation.final,
            final,
            "g3-generated-suppression:final-world"
          );
          assert.equal(observation.outcome.kind, "success");
          if (observation.outcome.kind !== "success") return;
          assert(Array.isArray(observation.outcome.value));
          assert.equal(observation.outcome.value.length, recipe.operations);
          for (const [index, outcome] of observation.outcome.value.entries()) {
            assert(
              outcome && typeof outcome === "object" && "kind" in outcome,
              "g3-generated-suppression:outcome"
            );
            const expectedFailure =
              index === injectedFailureIndex ||
              (index === 0 && recipe.conflict === "descendant");
            if (expectedFailure) {
              assert.equal(outcome.kind, "failure");
              assert("failure" in outcome);
              assert(
                outcome.failure &&
                  typeof outcome.failure === "object" &&
                  "name" in outcome.failure
              );
              const expectedName =
                index === injectedFailureIndex
                  ? "QueryError"
                  : atomicDescendant
                    ? "TransactionError"
                    : "UniqueConstraintError";
              assert.equal(outcome.failure.name, expectedName);
              continue;
            }
            assert.equal(outcome.kind, "success");
            assert("value" in outcome);
            if (index === 0)
              assert.deepEqual(outcome.value, [
                { id: prefixId, title: "prefix" },
                { id: suffixId, title: "series-suffix" },
              ]);
            else
              assert.deepEqual(outcome.value, [
                { id: postId(recipe, 100 + index) },
              ]);
          }
          assert.equal(
            final.authors.some(({ name }) => name === "ghost-author"),
            false
          );
          assert.equal(
            final.posts.some(({ title }) => title === "doomed"),
            false
          );
          assert(
            final.posts.some(({ title }) => title.startsWith("healthy-")),
            "g3-generated-suppression:healthy-suffix"
          );
        },
      };
    },
  };
}
