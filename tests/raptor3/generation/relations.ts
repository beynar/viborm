import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import { z } from "zod";
import type {
  ControlledFault,
  OperationOutcome,
  ScenarioDefinition,
} from "../harness/protocol";
import { observeFailure } from "../harness/sqlite-world";

const recipeSchema = z.strictObject({
  seed: z.number().int().min(1000).max(1999),
  verb: z.enum(["create", "connect", "connectOrCreate"]),
  members: z
    .array(
      z.strictObject({
        found: z.boolean(),
        label: z.number().int().min(0).max(999),
      })
    )
    .max(3),
  decoys: z.number().int().min(0).max(3),
  actors: z.union([z.literal(1), z.literal(2)]),
  fault: z.enum([
    "none",
    "before-dispatch",
    "after-root-write",
    "two-before-dispatch",
  ]),
});
export type GeneratedRecipe = z.infer<typeof recipeSchema>;

/** Handwritten world and public-operation choices are independent of either engine. */
export function generateRecipe(seed: number): GeneratedRecipe {
  let state = (seed ^ 0x243f6a88) >>> 0;
  const pick = (limit: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  };
  const verb = (["create", "connect", "connectOrCreate"] as const)[pick(3)]!;
  return {
    seed,
    verb,
    members: Array.from({ length: pick(4) }, () => ({
      found:
        verb === "connect" || (verb === "connectOrCreate" && pick(2) === 1),
      label: pick(1000),
    })),
    decoys: pick(4),
    actors: seed % 4 === 0 ? 2 : 1,
    fault:
      seed % 4 === 1
        ? // Conditional lookups may precede the root write. Only plain create has
          // the same first provider action in both engines; otherwise use the root cut.
          verb === "create" && pick(2)
          ? "before-dispatch"
          : "after-root-write"
        : "none",
  };
}

export function recipeFromPublicInput(input: unknown): GeneratedRecipe {
  return z.object({ recipe: recipeSchema }).parse(input).recipe;
}

export function generatedFault(
  recipe: GeneratedRecipe
): ControlledFault | undefined {
  if (recipe.fault === "none") return undefined;
  return recipe.fault === "after-root-write"
    ? { kind: "at-cut", cut: "generated-root-written" }
    : {
        kind: "before-dispatch",
        ...(recipe.fault === "two-before-dispatch" ? { times: 2 } : {}),
      };
}

function assertControlledFailure(outcome: OperationOutcome): void {
  assert.equal(outcome.kind, "failure", "generated:fault-admission");
  if (outcome.kind !== "failure") return;
  assert.equal(outcome.failure.name, "QueryError");
  assert.equal(outcome.failure.code, "V2001");
  assert.equal(outcome.failure.message, "Query execution failed");
  assert.deepEqual(outcome.failure.cause, {
    name: "Error",
    message: "Underlying error details redacted",
  });
}

export function generatedRelations(
  recipe: GeneratedRecipe,
  wrongParentSpecimen = false
): ScenarioDefinition {
  return {
    id: "g1-generated-relations",
    ...(wrongParentSpecimen ? { specimen: "wrong-parent-world" as const } : {}),
    family: "C02",
    contracts: ["C02", "C04", "C10", "C13"],
    sources: [
      "tests/contracts/engine/write/create-nested-upsert-behavior.ts",
      "tests/contracts/engine/write/upsert-family-behavior.ts",
    ],
    prepare() {
      const parent = s
        .model({
          id: s.int().id(),
          label: s.string(),
          children: s.toMany(() => child),
        })
        .map("g1_generated_owner");
      const child = s
        .model({
          id: s.int().id().increment(),
          code: s.string().unique(),
          label: s.string(),
          parentId: s.int(),
          parent: s
            .toOne(() => parent)
            .fields("parentId")
            .references("id"),
        })
        .map("g1_generated_member");
      const schema = { parent, child };
      const rootId = recipe.seed * 64;
      const foreignId = rootId + 50;
      const sequence = rootId + 500;
      const foreign = { id: foreignId, label: "foreign" };
      const initialParents = [
        foreign,
        ...Array.from({ length: recipe.decoys }, (_, index) => ({
          id: foreignId + index + 1,
          label: `parent-decoy-${index}`,
        })),
      ];
      const foundRows = recipe.members.flatMap((member, index) =>
        member.found
          ? [
              {
                id: rootId + 100 + index,
                code: `found-${index}`,
                label: `stored-${member.label}`,
                parentId: foreignId,
              },
            ]
          : []
      );
      const decoyRows = Array.from({ length: recipe.decoys }, (_, index) => ({
        id: rootId + 200 + index,
        code: `decoy-${index}`,
        label: `untouched-${index}`,
        parentId: foreignId,
      }));
      const initialChildren = [...foundRows, ...decoyRows];
      const createMembers = recipe.members.map((member, index) => ({
        // Multiple conditional targets require independently known identities.
        // Plain create retains generated IDs and exact sequence assertions.
        ...(recipe.verb === "connectOrCreate"
          ? { id: rootId + 300 + index }
          : {}),
        code: `created-${index}`,
        label: `value-${member.label}`,
      }));
      const selectors = recipe.members.map((member, index) =>
        recipe.verb === "connectOrCreate"
          ? { id: rootId + (member.found ? 100 : 300) + index }
          : { code: member.found ? `found-${index}` : `absent-${index}` }
      );
      const relation =
        recipe.verb === "create"
          ? { create: createMembers }
          : recipe.verb === "connect"
            ? { connect: selectors }
            : {
                connectOrCreate: selectors.map((where, index) => ({
                  where,
                  create: createMembers[index]!,
                })),
              };
      const select = {
        id: true,
        label: true,
        children: {
          orderBy: { id: "asc" },
          select: { id: true, code: true, label: true, parentId: true },
        },
      } as const;
      const primaryArgs = {
        data: {
          id: rootId,
          label: "requested",
          ...(recipe.members.length ? { children: relation } : {}),
        },
        select,
      };
      const followingArgs = [
        ...(recipe.actors === 2
          ? [{ data: { id: rootId + 1, label: "actor-b" }, select }]
          : []),
        ...(recipe.fault !== "none"
          ? [{ data: { id: rootId + 2, label: "healthy-suffix" }, select }]
          : []),
      ];
      const initial = {
        parents: initialParents,
        children: initialChildren,
        sequence: [{ name: "g1_generated_member", seq: sequence }],
      };
      let nextId = sequence;
      const requestedChildren = recipe.members.map((member, index) =>
        member.found
          ? {
              id: rootId + 100 + index,
              code: `found-${index}`,
              label: `stored-${member.label}`,
              parentId: rootId,
            }
          : {
              ...createMembers[index]!,
              id:
                recipe.verb === "connectOrCreate"
                  ? rootId + 300 + index
                  : ++nextId,
              parentId: rootId,
            }
      );
      requestedChildren.sort((left, right) => left.id - right.id);
      const primarySucceeded = recipe.fault === "none";
      const expectedFollowing = followingArgs.map((args, index) => {
        // The explicit two-fault witness fails both actors, then releases the suffix.
        if (recipe.fault === "two-before-dispatch" && index === 0)
          return { kind: "failure" as const };
        return {
          kind: "success" as const,
          value: { ...args.data, children: [] },
        };
      });
      const final = {
        parents: [
          ...(primarySucceeded ? [{ id: rootId, label: "requested" }] : []),
          ...followingArgs
            .filter((_, index) => expectedFollowing[index]!.kind === "success")
            .map((args) => args.data),
          ...initialParents,
        ],
        children: primarySucceeded
          ? [...requestedChildren, ...decoyRows].sort(
              (left, right) => left.id - right.id
            )
          : initialChildren,
        sequence: [
          {
            name: "g1_generated_member",
            seq: primarySucceeded ? nextId : sequence,
          },
        ],
      };
      const subsequentOutcomes: OperationOutcome[] = [];
      let cutReached = false;
      let specimenApplied = false;
      return {
        publicInput: {
          recipe,
          actors: [
            "a",
            ...(recipe.actors === 2 ? ["b"] : []),
            ...(recipe.fault !== "none" ? ["a"] : []),
          ],
          operations: [primaryArgs, ...followingArgs],
        },
        expectedExecutions: 1 + followingArgs.length,
        subsequentOutcomes,
        requiredCuts:
          recipe.fault === "before-dispatch" ||
          recipe.fault === "two-before-dispatch"
            ? []
            : ["generated-root-written"],
        seed(database) {
          database.exec(`
            CREATE TABLE g1_generated_owner (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
            CREATE TABLE g1_generated_member (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, label TEXT NOT NULL, parentId INTEGER NOT NULL REFERENCES g1_generated_owner(id));
          `);
          for (const row of initialParents)
            database
              .prepare("INSERT INTO g1_generated_owner VALUES (?,?)")
              .run(row.id, row.label);
          for (const row of initialChildren)
            database
              .prepare("INSERT INTO g1_generated_member VALUES (?,?,?,?)")
              .run(row.id, row.code, row.label, row.parentId);
          database
            .prepare("DELETE FROM sqlite_sequence WHERE name=?")
            .run("g1_generated_member");
          database
            .prepare("INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)")
            .run("g1_generated_member", sequence);
        },
        async invoke(driver, factory) {
          const candidate = factory?.({ schema, driver });
          const client = candidate
            ? undefined
            : createClient({ schema, driver });
          const execute = (args: typeof primaryArgs) =>
            candidate
              ? candidate.execute("parent", "create", args)
              : client!.parent.create(args);
          let primary: unknown;
          let failure: unknown;
          try {
            primary = await execute(primaryArgs);
          } catch (error) {
            failure = error;
          }
          for (const args of followingArgs) {
            try {
              subsequentOutcomes.push({
                kind: "success",
                value: await execute(args),
              });
            } catch (error) {
              subsequentOutcomes.push({
                kind: "failure",
                failure: observeFailure(error),
              });
            }
          }
          if (failure !== undefined) throw failure;
          return primary;
        },
        inspect(database) {
          return {
            parents: database
              .prepare("SELECT * FROM g1_generated_owner ORDER BY id")
              .all(),
            children: database
              .prepare("SELECT * FROM g1_generated_member ORDER BY id")
              .all(),
            sequence: database
              .prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name")
              .all(),
          };
        },
        afterStatement(database) {
          if (
            wrongParentSpecimen &&
            !specimenApplied &&
            database
              .prepare("SELECT 1 FROM g1_generated_member WHERE parentId=?")
              .get(rootId)
          ) {
            database
              .prepare(
                "UPDATE g1_generated_member SET parentId=? WHERE parentId=?"
              )
              .run(foreignId, rootId);
            specimenApplied = true;
          }
          if (
            !cutReached &&
            database
              .prepare("SELECT 1 FROM g1_generated_owner WHERE id=?")
              .get(rootId)
          ) {
            cutReached = true;
            return "generated-root-written";
          }
          return undefined;
        },
        assert(observation) {
          assert.deepEqual(
            observation.initial,
            initial,
            "generated:initial-world"
          );
          assert.deepEqual(
            observation.final.children,
            final.children,
            "generated:membership"
          );
          assert.deepEqual(
            observation.final,
            final,
            "generated:effects-and-sequences"
          );
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(
            observation.reachedCuts,
            cutReached ? ["generated-root-written"] : []
          );
          assert.equal(
            observation.subsequentOutcomes?.length,
            expectedFollowing.length,
            "generated:healthy-suffix-completion"
          );
          expectedFollowing.forEach((expected, index) => {
            const actual = observation.subsequentOutcomes![index]!;
            if (expected.kind === "success")
              assert.deepEqual(
                actual,
                expected,
                "generated:healthy-suffix-output"
              );
            else assertControlledFailure(actual);
          });
          if (primarySucceeded)
            assert.deepEqual(
              observation.outcome,
              {
                kind: "success",
                value: {
                  id: rootId,
                  label: "requested",
                  children: requestedChildren,
                },
              },
              "generated:public-result"
            );
          else assertControlledFailure(observation.outcome);
        },
      };
    },
  };
}

/** Reductions change only the independent recipe; the caller must retain the property. */
export async function shrinkRecipe(
  original: GeneratedRecipe,
  reproduces: (recipe: GeneratedRecipe) => Promise<boolean>
) {
  let current = structuredClone(original);
  let attempts = 0;
  for (;;) {
    const candidates: GeneratedRecipe[] = [
      ...(current.decoys ? [{ ...current, decoys: 0 }] : []),
      ...(current.actors === 2 ? [{ ...current, actors: 1 as const }] : []),
      ...(current.fault !== "none"
        ? [{ ...current, fault: "none" as const }]
        : []),
      ...current.members.map((_, index) => ({
        ...current,
        members: current.members.filter((__, position) => position !== index),
      })),
      ...current.members.flatMap((member, index) =>
        member.label
          ? [
              {
                ...current,
                members: current.members.map((value, position) =>
                  position === index ? { ...value, label: 0 } : value
                ),
              },
            ]
          : []
      ),
    ];
    let reduced = false;
    for (const candidate of candidates) {
      attempts++;
      assert(attempts <= 64, "Generated shrink budget exceeded");
      if (await reproduces(candidate)) {
        current = candidate;
        reduced = true;
        break;
      }
    }
    if (!reduced) return { original, reduced: current, attempts };
  }
}
