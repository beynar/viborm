import assert from "node:assert/strict";
import { ASSERTION_MARKER } from "@drivers/error-mapping";
import { s } from "@schema";
import { v } from "@validation";
import { isRecord } from "@validation/value-guards";
import type {
  RunObservation,
  ScenarioControls,
  ScenarioDefinition,
  StatementCompletion,
} from "../../harness/protocol";
import type { ExtensionARecipe } from "./extension-recipes";

const whitespace = /\s+/;
// The nested upsert's locate binds `lookup` through a PUBLIC text filter, which
// the candidate spells with the adapter's exact-text operator. That operator
// may name a byte-exact collation between the column and the comparison —
// `"lookup" COLLATE BINARY = ?` on SQLite (`sqlite-adapter.ts` `exactTextEq`),
// `COLLATE "C"` where Postgres names one — or none at all (Postgres
// `exactTextEq` is the plain `=`; MySQL prefixes `BINARY`). The cut is the
// locate statement, not one provider's punctuation, so the recognizer reads
// the key binding with or without one of those two collations. It deliberately
// does NOT accept an insensitive collation: that would be a different
// comparison, and a locate that stopped being exact-text must fail here rather
// than be recognized as the same cut. `parentId` / `parentTenant` are the
// relation scope's own key equality, not a public text filter, and carry no
// collation.
const lookupWhere = /WHERE[\s\S]*"lookup"(?: COLLATE (?:BINARY|"C"))?\s*=/;
const parentIdWhere = /WHERE[\s\S]*"parentId"\s*=/;
const parentTenantWhere = /WHERE[\s\S]*"parentTenant"\s*=/;
const terminalRowFailure = /could not read back one of the updated rows/;

function assertCutBefore(
  cuts: readonly string[],
  earlier: string,
  later: string
): void {
  const earlierIndex = cuts.indexOf(earlier);
  const laterIndex = cuts.indexOf(later);
  assert.notEqual(earlierIndex, -1, `missing schedule cut ${earlier}`);
  assert.notEqual(laterIndex, -1, `missing schedule cut ${later}`);
  assert.equal(
    earlierIndex < laterIndex,
    true,
    `${earlier} must precede ${later}`
  );
}

function expectedLabels(recipe: ExtensionARecipe): string[] {
  return Array.from({ length: recipe.rootCount }, (_, index) =>
    recipe.keyShape.startsWith("single-") &&
    recipe.nestedShape === "updateMany" &&
    (recipe.rootCount === 1 || index + 1 < recipe.rootCount)
      ? "nested-written"
      : "root-written"
  );
}

function finalAState(observation: RunObservation) {
  const roots = observation.final.roots;
  const nested = observation.final.nested;
  assert(roots, "CS-03 A inspect must publish root rows");
  assert(nested, "CS-03 A inspect must publish nested rows");
  return { roots, nested };
}

function assertFailure(
  recipe: ExtensionARecipe,
  controls: ScenarioControls,
  observation: RunObservation
): void {
  assert.equal(observation.outcome.kind, "failure");
  if (observation.outcome.kind !== "failure") return;
  assert.equal(observation.outcome.failure.name, "TransactionError");
  assert.match(observation.outcome.failure.message, terminalRowFailure);
  if (controls.profile === "sqlite-interactive") {
    if (isRecord(observation.outcome.failure.meta))
      assert.equal(
        observation.outcome.failure.meta.recordSeriesProgress,
        undefined
      );
    assert.deepEqual(observation.final, observation.initial);
    return;
  }
  assert(isRecord(observation.outcome.failure.meta));
  // U6.2: the nested set statement no longer opens its own captured-series
  // segment, so a fully written root member (its own write plus its
  // one-statement nested set) is ONE progress unit, not two.
  assert.deepEqual(observation.outcome.failure.meta.recordSeriesProgress, {
    atomicity: "segment",
    phase: "result",
    committedSegments: recipe.rootCount,
    committedWriteMembers: recipe.rootCount,
    completedMembers: recipe.rootCount,
  });
  assert.equal(finalAState(observation).roots.length, 1);
}

export function extensionAScenario(
  recipe: ExtensionARecipe
): ScenarioDefinition {
  return {
    id: "cs03-extension-a",
    family: "C08",
    contracts: ["C08", "C10", "C12", "C13"],
    sources: ["tests/raptor3/core-structure/extension-a.contract.test.ts"],
    prepare(controls) {
      let idAdmission = 0;
      let lookupAdmission = 0;
      let lookupTransformAdmission = 0;
      let rootAdmissionsAtFirstEffect: number | undefined;
      let rootAdmission = 0;
      let nestedAdmission = 0;
      const seenRootEffects = new Set<string>();
      const seenNestedEffects = new Set<string>();
      const deletedRoots = new Set<number>();
      let rootCaptureObserved = false;
      let nestedCapture = 0;
      let choiceObservation = 0;
      const isSingle = recipe.keyShape.startsWith("single-");
      const keepsKeys = recipe.keyShape.endsWith("-kept");
      const movesCompoundKeys =
        !isSingle &&
        recipe.nestedShape !== "updateMany" &&
        recipe.nestedShape !== "upsert-found";
      const selectedNestedSeries =
        recipe.nestedShape === "updateMany" ||
        recipe.nestedShape === "deleteMany";
      const admitRootToken = (input: string) => {
        if (input !== "admitted") return input;
        const admission = rootAdmission;
        rootAdmission += 1;
        controls.recordCut(
          admission === 0
            ? "admit:root-template"
            : `admit:root-member/${admission - 1}`
        );
        return input;
      };
      const admitNestedMember = (input: string) => {
        if (input !== "admitted" && input !== "deletable") return input;
        const admission = nestedAdmission;
        nestedAdmission += 1;
        const member =
          admission - recipe.rootCount - 1 +
          (recipe.nestedShape === "deleteMany" ? 1 : 0);
        controls.recordCut(
          admission === 0
            ? "admit:nested-template"
            : admission <= recipe.rootCount
              ? `admit:nested-template/root-member/${admission - 1}`
              : `admit:nested-member/${member}`
        );
        return input;
      };
      const nextSingleId = () => {
        const value = 1000 + idAdmission;
        idAdmission += 1;
        controls.recordDefault("nested.id", value);
        return value;
      };
      const nextCompoundId = () => {
        const value = `child-${idAdmission}`;
        idAdmission += 1;
        controls.recordDefault("nested.id", value);
        return value;
      };
      const nextLookup = () => {
        const value = `created-${lookupAdmission}`;
        lookupAdmission += 1;
        controls.recordDefault("nested.lookup", value);
        return value;
      };
      const admitLookup = (input: string) => {
        if (!recipe.nestedShape.startsWith("upsert-")) return input;
        lookupTransformAdmission += 1;
        const member =
          lookupTransformAdmission <= 2
            ? "template"
            : Math.ceil((lookupTransformAdmission - 2) / 2);
        return `${recipe.nestedShape === "upsert-found" ? "helper" : "missing"}-${member}`;
      };

      const node = s
        .model({
          id: s.int().id().default(nextSingleId),
          kind: s.string().default("nested"),
          lookup: s
            .string()
            .schema(v.string({ transform: admitLookup }))
            .unique()
            .default(nextLookup),
          label: s.string(),
          rootToken: s.string().schema(v.string({ transform: admitRootToken })),
          nestedToken: s
            .string()
            .schema(v.string({ transform: admitNestedMember })),
          deleteGroup: s
            .string()
            .schema(v.string({ transform: admitNestedMember })),
          parentId: s.int().nullable(),
          parent: s
            .toOne(() => node)
            .fields("parentId")
            .references("id")
            .name("cs03ASelectionTree"),
          children: s.toMany(() => node).name("cs03ASelectionTree"),
        })
        .map("cs03_a_nodes");

      const parent = s
        .model({
          tenant: s.string(),
          serial: s.int(),
          label: s.string(),
          rootToken: s.string().schema(v.string({ transform: admitRootToken })),
          children: s.toMany(() => child),
        })
        .id(["tenant", "serial"])
        .map("cs03_a_parents");
      const child = s
        .model({
          id: s.string().id().default(nextCompoundId),
          lookup: s
            .string()
            .schema(v.string({ transform: admitLookup }))
            .unique()
            .default(nextLookup),
          label: s.string(),
          nestedToken: s
            .string()
            .schema(v.string({ transform: admitNestedMember })),
          deleteGroup: s
            .string()
            .schema(v.string({ transform: admitNestedMember })),
          parentTenant: s.string(),
          parentSerial: s.int(),
          parent: s
            .toOne(() => parent)
            .fields("parentTenant", "parentSerial")
            .references("tenant", "serial"),
        })
        .map("cs03_a_children");

      const nested =
        recipe.nestedShape === "deleteMany"
          ? { deleteMany: { deleteGroup: "deletable" } }
          : recipe.nestedShape === "create"
            ? {
                create: {
                  label: "created",
                  ...(isSingle
                    ? {
                        rootToken: "nested",
                        nestedToken: "initial",
                        deleteGroup: "helper",
                      }
                    : { nestedToken: "initial", deleteGroup: "helper" }),
                },
              }
            : recipe.nestedShape === "updateMany"
              ? {
                  updateMany: {
                    where: isSingle ? { kind: "root" } : {},
                    data: {
                      label: "nested-written",
                      nestedToken: "admitted",
                    },
                  },
                }
              : {
                  upsert: {
                    where: { lookup: "raw" },
                    create: {
                      lookup: "raw",
                      label: "created",
                      ...(isSingle
                        ? {
                            rootToken: "nested",
                            nestedToken: "initial",
                            deleteGroup: "helper",
                          }
                        : { nestedToken: "initial", deleteGroup: "helper" }),
                    },
                    update: { label: "found" },
                  },
                };
      const select = isSingle
        ? keepsKeys
          ? { id: true, label: true }
          : { label: true }
        : keepsKeys
          ? { tenant: true, serial: true, label: true }
          : { label: true };
      const args = isSingle
        ? {
            where: { kind: "root" },
            data: {
              label: "root-written",
              rootToken: "admitted",
              children: nested,
            },
            select,
          }
        : {
            where: { tenant: "t" },
            data: {
              ...(movesCompoundKeys
                ? { serial: { increment: 100 } }
                : {}),
              label: "root-written",
              rootToken: "admitted",
              children: nested,
            },
            select,
          };

      // U6.2 (raptor3-parity-plan.md, g4/parity/lane-x-note.md): a nested
      // updateMany/deleteMany on this row-held membership, whose payload
      // names no nested relation write, is one correlated `set` statement —
      // no plan-time lookup, no captured series, no per-member re-admission.
      // Only `admit:nested-template`/`admit:nested-template/root-member/N`
      // (the template's own admission, once per root member) still cut;
      // `capture:nested/root-member/N` and `admit:nested-member/N` named the
      // eliminated lookup-then-reapply cycle and are gone (repair-note.md R6).
      const requiredCuts = [
        "admit:root-template",
        `capture:roots/${recipe.rootCount}`,
        ...Array.from(
          { length: recipe.rootCount },
          (_, member) => `admit:root-member/${member}`
        ),
        ...Array.from(
          { length: recipe.rootCount },
          (_, member) => `effect:root/${member}`
        ),
        ...(selectedNestedSeries
          ? [
              "admit:nested-template",
              ...Array.from(
                { length: recipe.rootCount },
                (_, member) =>
                  `admit:nested-template/root-member/${member}`
              ),
            ]
          : []),
        ...(recipe.nestedShape.startsWith("upsert-")
          ? Array.from(
              { length: recipe.rootCount },
              (_, member) =>
                `choice:${recipe.nestedShape.slice("upsert-".length)}/root-member/${member}`
            )
          : []),
        ...Array.from(
          {
            length:
              recipe.nestedShape === "deleteMany"
                ? recipe.rootCount - 1
                : recipe.rootCount,
          },
          (_, index) =>
            `effect:${recipe.nestedShape}/root-member/${
              recipe.nestedShape === "deleteMany" ? index + 1 : index
            }`
        ),
        "result:terminal-roots",
      ];

      function inspectSingle(database: import("better-sqlite3").Database) {
        return {
          roots: database
            .prepare(
              "SELECT id,label,parentId FROM cs03_a_nodes WHERE kind='root' ORDER BY id"
            )
            .all(),
          nested: database
            .prepare(
              "SELECT id,lookup,label,parentId FROM cs03_a_nodes WHERE kind<>'root' ORDER BY id"
            )
            .all(),
        };
      }

      function inspectCompound(database: import("better-sqlite3").Database) {
        return {
          roots: database
            .prepare(
              "SELECT tenant,serial,label FROM cs03_a_parents ORDER BY tenant,serial"
            )
            .all(),
          nested: database
            .prepare(
              "SELECT id,lookup,label,parentTenant,parentSerial FROM cs03_a_children ORDER BY id"
            )
            .all(),
        };
      }

      return {
        publicInput: { recipe },
        requiredCuts,
        seed(database) {
          if (isSingle) {
            database.exec(`
              CREATE TABLE cs03_a_nodes (
                id INTEGER PRIMARY KEY,
                kind TEXT NOT NULL,
                lookup TEXT NOT NULL UNIQUE,
                label TEXT NOT NULL,
                rootToken TEXT NOT NULL,
                nestedToken TEXT NOT NULL,
                deleteGroup TEXT NOT NULL,
                parentId INTEGER REFERENCES cs03_a_nodes(id)
                  ON UPDATE CASCADE ON DELETE CASCADE
              );
            `);
            const insert = database.prepare(
              "INSERT INTO cs03_a_nodes VALUES (?,?,?,?,?,?,?,?)"
            );
            for (let root = 1; root <= recipe.rootCount; root += 1) {
              insert.run(
                root,
                "root",
                `root-${root}`,
                `root-${root}`,
                "initial",
                "initial",
                "deletable",
                null
              );
              insert.run(
                100 + root,
                "helper",
                `helper-${root}`,
                "initial",
                "nested",
                "initial",
                "helper",
                root
              );
            }
            const linkRoot = database.prepare(
              "UPDATE cs03_a_nodes SET parentId=? WHERE id=?"
            );
            for (let root = 1; root <= recipe.rootCount; root += 1) {
              const parentId =
                recipe.nestedShape === "updateMany"
                  ? root < recipe.rootCount
                    ? root + 1
                    : 1
                  : root < recipe.rootCount
                    ? root + 1
                    : null;
              linkRoot.run(parentId, root);
            }
            return;
          }
          database.exec(`
            CREATE TABLE cs03_a_parents (
              tenant TEXT NOT NULL,
              serial INTEGER NOT NULL,
              label TEXT NOT NULL,
              rootToken TEXT NOT NULL,
              PRIMARY KEY (tenant,serial)
            );
            CREATE TABLE cs03_a_children (
              id TEXT PRIMARY KEY,
              lookup TEXT NOT NULL UNIQUE,
              label TEXT NOT NULL,
              nestedToken TEXT NOT NULL,
              deleteGroup TEXT NOT NULL,
              parentTenant TEXT NOT NULL,
              parentSerial INTEGER NOT NULL,
              FOREIGN KEY (parentTenant,parentSerial)
                REFERENCES cs03_a_parents(tenant,serial)
                ON UPDATE CASCADE ON DELETE CASCADE
            );
          `);
          const parentInsert = database.prepare(
            "INSERT INTO cs03_a_parents VALUES ('t',?,?,?)"
          );
          const childInsert = database.prepare(
            "INSERT INTO cs03_a_children VALUES (?,?,?,?,?,?,?)"
          );
          for (let root = 1; root <= recipe.rootCount; root += 1) {
            parentInsert.run(root, `root-${root}`, "initial");
            if (
              recipe.nestedShape === "updateMany" ||
              recipe.nestedShape === "upsert-found"
            )
              childInsert.run(
                `helper-${root}`,
                `helper-${root}`,
                "initial",
                "initial",
                "helper",
                "t",
                root
              );
          }
        },
        async invoke(driver, candidateFactory) {
          assert(
            candidateFactory,
            "CS-03 extension campaigns require one candidate engine"
          );
          return await candidateFactory({
            schema: isSingle ? { node } : { parent, child },
            driver,
          }).execute(isSingle ? "node" : "parent", "updateMany", args);
        },
        inspect(database) {
          return isSingle ? inspectSingle(database) : inspectCompound(database);
        },
        afterStatement(database, completion: StatementCompletion) {
          const cuts: string[] = [];
          const sql = completion.sql;
          const statement = sql.trim().split(whitespace, 1)[0]?.toUpperCase();
          // A batch PREMISE is not an observation (N1, D-51: a dependent read
          // is an ordered observation). A nested lookup whose answer depends on
          // an earlier write of this operation is taken at its consumer's
          // execution point, and on the batch route its found requirement rides
          // that same batch as a premise over the SAME selector
          // (`Selection.outsideMembership`). The correlated upsert's locate is
          // one: it names the parent by the key the parent's own SET published
          // (`RelationBody.correlationParent` — placement, not verb), and that
          // key is one this operation writes. The premise therefore repeats the
          // locate's WHERE verbatim, so a recognizer reading only the WHERE
          // matches the premise FIRST and reads the engine's assert row — which
          // is always exactly one row — instead of the located rows. A premise
          // projects `ASSERTION_MARKER` and nothing else; an observation
          // projects the row it observed. Same rule, same spelling as
          // `tests/raptor3/core-structure/structural-reference.test.ts`'s
          // `reads`.
          const isObservation =
            statement === "SELECT" && !sql.includes(ASSERTION_MARKER);
          const rootTable = isSingle ? "cs03_a_nodes" : "cs03_a_parents";
          const nestedTable = isSingle ? "cs03_a_nodes" : "cs03_a_children";
          if (
            isObservation &&
            !rootCaptureObserved &&
            sql.includes(rootTable) &&
            sql.includes("ORDER BY") &&
            completion.rows.length === recipe.rootCount
          ) {
            rootCaptureObserved = true;
            cuts.push(`capture:roots/${recipe.rootCount}`);
          }
          if (
            isObservation &&
            selectedNestedSeries &&
            nestedCapture < recipe.rootCount &&
            sql.includes(nestedTable) &&
            (isSingle ? parentIdWhere.test(sql) : parentTenantWhere.test(sql))
          ) {
            cuts.push(`capture:nested/root-member/${nestedCapture}`);
            nestedCapture += 1;
          }
          if (
            isObservation &&
            recipe.nestedShape.startsWith("upsert-") &&
            choiceObservation < recipe.rootCount &&
            sql.includes(nestedTable) &&
            lookupWhere.test(sql)
          ) {
            // The locate is the observation point because it is what decides
            // found from missing: the composition slice pins the same property.
            assert.equal(
              completion.rows.length,
              recipe.nestedShape === "upsert-found" ? 1 : 0
            );
            cuts.push(
              `choice:${recipe.nestedShape.slice("upsert-".length)}/root-member/${choiceObservation}`
            );
            choiceObservation += 1;
          }

          const roots = database
            .prepare(
              isSingle
                ? "SELECT CAST(id AS TEXT) identity,rootToken,label FROM cs03_a_nodes WHERE kind='root' ORDER BY id"
                : "SELECT tenant || ':' || serial identity,rootToken,label FROM cs03_a_parents ORDER BY tenant,serial"
            )
            .all();
          for (const row of roots) {
            assert(isRecord(row));
            if (
              row.rootToken !== "admitted" ||
              typeof row.identity !== "string" ||
              seenRootEffects.has(row.identity)
            )
              continue;
            if (rootAdmissionsAtFirstEffect === undefined)
              rootAdmissionsAtFirstEffect = rootAdmission;
            seenRootEffects.add(row.identity);
            cuts.push(`effect:root/${seenRootEffects.size - 1}`);
          }

          if (recipe.nestedShape === "deleteMany") {
            const present = new Set(
              roots.flatMap((row) => {
                if (!isRecord(row) || typeof row.identity !== "string")
                  return [];
                return [Number(row.identity)];
              })
            );
            for (let root = 1; root < recipe.rootCount; root += 1) {
              if (present.has(root) || deletedRoots.has(root)) continue;
              deletedRoots.add(root);
              cuts.push(`effect:deleteMany/root-member/${root}`);
            }
          } else {
            const effected = database
              .prepare(
                recipe.nestedShape === "updateMany"
                  ? isSingle
                    ? "SELECT CAST(id AS TEXT) identity FROM cs03_a_nodes WHERE kind='root' AND nestedToken='admitted' ORDER BY id"
                    : "SELECT id identity FROM cs03_a_children WHERE nestedToken='admitted' ORDER BY id"
                  : recipe.nestedShape === "upsert-found"
                    ? isSingle
                      ? "SELECT CAST(id AS TEXT) identity FROM cs03_a_nodes WHERE kind='helper' AND label='found' ORDER BY id"
                      : "SELECT id identity FROM cs03_a_children WHERE label='found' ORDER BY id"
                    : isSingle
                      ? "SELECT CAST(id AS TEXT) identity FROM cs03_a_nodes WHERE kind='nested' AND label='created' ORDER BY id"
                      : "SELECT id identity FROM cs03_a_children WHERE label='created' ORDER BY id"
              )
              .all();
            for (const row of effected) {
              assert(isRecord(row));
              if (
                typeof row.identity !== "string" ||
                seenNestedEffects.has(row.identity)
              )
                continue;
              seenNestedEffects.add(row.identity);
              cuts.push(
                `effect:${recipe.nestedShape}/root-member/${seenNestedEffects.size - 1}`
              );
            }
          }

          if (
            isObservation &&
            sql.includes(rootTable) &&
            sql.includes('"label" AS "label"') &&
            !sql.includes('"rootToken" AS "rootToken"')
          )
            cuts.push("result:terminal-roots");
          return cuts;
        },
        assert(observation) {
          const cuts = observation.reachedCuts;
          const final = finalAState(observation);
          const assertScheduled = (earlier: string, later: string) => {
            assert.equal(
              recipe.schedule.includes(`before:${earlier}<${later}`),
              true,
              `recipe omitted required edge ${earlier} -> ${later}`
            );
            assertCutBefore(cuts, earlier, later);
          };
          assert.equal(rootAdmission, recipe.rootCount + 1);
          assert.equal(rootAdmissionsAtFirstEffect, recipe.rootCount + 1);
          assertScheduled(
            "admit:root-template",
            `capture:roots/${recipe.rootCount}`
          );
          if (selectedNestedSeries) {
            assertScheduled("admit:root-template", "admit:nested-template");
            assertScheduled(
              "admit:nested-template",
              `capture:roots/${recipe.rootCount}`
            );
          }
          for (let member = 0; member < recipe.rootCount; member += 1) {
            assertScheduled(
              `capture:roots/${recipe.rootCount}`,
              `admit:root-member/${member}`
            );
            assertScheduled(`admit:root-member/${member}`, "effect:root/0");
            if (selectedNestedSeries) {
              assertScheduled(
                `admit:root-member/${member}`,
                `admit:nested-template/root-member/${member}`
              );
              assertScheduled(
                `admit:nested-template/root-member/${member}`,
                "effect:root/0"
              );
              // U6.2 eliminated `capture:nested/root-member/N` and (for a
              // set-oriented update) `admit:nested-member/N`: the nested set
              // statement is admitted once as the template, at its own
              // root-member position, above — there is no second per-member
              // capture-then-readmit cycle left to order against. The
              // surviving, still-true edge is body order: the root member's
              // own effect precedes its nested set's effect (both remain in
              // `recipe.schedule`, unlike the eliminated cuts).
              if (recipe.nestedShape !== "deleteMany" || member > 0) {
                assertScheduled(
                  `effect:root/${member}`,
                  `effect:${recipe.nestedShape}/root-member/${member}`
                );
              }
            } else if (recipe.nestedShape.startsWith("upsert-")) {
              const choice = `choice:${recipe.nestedShape.slice("upsert-".length)}/root-member/${member}`;
              assertScheduled(
                choice,
                `effect:${recipe.nestedShape}/root-member/${member}`
              );
              assertScheduled(
                `effect:root/${member}`,
                `effect:${recipe.nestedShape}/root-member/${member}`
              );
            } else
              assertScheduled(
                `effect:root/${member}`,
                `effect:${recipe.nestedShape}/root-member/${member}`
              );
            if (
              member + 1 < recipe.rootCount &&
              !(recipe.nestedShape === "deleteMany" && member === 0)
            )
              assertScheduled(
                `effect:${recipe.nestedShape}/root-member/${member}`,
                `effect:root/${member + 1}`
              );
          }
          // U6.2: no captured member remains to re-admit a second time, so
          // both set-oriented shapes admit the template once plus once per
          // root member (previously updateMany alone also re-admitted per
          // captured member, `recipe.rootCount * 2 + 1`).
          assert.equal(
            nestedAdmission,
            selectedNestedSeries ? recipe.rootCount + 1 : 0
          );
          const lastEffect = `effect:${recipe.nestedShape}/root-member/${recipe.rootCount - 1}`;
          assertScheduled(lastEffect, "result:terminal-roots");
          if (recipe.missingTerminalRow) {
            assertFailure(recipe, controls, observation);
            return;
          }
          const labels = expectedLabels(recipe);
          const expectedRows = labels.map((label, index) =>
            isSingle
              ? keepsKeys
                ? { id: index + 1, label }
                : { label }
              : keepsKeys
                ? {
                    tenant: "t",
                    serial: index + (movesCompoundKeys ? 101 : 1),
                    label,
                  }
                : { label }
          );
          assert.deepEqual(observation.outcome, {
            kind: "success",
            value: expectedRows,
          });
          assert.deepEqual(
            final.roots.map((row) => {
              assert(isRecord(row));
              return row.label;
            }),
            labels
          );
          if (!isSingle)
            assert.deepEqual(
              final.roots.map((row) => {
                assert(isRecord(row));
                return row.serial;
              }),
              Array.from(
                { length: recipe.rootCount },
                (_, index) => index + (movesCompoundKeys ? 101 : 1)
              )
            );
          if (recipe.nestedShape === "updateMany" && !isSingle)
            assert.equal(
              final.nested.every(
                (row) => isRecord(row) && row.label === "nested-written"
              ),
              true
            );
          if (recipe.nestedShape === "upsert-found")
            assert.equal(
              final.nested.every(
                (row) => isRecord(row) && row.label === "found"
              ),
              true
            );
          if (
            recipe.nestedShape === "create" ||
            recipe.nestedShape === "upsert-missing"
          )
            assert.equal(
              final.nested.filter(
                (row) => isRecord(row) && row.label === "created"
              ).length,
              recipe.rootCount
            );
        },
      };
    },
  };
}
