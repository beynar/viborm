import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import v from "@validation/primitives/v";
import type Database from "better-sqlite3";
import { z } from "zod";
import type {
  ControlledFault,
  OperationOutcome,
  ScenarioDefinition,
} from "../harness/protocol";
import { observeFailure } from "../harness/sqlite-world";

export const TRANSITION_MODES = [
  "key-move",
  "key-rollback",
  "singular-supply-modify",
  "required-retain",
  "required-depart",
  "coc-set-distinct",
  "coc-set-same",
  "delete-create",
  "delete-update",
  "junction-transfer",
] as const;

const transitionRecipeSchema = z
  .strictObject({
    seed: z.number().int().min(2000).max(7099),
    mode: z.enum(TRANSITION_MODES),
    offset: z.number().int().min(0).max(999),
    value: z.number().int().min(0).max(999),
    delta: z.number().int().min(1).max(9),
    decoys: z.number().int().min(0).max(3),
    actors: z.union([z.literal(1), z.literal(2)]),
    following: z.number().int().min(0).max(15),
    fault: z.enum([
      "none",
      "before-dispatch",
      "after-key-write",
      "two-before-dispatch",
    ]),
  })
  .superRefine((recipe, context) => {
    const minimum = recipe.actors === 2 ? 1 : 0;
    if (
      recipe.following < minimum ||
      (recipe.fault !== "none" && recipe.following <= minimum)
    )
      context.addIssue({
        code: "custom",
        message:
          "Actors and fault recovery require their actual following calls",
      });
    if (recipe.fault !== "none" && recipe.mode !== "key-move")
      context.addIssue({
        code: "custom",
        message: "Injected fault recipes use the admitted key transition",
      });
    if (recipe.fault === "two-before-dispatch" && recipe.actors !== 2)
      context.addIssue({
        code: "custom",
        message: "The two-fault witness has two initial calls",
      });
  });
export type TransitionRecipe = z.infer<typeof transitionRecipeSchema>;

/** Choices and expected worlds come from public transition contracts, not programs. */
export function generateTransitionRecipe(seed: number): TransitionRecipe {
  assert(Number.isInteger(seed) && seed >= 2000 && seed < 7100);
  let state = (seed ^ 0x13198a2e) >>> 0;
  const pick = (limit: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  };
  const actors = seed % 4 === 0 ? 2 : 1;
  const fault =
    seed % 4 === 1 ? (pick(2) ? "before-dispatch" : "after-key-write") : "none";
  const minimum = (actors === 2 ? 1 : 0) + (fault !== "none" ? 1 : 0);
  let mode =
    fault === "none"
      ? TRANSITION_MODES[pick(TRANSITION_MODES.length)]!
      : ("key-move" as const);
  // An effect-free refusal can terminate before any provider completion. The
  // overlap quota instead uses admitted primaries with an actual response cut.
  if (actors === 2) {
    if (mode === "required-depart") mode = "required-retain";
    if (mode === "coc-set-same") mode = "coc-set-distinct";
    if (mode === "delete-update") mode = "delete-create";
  }
  return {
    seed,
    mode,
    offset: pick(1000),
    value: pick(1000),
    delta: 1 + pick(9),
    decoys: pick(4),
    actors,
    following: minimum + pick(16 - minimum),
    fault,
  };
}

export function transitionRecipeFromPublicInput(
  input: unknown
): TransitionRecipe {
  return z.object({ recipe: transitionRecipeSchema }).parse(input).recipe;
}

export function transitionFault(
  recipe: TransitionRecipe
): ControlledFault | undefined {
  if (recipe.fault === "none") return undefined;
  if (recipe.fault === "after-key-write")
    return { kind: "at-cut", cut: "transition-key-written" };
  return {
    kind: "before-dispatch",
    ...(recipe.fault === "two-before-dispatch" ? { times: 2 } : {}),
  };
}

function assertInjected(outcome: OperationOutcome) {
  assert.equal(outcome.kind, "failure", "transition:injected-terminal");
  if (outcome.kind !== "failure") return;
  assert.equal(outcome.failure.name, "QueryError");
  assert.equal(outcome.failure.code, "V2001");
  assert.equal(outcome.failure.message, "Query execution failed");
  assert.deepEqual(outcome.failure.cause, {
    name: "Error",
    message: "Underlying error details redacted",
  });
}

export function generatedTransitions(
  recipe: TransitionRecipe,
  wrongParentSpecimen = false
): ScenarioDefinition {
  return {
    id: "g2-generated-transitions",
    ...(wrongParentSpecimen ? { specimen: "wrong-parent-world" as const } : {}),
    family: "C05",
    contracts: ["C05", "C06", "C07", "C10", "C13"],
    sources: [
      "tests/contracts/engine/write/compiled-key-transition-behavior.ts",
      "tests/contracts/engine/write/vacate-then-supply-behavior.ts",
      "tests/contracts/engine/write/own-write-linearization-behavior.ts",
      "tests/contracts/engine/write/post-transition-adopt-behavior.ts",
      "tests/contracts/drivers/behaviors/polymorphic-collection-write-behavior.ts",
    ],
    prepare(controls) {
      const required =
        recipe.mode === "required-retain" || recipe.mode === "required-depart";
      const key = recipe.mode === "key-move" || recipe.mode === "key-rollback";
      const own =
        recipe.mode.startsWith("coc-") || recipe.mode.startsWith("delete-");
      const singular = recipe.mode === "singular-supply-modify";
      // N1 (D-51): a nested lookup whose answer an earlier write of the same
      // operation can change is an ordered observation taken after that write,
      // not DESIGN §6.2's mode-independent veto. Only the refusal the relation
      // body raises before it writes anything — the required set's departure —
      // still precedes every effect: `coc-set-same` executes (the expected
      // world below) and `delete-update` refuses behind the delete it observes.
      const refusedBeforeEffects = recipe.mode === "required-depart";
      const refusedAfterDelete = recipe.mode === "delete-update";
      const refused = refusedBeforeEffects || refusedAfterDelete;
      // One evaluation per admitted input (D-8), on every arm: since C-01 the
      // public client IS this engine, so the second admission the deleted
      // engine published for the other modes has no arm left.
      const primaryAdmissions = 1;
      const admissions: string[] = [];
      const owner = s
        .model({
          id: s.int().id(),
          label: s.string().schema(
            v.string({
              transform(value) {
                admissions.push(value);
                controls.recordDefault("owner.label.admission", value);
                return value;
              },
            })
          ),
          members: s.toMany(() => member),
          badge: s.toOne(() => badge),
          books: s.toMany({ book: () => book }).through({
            book: {
              table: "g2_generated_links",
              source: "holder",
              target: "entry",
            },
          }),
        })
        .map("g2_generated_owners");
      const member = s
        .model({
          id: s.int().id(),
          body: s.string(),
          ownerId: required ? s.int() : s.int().nullable(),
          owner: s
            .toOne(() => owner)
            .fields("ownerId")
            .references("id")
            .onUpdate("cascade"),
        })
        .map("g2_generated_members");
      const badge = s
        .model({
          id: s.int().id(),
          rank: s.int(),
          ownerId: s.int().nullable().unique(),
          owner: s
            .toOne(() => owner)
            .fields("ownerId")
            .references("id")
            .onUpdate("cascade"),
        })
        .map("g2_generated_badges");
      const book = s
        .model({
          region: s.string(),
          code: s.string(),
          title: s.string(),
          owner: s.toOne(() => owner),
        })
        .id(["region", "code"])
        .map("g2_generated_books");
      const schema = { owner, member, badge, book };
      const selectedId = recipe.seed * 1000 + recipe.offset;
      const foreignId = selectedId + 100;
      const decoyId = selectedId + 200;
      const movedId = selectedId + recipe.delta;
      const memberId = selectedId + 300;
      const newMemberId = selectedId + 301;
      const foreignMemberId = selectedId + 302;
      const newBadgeId = selectedId + 400;
      const region = `r-${recipe.offset}`;
      const code = `c-${recipe.value}`;
      const label = `value-${recipe.value}`;
      const initialMembers: {
        id: number;
        body: string;
        ownerId: number | null;
      }[] = [
        ...(required || own
          ? [{ id: memberId, body: "incumbent", ownerId: selectedId }]
          : []),
        ...(recipe.mode === "key-rollback"
          ? [{ id: newMemberId, body: "collision", ownerId: foreignId }]
          : []),
        { id: foreignMemberId, body: "untouched", ownerId: decoyId },
      ];
      const initialBadges: {
        id: number;
        rank: number;
        ownerId: number | null;
      }[] = [
        ...(singular
          ? [{ id: newBadgeId - 1, rank: 1, ownerId: selectedId }]
          : []),
        { id: newBadgeId + 1, rank: 9, ownerId: decoyId },
      ];
      const initial = {
        owners: [
          { id: selectedId, label: "selected" },
          { id: foreignId, label: "foreign" },
          { id: decoyId, label: "untouched" },
          ...Array.from({ length: recipe.decoys }, (_, index) => ({
            id: decoyId + index + 1,
            label: `decoy-${index}`,
          })),
        ],
        members: initialMembers,
        badges: initialBadges,
        books: [
          { region, code, title: "exact" },
          { region, code: `${code}-x`, title: "crossed-code" },
          { region: `${region}-x`, code, title: "crossed-region" },
        ],
        links: [
          { holder: foreignId, entry_1: region, entry_2: code },
          { holder: foreignId, entry_1: region, entry_2: `${code}-x` },
          { holder: decoyId, entry_1: `${region}-x`, entry_2: code },
        ],
      };
      const members =
        recipe.mode === "key-move" || recipe.mode === "key-rollback"
          ? { create: { id: newMemberId, body: label } }
          : required
            ? {
                set:
                  recipe.mode === "required-depart" ? [] : [{ id: memberId }],
              }
            : recipe.mode.startsWith("coc-")
              ? {
                  set: [
                    {
                      id:
                        recipe.mode === "coc-set-same" ? newMemberId : memberId,
                    },
                  ],
                  connectOrCreate: [
                    {
                      where: { id: newMemberId },
                      create: { id: newMemberId, body: label },
                    },
                  ],
                }
              : recipe.mode === "delete-create"
                ? {
                    create: [{ id: memberId, body: label }],
                    delete: [{ id: memberId }],
                  }
                : {
                    update: [
                      { where: { id: memberId }, data: { body: label } },
                    ],
                    delete: [{ id: memberId }],
                  };
      const args = {
        where: { id: selectedId },
        data: {
          label,
          ...(key ? { id: { increment: recipe.delta } } : {}),
          ...(key || required || own ? { members } : {}),
          ...(singular
            ? {
                badge: {
                  update: { rank: { increment: recipe.delta } },
                  create: { id: newBadgeId, rank: recipe.value },
                  disconnect: true,
                },
              }
            : {}),
          ...(recipe.mode === "junction-transfer"
            ? {
                books: {
                  connect: [
                    { type: "book", where: { region_code: { region, code } } },
                  ],
                },
              }
            : {}),
        },
        select: { id: true, label: true },
      };
      const followingArgs = Array.from(
        { length: recipe.following },
        (_, index) => ({
          data: {
            id: selectedId + 500 + index,
            label: `healthy-${index}-${recipe.value}`,
          },
          select: { id: true, label: true },
        })
      );
      const failedPrimary =
        refused || recipe.mode === "key-rollback" || recipe.fault !== "none";
      const expected = structuredClone(initial);
      // These are independent row transitions, not an evaluator for public mutation bags.
      if (!failedPrimary) {
        expected.owners[0] = { id: key ? movedId : selectedId, label };
        if (key)
          expected.members.unshift({
            id: newMemberId,
            body: label,
            ownerId: movedId,
          });
        if (recipe.mode === "coc-set-distinct")
          expected.members.splice(1, 0, {
            id: newMemberId,
            body: label,
            ownerId: null,
          });
        // N1 (D-51): this world pinned DESIGN §6.2's veto ("Nested operation
        // 'set' on relation 'members' depends on an earlier 'connectOrCreate'
        // target write in the same nested write. Split these operations into
        // separate queries."). `connectOrCreate` runs before `set` in the
        // relation body's canonical order, so the set's target lookup is an
        // ordered observation of the member the conditional just minted: the
        // set keeps that member, and the incumbent is the one it clears.
        if (recipe.mode === "coc-set-same") {
          expected.members[0] = {
            id: memberId,
            body: "incumbent",
            ownerId: null,
          };
          expected.members.splice(1, 0, {
            id: newMemberId,
            body: label,
            ownerId: selectedId,
          });
        }
        if (recipe.mode === "delete-create")
          expected.members[0] = {
            id: memberId,
            body: label,
            ownerId: selectedId,
          };
        if (singular) {
          expected.badges[0] = { id: newBadgeId - 1, rank: 1, ownerId: null };
          expected.badges.splice(1, 0, {
            id: newBadgeId,
            rank: recipe.value + recipe.delta,
            ownerId: selectedId,
          });
        }
        if (recipe.mode === "junction-transfer")
          expected.links[0] = {
            holder: selectedId,
            entry_1: region,
            entry_2: code,
          };
      }
      followingArgs.forEach((call, index) => {
        if (recipe.fault !== "two-before-dispatch" || index !== 0)
          expected.owners.push(call.data);
      });
      const subsequentOutcomes: OperationOutcome[] = [];
      const cuts: string[] = [];
      let starts = 0;
      let settlements = 0;
      let specimenApplied = false;
      let deletedTargetObserved = false;
      let suppliedMemberObserved = false;
      const inspect = (database: Database.Database) => ({
        owners: database
          .prepare("SELECT * FROM g2_generated_owners ORDER BY id")
          .all(),
        members: database
          .prepare("SELECT * FROM g2_generated_members ORDER BY id")
          .all(),
        badges: database
          .prepare("SELECT * FROM g2_generated_badges ORDER BY id")
          .all(),
        books: database
          .prepare("SELECT * FROM g2_generated_books ORDER BY region,code")
          .all(),
        links: database
          .prepare(
            "SELECT * FROM g2_generated_links ORDER BY holder,entry_1,entry_2"
          )
          .all(),
      });
      const overlapCut = "transition-actors-overlapped";
      const keyCut = "transition-key-written";
      const expectsKeyCut =
        recipe.mode === "key-move" &&
        recipe.fault !== "before-dispatch" &&
        recipe.fault !== "two-before-dispatch";
      return {
        publicInput: {
          recipe,
          actors: [
            "a",
            ...followingArgs.map((_, index) =>
              recipe.actors === 2 && index === 0 ? "b" : "a"
            ),
          ],
          operations: [
            { model: "owner", operation: "update", args },
            ...followingArgs.map((following) => ({
              model: "owner",
              operation: "create",
              args: following,
            })),
          ],
        },
        expectedExecutions: 1 + followingArgs.length,
        subsequentOutcomes,
        requiredCuts: [
          ...(recipe.actors === 2 && recipe.fault === "none"
            ? [overlapCut]
            : []),
          ...(expectsKeyCut ? [keyCut] : []),
        ],
        seed(database) {
          database.exec(`
            CREATE TABLE g2_generated_owners(id INTEGER PRIMARY KEY,label TEXT NOT NULL);
            CREATE TABLE g2_generated_members(id INTEGER PRIMARY KEY,body TEXT NOT NULL,ownerId INTEGER ${required ? "NOT NULL" : ""} REFERENCES g2_generated_owners(id) ON UPDATE CASCADE);
            CREATE TABLE g2_generated_badges(id INTEGER PRIMARY KEY,rank INTEGER NOT NULL,ownerId INTEGER UNIQUE REFERENCES g2_generated_owners(id) ON UPDATE CASCADE);
            CREATE TABLE g2_generated_books(region TEXT NOT NULL,code TEXT NOT NULL,title TEXT NOT NULL,PRIMARY KEY(region,code));
            CREATE TABLE g2_generated_links(holder INTEGER NOT NULL REFERENCES g2_generated_owners(id) ON UPDATE CASCADE ON DELETE CASCADE,entry_1 TEXT NOT NULL,entry_2 TEXT NOT NULL,PRIMARY KEY(holder,entry_1,entry_2),UNIQUE(entry_1,entry_2),FOREIGN KEY(entry_1,entry_2) REFERENCES g2_generated_books(region,code) ON UPDATE CASCADE ON DELETE CASCADE);
          `);
          for (const row of initial.owners)
            database
              .prepare("INSERT INTO g2_generated_owners VALUES(?,?)")
              .run(row.id, row.label);
          for (const row of initial.members)
            database
              .prepare("INSERT INTO g2_generated_members VALUES(?,?,?)")
              .run(row.id, row.body, row.ownerId);
          for (const row of initial.badges)
            database
              .prepare("INSERT INTO g2_generated_badges VALUES(?,?,?)")
              .run(row.id, row.rank, row.ownerId);
          for (const row of initial.books)
            database
              .prepare("INSERT INTO g2_generated_books VALUES(?,?,?)")
              .run(row.region, row.code, row.title);
          for (const row of initial.links)
            database
              .prepare("INSERT INTO g2_generated_links VALUES(?,?,?)")
              .run(row.holder, row.entry_1, row.entry_2);
          if (singular)
            database.exec(
              `CREATE TRIGGER g2_generated_supply BEFORE INSERT ON g2_generated_badges WHEN NEW.id=${newBadgeId} AND NEW.rank<>${recipe.value} BEGIN SELECT RAISE(ABORT,'supplier must precede modify'); END;`
            );
        },
        async invoke(driver, factory) {
          const engine = factory?.({ schema, driver });
          // This fixture-selected mutation union is not a DX assertion. Every legacy
          // operation still enters the public model method and its real validator.
          const client = engine
            ? undefined
            : (createClient({ schema, driver }).owner as unknown as {
                update(input: typeof args): Promise<unknown>;
                create(input: (typeof followingArgs)[number]): Promise<unknown>;
              });
          const first = async () => {
            starts++;
            try {
              return engine
                ? await engine.execute("owner", "update", args)
                : await client!.update(args);
            } finally {
              settlements++;
            }
          };
          const next = async (call: (typeof followingArgs)[number]) => {
            starts++;
            try {
              return engine
                ? await engine.execute("owner", "create", call)
                : await client!.create(call);
            } finally {
              settlements++;
            }
          };
          const firstPromise = first();
          let primary: PromiseSettledResult<unknown>;
          let remaining = followingArgs;
          if (recipe.actors === 2) {
            const secondPromise = next(followingArgs[0]!);
            assert.equal(starts, 2, "transition:two-public-starts");
            assert.equal(
              settlements,
              0,
              "transition:overlapping-public-lifetimes"
            );
            const outcomes = await Promise.allSettled([
              firstPromise,
              secondPromise,
            ]);
            primary = outcomes[0]!;
            const secondary = outcomes[1]!;
            subsequentOutcomes.push(
              secondary.status === "fulfilled"
                ? { kind: "success", value: secondary.value }
                : { kind: "failure", failure: observeFailure(secondary.reason) }
            );
            remaining = followingArgs.slice(1);
          } else primary = (await Promise.allSettled([firstPromise]))[0]!;
          for (const call of remaining) {
            try {
              subsequentOutcomes.push({
                kind: "success",
                value: await next(call),
              });
            } catch (failure) {
              subsequentOutcomes.push({
                kind: "failure",
                failure: observeFailure(failure),
              });
            }
          }
          if (primary.status === "rejected") throw primary.reason;
          return primary.value;
        },
        inspect,
        afterStatement(database, completion) {
          const reached: string[] = [];
          if (refusedBeforeEffects) {
            assert.deepEqual(
              database
                .prepare("SELECT * FROM g2_generated_owners WHERE id=?")
                .get(selectedId),
              initial.owners[0],
              "transition:refusal-before-root-effect"
            );
            assert.deepEqual(
              database
                .prepare("SELECT * FROM g2_generated_members ORDER BY id")
                .all(),
              initial.members,
              "transition:refusal-before-member-effect"
            );
          }
          // N1 (D-51): the supply precedes the set's clear, which the end
          // state alone cannot say — a set that ran FIRST, found nothing and
          // cleared every member would leave the same rows once the
          // conditional minted and linked its target. The boundary at which
          // the minted member is already this owner's while the incumbent
          // still is names the order the observation was taken in.
          if (recipe.mode === "coc-set-same") {
            const supplied = database
              .prepare(
                "SELECT 1 FROM g2_generated_members WHERE id=? AND ownerId=?"
              )
              .get(newMemberId, selectedId);
            const incumbent = database
              .prepare(
                "SELECT 1 FROM g2_generated_members WHERE id=? AND ownerId=?"
              )
              .get(memberId, selectedId);
            if (supplied !== undefined && incumbent !== undefined)
              suppliedMemberObserved = true;
          }
          // N1 (D-51): the root's own write runs before its member-held
          // children and `delete` before `update`, so this refusal no longer
          // precedes every effect — it follows them, and they roll back. What
          // holds at every boundary is that the refused update never lands
          // (the target is its seeded self or already gone), the selected key
          // never moves, and no other member row is touched.
          if (refusedAfterDelete) {
            assert.deepEqual(
              database
                .prepare("SELECT id FROM g2_generated_owners WHERE id=?")
                .get(selectedId),
              { id: selectedId },
              "transition:refusal-keeps-the-selected-key"
            );
            const target = database
              .prepare("SELECT * FROM g2_generated_members WHERE id=?")
              .get(memberId);
            if (target === undefined) deletedTargetObserved = true;
            else
              assert.deepEqual(
                target,
                initial.members[0],
                "transition:refused-update-never-lands"
              );
            assert.deepEqual(
              database
                .prepare(
                  "SELECT * FROM g2_generated_members WHERE id<>? ORDER BY id"
                )
                .all(memberId),
              initial.members.filter((row) => row.id !== memberId),
              "transition:refusal-leaves-the-other-members"
            );
          }
          if (
            wrongParentSpecimen &&
            !specimenApplied &&
            database
              .prepare(
                "SELECT 1 FROM g2_generated_members WHERE id=? AND ownerId=?"
              )
              .get(newMemberId, movedId)
          ) {
            database
              .prepare("UPDATE g2_generated_members SET ownerId=? WHERE id=?")
              .run(foreignId, newMemberId);
            specimenApplied = true;
          }
          if (
            recipe.actors === 2 &&
            recipe.fault === "none" &&
            !cuts.includes(overlapCut)
          ) {
            assert.equal(
              settlements,
              0,
              "transition:overlap-before-first-completion"
            );
            assert(
              admissions.includes(label) &&
                admissions.includes(followingArgs[0]!.data.label),
              "transition:both-inputs-admitted"
            );
            cuts.push(overlapCut);
            reached.push(overlapCut);
          }
          if (
            expectsKeyCut &&
            !cuts.includes(keyCut) &&
            database
              .prepare(
                "SELECT 1 FROM g2_generated_owners WHERE id=? AND label=?"
              )
              .get(movedId, label)
          ) {
            assert.equal(
              completion.transactionOpen,
              true,
              "transition:key-effect-inside-transaction"
            );
            cuts.push(keyCut);
            reached.push(keyCut);
          }
          return reached;
        },
        assert(observation) {
          if (wrongParentSpecimen)
            assert(specimenApplied, "transition:specimen-reached");
          assert.deepEqual(
            observation.initial,
            initial,
            "transition:initial-world"
          );
          assert.deepEqual(
            observation.final.members,
            expected.members,
            "transition:membership"
          );
          assert.deepEqual(
            observation.final,
            expected,
            "transition:whole-world"
          );
          assert.deepEqual(
            observation.defaults,
            [
              ...Array.from({ length: primaryAdmissions }, () => label),
              ...followingArgs.map((call) => call.data.label),
            ].map((value) => ({ name: "owner.label.admission", value })),
            "transition:admission-ledger"
          );
          assert.deepEqual(
            observation.reachedCuts,
            cuts,
            "transition:causal-cuts"
          );
          assert.equal(
            observation.subsequentOutcomes?.length,
            followingArgs.length,
            "transition:all-public-calls-terminal"
          );
          followingArgs.forEach((call, index) => {
            const actual = observation.subsequentOutcomes![index]!;
            if (recipe.fault === "two-before-dispatch" && index === 0)
              assertInjected(actual);
            else
              assert.deepEqual(
                actual,
                { kind: "success", value: call.data },
                "transition:healthy-suffix"
              );
          });
          if (recipe.fault !== "none") {
            assertInjected(observation.outcome);
            return;
          }
          if (!failedPrimary) {
            if (recipe.mode === "coc-set-same")
              assert.equal(
                suppliedMemberObserved,
                true,
                "transition:ordered-observation-behind-the-supply"
              );
            assert.deepEqual(
              observation.outcome,
              {
                kind: "success",
                value: { id: key ? movedId : selectedId, label },
              },
              "transition:public-result"
            );
            return;
          }
          if (refusedAfterDelete)
            assert.equal(
              deletedTargetObserved,
              true,
              "transition:ordered-observation-behind-the-delete"
            );
          assert.equal(observation.outcome.kind, "failure");
          if (observation.outcome.kind !== "failure") return;
          assert.equal(
            observation.outcome.failure.name,
            recipe.mode === "key-rollback"
              ? "UniqueConstraintError"
              : "NestedWriteError"
          );
          assert.equal(
            observation.outcome.failure.code,
            recipe.mode === "key-rollback" ? "V3001" : "V7001"
          );
          assert.equal(
            observation.outcome.failure.message,
            recipe.mode === "key-rollback"
              ? "Unique constraint violation"
              : recipe.mode === "required-depart"
                ? "Cannot set relation 'members' because foreign key field(s) ownerId are required: rows removed from the set cannot be disconnected. Delete them instead."
                : // N1 (D-51): this world pinned DESIGN §6.2's veto ("Nested
                  // operation 'update' on relation 'members' depends on an
                  // earlier 'delete' target write in the same nested write.
                  // Split these operations into separate queries."). `delete`
                  // runs before `update` in the relation body's canonical
                  // order, and the update's lookup is an ordered observation
                  // of what it left: the correlated not-found the relation
                  // body registers, with nothing of the operation committed.
                  "Cannot update relation 'members': target record was not found for this parent."
          );
        },
      };
    },
  };
}

export async function shrinkTransitionRecipe(
  original: TransitionRecipe,
  reproduces: (recipe: TransitionRecipe) => Promise<boolean>
) {
  let current = structuredClone(original);
  let attempts = 0;
  for (;;) {
    const minimumFollowing =
      (current.actors === 2 ? 1 : 0) + (current.fault !== "none" ? 1 : 0);
    const candidates: TransitionRecipe[] = [
      ...(current.decoys ? [{ ...current, decoys: 0 }] : []),
      ...(current.actors === 2 && current.fault !== "two-before-dispatch"
        ? [{ ...current, actors: 1 as const }]
        : []),
      ...(current.fault !== "none"
        ? [{ ...current, fault: "none" as const }]
        : []),
      ...(current.following > minimumFollowing
        ? [{ ...current, following: minimumFollowing }]
        : []),
      ...(current.value ? [{ ...current, value: 0 }] : []),
      ...(current.offset ? [{ ...current, offset: 0 }] : []),
      ...(current.delta > 1 ? [{ ...current, delta: 1 }] : []),
    ];
    let reduced = false;
    for (const candidate of candidates) {
      assert(++attempts <= 64, "Transition shrink budget exceeded");
      if (await reproduces(candidate)) {
        current = candidate;
        reduced = true;
        break;
      }
    }
    if (!reduced) return { original, reduced: current, attempts };
  }
}
