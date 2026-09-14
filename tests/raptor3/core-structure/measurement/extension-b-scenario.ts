import assert from "node:assert/strict";
import { s } from "@schema";
import { v } from "@validation";
import { isRecord } from "@validation/value-guards";
import type { ScenarioDefinition } from "../../harness/protocol";
import type { ExtensionBRecipe } from "./extension-recipes";

const whitespace = /\s+/;

function assertScheduledCut(
  schedule: readonly string[],
  cuts: readonly string[],
  earlier: string,
  later: string
): void {
  assert.equal(schedule.includes(`before:${earlier}<${later}`), true);
  const earlierIndex = cuts.indexOf(earlier);
  const laterIndex = cuts.indexOf(later);
  assert.notEqual(earlierIndex, -1);
  assert.notEqual(laterIndex, -1);
  assert.equal(earlierIndex < laterIndex, true);
}

function selectedCount(recipe: ExtensionBRecipe): number {
  return Number.isInteger(recipe.limit) && recipe.limit > 0
    ? Math.min(recipe.limit, recipe.rowCount)
    : 0;
}

export function extensionBScenario(
  recipe: ExtensionBRecipe
): ScenarioDefinition {
  return {
    id: "cs03-extension-b",
    family: "C08",
    contracts: ["C08", "C10", "C13"],
    sources: ["tests/raptor3/core-structure/extension-b.contract.test.ts"],
    prepare(controls) {
      const statements: string[] = [];
      const isRelation = recipe.mutation === "relation-updateMany";
      let child = 0;
      let admissionsAtFirstWrite: number | undefined;
      let operationAdmission = false;
      let relationCaptureObserved = false;
      const completedRelationMembers = new Set<string>();
      let scalarEffectObserved = false;
      const admitOperation = (input: string) => {
        if (!operationAdmission) {
          operationAdmission = true;
          controls.recordCut("admit:operation-template");
        }
        return input;
      };
      const shelf = s
        .model({
          id: s.string().id(),
          label: s.string(),
          children: s.toMany(() => childModel),
        })
        .map("cs03_b_shelves");
      const childModel = s
        .model({
          id: s
            .string()
            .id()
            .default(() => {
              const value = `child-${child++}`;
              controls.recordDefault("child.id", value);
              controls.recordCut(
                child === 1
                  ? "admit:operation-template"
                  : `admit:root-member/${child - 2}`
              );
              return value;
            }),
          shelfId: s.string(),
          label: s.string(),
          shelf: s
            .toOne(() => shelf)
            .fields("shelfId")
            .references("id"),
        })
        .map("cs03_b_children");
      const entry = s
        .model({
          id: s.int().id(),
          group: s.string().schema(v.string({ transform: admitOperation })),
          value: s.int(),
        })
        .map("cs03_b_entries");
      const operation = recipe.mutation.endsWith("deleteMany")
        ? "deleteMany"
        : "updateMany";
      const args = isRelation
        ? {
            where: {},
            data: {
              label: "capped",
              children: { create: { label: "created" } },
            },
            limit: recipe.limit,
          }
        : recipe.mutation === "scalar-deleteMany"
          ? { where: { group: "selected" }, limit: recipe.limit }
          : {
              where: { group: "selected" },
              data: { value: { set: 9 } },
              limit: recipe.limit,
            };
      const relationRows = Array.from(
        { length: recipe.rowCount },
        (_, index) => ({
          id: `s${index + 1}`,
          label: `shelf-${index + 1}`,
        })
      );
      const scalarRows = Array.from(
        { length: recipe.rowCount },
        (_, index) => ({
          id: index + 1,
          group: "selected",
          value: index + 1,
        })
      );
      const count = selectedCount(recipe);
      const isInvalid = !Number.isInteger(recipe.limit) || recipe.limit < 0;
      const requiredCuts = isInvalid
        ? ["admit:operation-template", "refuse:limit"]
        : recipe.limit === 0
          ? ["admit:operation-template", "stop:limit-zero"]
          : isRelation
            ? [
                "admit:operation-template",
                `capture:roots/${count}`,
                ...Array.from(
                  { length: count },
                  (_, member) => `admit:root-member/${member}`
                ),
                ...Array.from(
                  { length: count },
                  (_, member) =>
                    `effect:relation-updateMany/root-member/${member}`
                ),
              ]
            : [
                "admit:operation-template",
                `effect:${recipe.mutation}/set-oriented/${count}`,
              ];
      return {
        publicInput: { recipe },
        requiredCuts,
        seed(database) {
          if (isRelation) {
            database.exec(`
              CREATE TABLE cs03_b_shelves (id TEXT PRIMARY KEY, label TEXT NOT NULL);
              CREATE TABLE cs03_b_children (
                id TEXT PRIMARY KEY,
                shelfId TEXT NOT NULL REFERENCES cs03_b_shelves(id),
                label TEXT NOT NULL
              );
            `);
            const insert = database.prepare(
              "INSERT INTO cs03_b_shelves (id,label) VALUES (?,?)"
            );
            for (const row of relationRows) insert.run(row.id, row.label);
            return;
          }
          database.exec(`
            CREATE TABLE cs03_b_entries (
              id INTEGER PRIMARY KEY,
              "group" TEXT NOT NULL,
              value INTEGER NOT NULL
            );
          `);
          const insert = database.prepare(
            'INSERT INTO cs03_b_entries (id,"group",value) VALUES (?,?,?)'
          );
          for (const row of scalarRows)
            insert.run(row.id, row.group, row.value);
        },
        async invoke(driver, candidateFactory) {
          assert(
            candidateFactory,
            "CS-03 extension campaigns require one candidate engine"
          );
          try {
            const value = await candidateFactory({
              schema: isRelation ? { shelf, child: childModel } : { entry },
              driver,
            }).execute(isRelation ? "shelf" : "entry", operation, args);
            if (recipe.limit === 0) controls.recordCut("stop:limit-zero");
            return value;
          } catch (failure) {
            if (isInvalid) controls.recordCut("refuse:limit");
            throw failure;
          }
        },
        inspect(database) {
          return isRelation
            ? {
                roots: database
                  .prepare("SELECT id,label FROM cs03_b_shelves ORDER BY id")
                  .all(),
                children: database
                  .prepare(
                    "SELECT id,shelfId,label FROM cs03_b_children ORDER BY id"
                  )
                  .all(),
              }
            : {
                roots: database
                  .prepare(
                    'SELECT id,"group",value FROM cs03_b_entries ORDER BY id'
                  )
                  .all(),
                children: [],
              };
        },
        afterStatement(database, completion) {
          const cuts: string[] = [];
          const statement = completion.sql
            .trim()
            .split(whitespace, 1)[0]!
            .toUpperCase();
          statements.push(statement);
          if (
            admissionsAtFirstWrite === undefined &&
            ["DELETE", "INSERT", "UPDATE"].includes(statement)
          )
            admissionsAtFirstWrite = child;
          if (
            isRelation &&
            !relationCaptureObserved &&
            statement === "SELECT" &&
            completion.sql.includes("cs03_b_shelves") &&
            completion.sql.includes("ORDER BY") &&
            completion.rows.length === count
          ) {
            relationCaptureObserved = true;
            cuts.push(`capture:roots/${count}`);
          }
          if (isRelation) {
            const completed = database
              .prepare(
                "SELECT s.id FROM cs03_b_shelves s JOIN cs03_b_children c ON c.shelfId=s.id WHERE s.label='capped' AND c.label='created' ORDER BY s.id"
              )
              .all();
            for (const row of completed) {
              assert(isRecord(row) && typeof row.id === "string");
              if (completedRelationMembers.has(row.id)) continue;
              completedRelationMembers.add(row.id);
              cuts.push(
                `effect:relation-updateMany/root-member/${completedRelationMembers.size - 1}`
              );
            }
          } else if (!scalarEffectObserved && !isInvalid && recipe.limit > 0) {
            const state = database
              .prepare(
                recipe.mutation === "scalar-deleteMany"
                  ? 'SELECT COUNT(*) count FROM cs03_b_entries WHERE "group"=\'selected\''
                  : "SELECT COUNT(*) count FROM cs03_b_entries WHERE value=9"
              )
              .get();
            assert(isRecord(state));
            const effected =
              recipe.mutation === "scalar-deleteMany"
                ? state.count === recipe.rowCount - count
                : state.count === count;
            if (effected) {
              scalarEffectObserved = true;
              cuts.push(`effect:${recipe.mutation}/set-oriented/${count}`);
            }
          }
          return cuts;
        },
        assert(observation) {
          const cuts = observation.reachedCuts;
          const roots = observation.final.roots;
          assert(roots, "CS-03 B inspect must publish root rows");
          if (isInvalid) {
            assertScheduledCut(
              recipe.schedule,
              cuts,
              "admit:operation-template",
              "refuse:limit"
            );
            assert.equal(observation.outcome.kind, "failure");
            if (observation.outcome.kind === "failure")
              assert.equal(observation.outcome.failure.name, "ValidationError");
            assert.deepEqual(observation.final, observation.initial);
            assert.deepEqual(statements, []);
            return;
          }
          assert.deepEqual(observation.outcome, {
            kind: "success",
            value: { count },
          });
          if (recipe.limit === 0) {
            assertScheduledCut(
              recipe.schedule,
              cuts,
              "admit:operation-template",
              "stop:limit-zero"
            );
            assert.deepEqual(observation.final, observation.initial);
            assert.deepEqual(statements, []);
            assert.deepEqual(
              observation.defaults,
              isRelation ? [{ name: "child.id", value: "child-0" }] : []
            );
            return;
          }
          if (!isRelation) {
            assertScheduledCut(
              recipe.schedule,
              cuts,
              "admit:operation-template",
              `effect:${recipe.mutation}/set-oriented/${count}`
            );
            const write =
              recipe.mutation === "scalar-deleteMany" ? "DELETE" : "UPDATE";
            assert.equal(statements.filter((kind) => kind === write).length, 1);
            if (recipe.mutation === "scalar-deleteMany") {
              assert.equal(roots.length, recipe.rowCount - count);
              for (const row of roots) {
                assert(isRecord(row) && typeof row.id === "number");
                assert.deepEqual(row, scalarRows[row.id - 1]);
              }
            } else {
              assert.equal(roots.length, scalarRows.length);
              let updated = 0;
              for (let index = 0; index < roots.length; index += 1) {
                const row = roots[index];
                const initial = scalarRows[index];
                assert(isRecord(row) && initial);
                assert.equal(row.id, initial.id);
                assert.equal(row.group, initial.group);
                assert(row.value === initial.value || row.value === 9);
                if (row.value === 9) updated += 1;
              }
              assert.equal(updated, count);
            }
            assert.deepEqual(observation.defaults, []);
            return;
          }
          const children = observation.final.children;
          assert(children, "CS-03 B relation inspect must publish child rows");
          assert.deepEqual(observation.defaults, [
            { name: "child.id", value: "child-0" },
            ...Array.from({ length: count }, (_, index) => ({
              name: "child.id",
              value: `child-${index + 1}`,
            })),
          ]);
          assertScheduledCut(
            recipe.schedule,
            cuts,
            "admit:operation-template",
            `capture:roots/${count}`
          );
          for (let member = 0; member < count; member += 1) {
            assertScheduledCut(
              recipe.schedule,
              cuts,
              `capture:roots/${count}`,
              `admit:root-member/${member}`
            );
            assertScheduledCut(
              recipe.schedule,
              cuts,
              `admit:root-member/${member}`,
              "effect:relation-updateMany/root-member/0"
            );
            if (member + 1 < count)
              assertScheduledCut(
                recipe.schedule,
                cuts,
                `effect:relation-updateMany/root-member/${member}`,
                `effect:relation-updateMany/root-member/${member + 1}`
              );
          }
          assert.equal(
            admissionsAtFirstWrite,
            count + 1,
            "all capped members must be admitted before the first effect"
          );
          assert.deepEqual(
            roots,
            relationRows.map((row, index) => ({
              ...row,
              label: index < count ? "capped" : row.label,
            }))
          );
          assert.deepEqual(
            children,
            Array.from({ length: count }, (_, index) => ({
              id: `child-${index + 1}`,
              shelfId: relationRows[index]!.id,
              label: "created",
            }))
          );
        },
      };
    },
  };
}
