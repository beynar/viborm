import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type Database from "better-sqlite3";
import type { ScenarioDefinition } from "../harness/protocol";
import { G0_PROFILES, type ProfileId } from "../profiles";

const cases = [
  "g2-upsert-skip-replaced",
  "g2-upsert-skip-deleted",
  "g2-upsert-null-unknown",
  "g2-upsert-setwhere-skip",
  "g2-upsert-setwhere-match-replaced",
  "g2-upsert-conditions-match",
  "g2-upsert-conditions-missing-create",
] as const;

interface ConditionalUpsertScenario extends ScenarioDefinition {
  readonly profiles: readonly ProfileId[];
}

/** A conditional answer belongs to the same captured row as the unique lookup. */
export const conditionalUpsertScenarios: ConditionalUpsertScenario[] =
  cases.map((id) => {
    const unknown = id === "g2-upsert-null-unknown";
    const stableSkip = id === "g2-upsert-setwhere-skip";
    const conditionsMatch = id === "g2-upsert-conditions-match";
    const missingCreate = id === "g2-upsert-conditions-missing-create";
    const stale = !unknown && !stableSkip && !conditionsMatch && !missingCreate;
    return {
      id,
      profiles: stale ? ["sqlite-atomic-batch"] : G0_PROFILES,
      family: "C05",
      contracts: ["C05", "C02", "C13"],
      sources: [
        "tests/contracts/engine/write/staleness-injection-upsert-capture.test.ts",
        "tests/contracts/engine/write/staleness-injection-fixtures.ts",
        "tests/contracts/engine/write/upsert-family-behavior.ts",
        "src/validation/model/args/mutation.ts",
        "src/query-engine/write-engine/UpsertOperation.ts",
      ],
      prepare(controls) {
        if (stale)
          assert.equal(
            controls.profile,
            "sqlite-atomic-batch",
            "External staleness requires a completed planning transaction"
          );
        const deleted = id === "g2-upsert-skip-deleted";
        const matched = id === "g2-upsert-setwhere-match-replaced";
        const user = s
          .model({
            id: s.int().id(),
            email: s.string().unique(),
            count: s.int(),
            posts: s.toMany(() => post),
          })
          .map("g2_conditional_users");
        const post = s
          .model({
            id: s.int().id(),
            slug: s.string().unique(),
            title: s.string(),
            userId: s.int().nullable(),
            author: s
              .toOne(() => user)
              .fields("userId")
              .references("id"),
          })
          .map("g2_conditional_posts");
        const schema = { user, post };
        const email = missingCreate ? "absent" : "wanted";
        // Conditions restrict the located update arm, not a missing-row create.
        // upsert-family-behavior.ts pins the matching pair; UpsertOperation's
        // public arm contract pins absent unique identity -> create.
        const conditions = conditionsMatch
          ? { targetWhere: { count: 10 }, setWhere: { count: 10 } }
          : missingCreate
            ? { targetWhere: { count: 999 }, setWhere: { count: 999 } }
            : matched
              ? { setWhere: { count: 10 } }
              : stableSkip
                ? { targetWhere: { count: 10 }, setWhere: { count: 999 } }
                : { targetWhere: { count: 999 } };
        const userArgs = {
          where: { email },
          ...conditions,
          create: { id: 42, email, count: 0 },
          update: { count: 15 },
          select: { id: true, email: true, count: true },
        } as const;
        const postArgs = {
          where: { slug: "selected" },
          targetWhere: { userId: 1 },
          create: { id: 42, slug: "selected", title: "created", userId: null },
          update: { title: "updated" },
          select: { id: true, title: true, userId: true },
        } as const;
        const initial = {
          users: [
            { id: 1, email: "wanted", count: 10 },
            { id: 9, email: "foreign", count: 999 },
          ],
          posts: [
            ...(unknown
              ? [
                  {
                    id: 400,
                    slug: "selected",
                    title: "unchanged",
                    userId: null,
                  },
                  {
                    id: 401,
                    slug: "other-owned",
                    title: "untouched-owned",
                    userId: 1,
                  },
                ]
              : []),
            {
              id: 409,
              slug: "foreign-post",
              title: "untouched-foreign",
              userId: 9,
            },
          ],
        };
        const final = stale
          ? {
              users: [
                ...(!deleted
                  ? [
                      { id: 1, email: "moved", count: 10 },
                      { id: 2, email: "wanted", count: matched ? 10 : 999 },
                    ]
                  : []),
                initial.users[1]!,
              ],
              posts: initial.posts,
            }
          : conditionsMatch
            ? {
                users: [
                  { id: 1, email: "wanted", count: 15 },
                  initial.users[1]!,
                ],
                posts: initial.posts,
              }
            : missingCreate
              ? {
                  users: [
                    ...initial.users,
                    { id: 42, email: "absent", count: 0 },
                  ],
                  posts: initial.posts,
                }
              : initial;
        const inspect = (database: Database.Database) => ({
          users: database
            .prepare("SELECT * FROM g2_conditional_users ORDER BY id")
            .all(),
          posts: database
            .prepare("SELECT * FROM g2_conditional_posts ORDER BY id")
            .all(),
        });
        const cut = deleted
          ? "conditional-skip-captured-deleted"
          : matched
            ? "conditional-match-captured-replaced"
            : "conditional-skip-captured-replaced";
        const requiredCuts = stale ? [cut] : [];
        let selectedObserved = false;
        let conditionalObserved = false;
        let changed = false;
        const changeCapturedWorld = (database: Database.Database) => {
          if (
            !stale ||
            changed ||
            !selectedObserved ||
            !conditionalObserved ||
            database.inTransaction
          )
            return undefined;
          assert.deepEqual(
            inspect(database),
            initial,
            "The complete public decision must precede external work and ORM effects"
          );
          if (deleted) {
            const removal = database
              .prepare(
                "DELETE FROM g2_conditional_users WHERE id=1 AND email='wanted'"
              )
              .run();
            assert.equal(
              removal.changes,
              1,
              "External deletion must remove the captured row"
            );
          } else {
            const move = database
              .prepare(
                "UPDATE g2_conditional_users SET email='moved' WHERE id=1 AND email='wanted'"
              )
              .run();
            assert.equal(
              move.changes,
              1,
              "External reassignment must move the captured unique selector"
            );
            database
              .prepare(
                "INSERT INTO g2_conditional_users(id,email,count) VALUES(2,'wanted',?)"
              )
              .run(matched ? 10 : 999);
          }
          changed = true;
          assert.deepEqual(
            inspect(database),
            final,
            "The fixture must perform its exact external mutation"
          );
          return cut;
        };
        return {
          publicInput: {
            model: unknown ? "post" : "user",
            operation: "upsert",
            args: unknown ? postArgs : userArgs,
            ...(stale
              ? {
                  externalMutation: {
                    after:
                      "captured id 1 and the selected conditional answer, outside the planning transaction",
                    selected: { id: 1, email: "wanted" },
                    conditional: {
                      field: matched ? "setWhere" : "targetWhere",
                      count: matched ? 10 : 999,
                      matched,
                    },
                    effect: deleted
                      ? { delete: 1 }
                      : {
                          moveEmail: "moved",
                          insert: {
                            id: 2,
                            email: "wanted",
                            count: matched ? 10 : 999,
                          },
                        },
                  },
                }
              : {}),
          },
          requiredCuts,
          seed(database) {
            database.exec(`
            CREATE TABLE g2_conditional_users(id INTEGER PRIMARY KEY,email TEXT NOT NULL UNIQUE,count INTEGER NOT NULL);
            CREATE TABLE g2_conditional_posts(id INTEGER PRIMARY KEY,slug TEXT NOT NULL UNIQUE,title TEXT NOT NULL,userId INTEGER REFERENCES g2_conditional_users(id));
            INSERT INTO g2_conditional_users VALUES(1,'wanted',10),(9,'foreign',999);
            INSERT INTO g2_conditional_posts VALUES(409,'foreign-post','untouched-foreign',9);
          `);
            if (unknown)
              database.exec(
                "INSERT INTO g2_conditional_posts VALUES(400,'selected','unchanged',NULL),(401,'other-owned','untouched-owned',1);"
              );
          },
          async invoke(driver, candidateFactory) {
            if (candidateFactory)
              return candidateFactory({ schema, driver }).execute(
                unknown ? "post" : "user",
                "upsert",
                unknown ? postArgs : userArgs
              );
            const client = createClient({ schema, driver });
            return unknown
              ? client.post.upsert(postArgs)
              : client.user.upsert(userArgs);
          },
          inspect,
          afterStatement(database, completion) {
            if (conditionsMatch || missingCreate) return undefined;
            if (changed || !stale) {
              assert.deepEqual(
                inspect(database),
                changed ? final : initial,
                "Skipped or stale upsert must not change any row"
              );
              return undefined;
            }
            // These independent public values distinguish the unique lookup from
            // its conditional probe. Extra projected columns do not change the cut.
            const conditionalCount = matched ? 10 : 999;
            const selectedRows =
              completion.rows.length === 1 &&
              completion.rows.every(
                (row) =>
                  row !== null &&
                  typeof row === "object" &&
                  "id" in row &&
                  row.id === 1n
              );
            if (completion.parameters.includes("wanted")) {
              if (completion.parameters.includes(conditionalCount)) {
                if (matched ? selectedRows : completion.rows.length === 0)
                  conditionalObserved = true;
              } else if (selectedRows) {
                selectedObserved = true;
              }
            }
            return completion.transactionOpen
              ? undefined
              : changeCapturedWorld(database);
          },
          afterTransaction(database, phase) {
            // Independent planning reads may share a real native batch. Their
            // answers are captured inside it; fixture SQL waits for its commit.
            return phase === "commit"
              ? changeCapturedWorld(database)
              : undefined;
          },
          assert(observation) {
            assert.deepEqual(observation.initial, initial);
            assert.deepEqual(
              observation.final,
              final,
              JSON.stringify(observation.outcome)
            );
            assert.deepEqual(observation.defaults, []);
            assert.deepEqual(observation.reachedCuts, requiredCuts);
            if (!stale) {
              assert.deepEqual(observation.outcome, {
                kind: "success",
                value: unknown
                  ? { id: 400, title: "unchanged", userId: null }
                  : missingCreate
                    ? { id: 42, email: "absent", count: 0 }
                    : {
                        id: 1,
                        email: "wanted",
                        count: conditionsMatch ? 15 : 10,
                      },
              });
              return;
            }
            assert(
              selectedObserved && conditionalObserved && changed,
              "Both public observations and the actual external mutation are required"
            );
            assert.equal(observation.outcome.kind, "failure");
            if (observation.outcome.kind !== "failure") return;
            const failure = observation.outcome.failure;
            assert.equal(
              failure.name,
              matched ? "TransactionError" : "NotFoundError"
            );
            assert.equal(failure.code, matched ? "V5001" : "V6001");
            assert.equal(
              failure.message,
              matched
                ? "query-engine-v2 top-level upsert setWhere match premise changed before the atomic batch."
                : "No user record found for upsert"
            );
            assert(failure.meta !== null && typeof failure.meta === "object");
            assert.notEqual(
              "raceable" in failure.meta ? failure.meta.raceable : undefined,
              true,
              "Captured-row replacement or deletion must not permit a retry against another identity"
            );
          },
        };
      },
    };
  });
