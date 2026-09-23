import assert from "node:assert/strict";
import { s } from "@schema";
import { v } from "@validation";
import { isRecord } from "@validation/value-guards";
import type { ScenarioDefinition } from "../../harness/protocol";
import type { ExtensionCompositionRecipe } from "./extension-recipes";

const whitespace = /\s+/;
// The holder upsert's locate binds `lookup` through a PUBLIC text filter, which
// the candidate spells with the adapter's exact-text operator. That operator
// may name a byte-exact collation between the column and the comparison —
// `"lookup" COLLATE BINARY = ?` on SQLite (`sqlite-adapter.ts` `exactTextEq`),
// `COLLATE "C"` where Postgres names one — or none at all. The cut is the
// locate statement, not one provider's punctuation, so the recognizer reads
// the key binding with or without one of those two collations, and never with
// an insensitive one: that would be a different comparison, not this cut.
const lookupWhere = /WHERE[\s\S]*"lookup"(?: COLLATE (?:BINARY|"C"))?\s*=/;

function assertScheduledCut(
  schedule: readonly string[],
  cuts: readonly string[],
  earlier: string,
  later: string
): void {
  assert.equal(
    schedule.includes(`before:${earlier}<${later}`),
    true,
    `recipe omitted required edge ${earlier} -> ${later}`
  );
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

export function extensionCompositionScenario(
  recipe: ExtensionCompositionRecipe
): ScenarioDefinition {
  return {
    id: "cs03-extension-composition",
    family: "C08",
    contracts: ["C08", "C11", "C12", "C13"],
    sources: [
      "tests/raptor3/core-structure/extension-composition.contract.test.ts",
    ],
    prepare(controls) {
      const isSingle = recipe.keyShape === "single-omitted";
      const selectedCount = Math.min(recipe.limit, recipe.rootCount);
      let ticketAdmission = 0;
      let holderAdmission = 0;
      let holderLookupAdmissions = 0;
      let statementCount = 0;
      let rootCaptureObserved = false;
      let binCapture = 0;
      let choiceObservation = 0;
      let terminalResultObserved = false;
      const completedBins = new Set<string>();
      const completedChoices = new Set<number>();
      const nextTicketId = () => {
        const admission = ticketAdmission;
        const value = `ticket-${admission}`;
        ticketAdmission += 1;
        controls.recordDefault("ticket.id", value);
        if (admission === 0)
          controls.recordCut("admit:bin-template/operation");
        else if (admission <= selectedCount)
          controls.recordCut(
            `admit:bin-template/root-member/${admission - 1}`
          );
        else {
          const member = admission - selectedCount - 1;
          controls.recordCut(
            `admit:bin-member/${Math.floor(member / recipe.seriesWidth)}/${member % recipe.seriesWidth}`
          );
        }
        return value;
      };
      const admitHolderLookup = () => {
        const admission = holderLookupAdmissions;
        holderLookupAdmissions += 1;
        controls.recordCut(
          admission < 2
            ? `admit:choice-template/operation/${admission}`
            : `admit:choice-template/root-member/${Math.floor(
                (admission - 2) / 2
              )}/${(admission - 2) % 2}`
        );
        const member =
          holderLookupAdmissions <= 2
            ? "template"
            : Math.ceil((holderLookupAdmissions - 2) / 2);
        return `${recipe.choice === "found" ? "holder" : "missing"}-${member}`;
      };
      const nextHolderId = () => {
        const admission = holderAdmission;
        const value = `holder-new-${admission}`;
        holderAdmission += 1;
        controls.recordDefault("holder.id", value);
        controls.recordCut(
          admission === 0
            ? "admit:holder-template/operation"
            : `admit:holder-template/root-member/${admission - 1}`
        );
        return value;
      };

      const shelf = s
        .model({
          id: s.string().id(),
          label: s.string(),
          bins: s.toMany(() => bin).name("cs03CompositionShelfBins"),
          holders: s.toMany(() => holder).name("cs03CompositionShelfHolders"),
        })
        .map("cs03_composition_shelves");
      const bin = s
        .model({
          id: s.string().id(),
          label: s.string(),
          shelfId: s.string(),
          shelf: s
            .toOne(() => shelf)
            .fields("shelfId")
            .references("id")
            .name("cs03CompositionShelfBins"),
          tickets: s.toMany(() => ticket).name("cs03CompositionBinTickets"),
        })
        .map("cs03_composition_bins");
      const ticket = s
        .model({
          id: s.string().id().default(nextTicketId),
          note: s.string(),
          binId: s.string(),
          bin: s
            .toOne(() => bin)
            .fields("binId")
            .references("id")
            .name("cs03CompositionBinTickets"),
        })
        .map("cs03_composition_tickets");
      const holder = s
        .model({
          id: s.string().id().default(nextHolderId),
          lookup: s
            .string()
            .schema(v.string({ transform: admitHolderLookup }))
            .unique(),
          label: s.string(),
          shelfId: s.string(),
          shelf: s
            .toOne(() => shelf)
            .fields("shelfId")
            .references("id")
            .name("cs03CompositionShelfHolders"),
        })
        .map("cs03_composition_holders");

      const compoundShelf = s
        .model({
          tenant: s.string(),
          serial: s.int(),
          label: s.string(),
          bins: s
            .toMany(() => compoundBin)
            .name("cs03CompositionCompoundShelfBins"),
          holders: s
            .toMany(() => compoundHolder)
            .name("cs03CompositionCompoundShelfHolders"),
        })
        .id(["tenant", "serial"])
        .map("cs03_composition_compound_shelves");
      const compoundBin = s
        .model({
          id: s.string().id(),
          label: s.string(),
          shelfTenant: s.string(),
          shelfSerial: s.int(),
          shelf: s
            .toOne(() => compoundShelf)
            .fields("shelfTenant", "shelfSerial")
            .references("tenant", "serial")
            .name("cs03CompositionCompoundShelfBins"),
          tickets: s
            .toMany(() => compoundTicket)
            .name("cs03CompositionCompoundBinTickets"),
        })
        .map("cs03_composition_compound_bins");
      const compoundTicket = s
        .model({
          id: s.string().id().default(nextTicketId),
          note: s.string(),
          binId: s.string(),
          bin: s
            .toOne(() => compoundBin)
            .fields("binId")
            .references("id")
            .name("cs03CompositionCompoundBinTickets"),
        })
        .map("cs03_composition_compound_tickets");
      const compoundHolder = s
        .model({
          id: s.string().id().default(nextHolderId),
          lookup: s
            .string()
            .schema(v.string({ transform: admitHolderLookup }))
            .unique(),
          label: s.string(),
          shelfTenant: s.string(),
          shelfSerial: s.int(),
          shelf: s
            .toOne(() => compoundShelf)
            .fields("shelfTenant", "shelfSerial")
            .references("tenant", "serial")
            .name("cs03CompositionCompoundShelfHolders"),
        })
        .map("cs03_composition_compound_holders");

      const nested = {
        bins: {
          updateMany: {
            where: {},
            data: {
              label: "touched",
              tickets: { create: { note: "created" } },
            },
          },
        },
        holders: {
          upsert: {
            where: { lookup: "raw-holder" },
            create: { lookup: "raw-holder", label: "created" },
            update: { label: "found" },
          },
        },
      };
      const requiredCuts =
        recipe.limit === 0
          ? [
              "admit:bin-template/operation",
              "admit:choice-template/operation/0",
              "admit:choice-template/operation/1",
              "admit:holder-template/operation",
              "stop:limit-zero",
            ]
          : [
              "admit:bin-template/operation",
              "admit:choice-template/operation/0",
              "admit:choice-template/operation/1",
              "admit:holder-template/operation",
              `capture:roots/${selectedCount}`,
              ...Array.from(
                { length: selectedCount },
                (_, root) => `admit:bin-template/root-member/${root}`
              ),
              ...Array.from(
                { length: selectedCount },
                (_, root) => `admit:holder-template/root-member/${root}`
              ),
              ...Array.from(
                { length: selectedCount },
                (_, root) => `admit:choice-template/root-member/${root}/0`
              ),
              ...Array.from(
                { length: selectedCount },
                (_, root) => `admit:choice-template/root-member/${root}/1`
              ),
              ...Array.from(
                { length: selectedCount },
                (_, root) =>
                  `capture:bins/root-member/${root}/${recipe.seriesWidth}`
              ),
              ...Array.from({ length: selectedCount }, (_, root) =>
                Array.from(
                  { length: recipe.seriesWidth },
                  (_unused, bin) => `admit:bin-member/${root}/${bin}`
                )
              ).flat(),
              ...Array.from({ length: selectedCount }, (_, root) =>
                Array.from(
                  { length: recipe.seriesWidth },
                  (_unused, bin) => `effect:bin-member/${root}/${bin}`
                )
              ).flat(),
              ...Array.from(
                { length: selectedCount },
                (_, root) => `choice:${recipe.choice}/root-member/${root}`
              ),
              ...Array.from(
                { length: selectedCount },
                (_, root) =>
                  `effect:choice-${recipe.choice}/root-member/${root}`
              ),
              "result:terminal-roots",
            ];

      return {
        publicInput: { recipe },
        requiredCuts,
        seed(database) {
          if (isSingle)
            database.exec(`
              CREATE TABLE cs03_composition_shelves (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL
              );
              CREATE TABLE cs03_composition_bins (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                shelfId TEXT NOT NULL REFERENCES cs03_composition_shelves(id)
              );
              CREATE TABLE cs03_composition_tickets (
                id TEXT PRIMARY KEY,
                note TEXT NOT NULL,
                binId TEXT NOT NULL REFERENCES cs03_composition_bins(id)
              );
              CREATE TABLE cs03_composition_holders (
                id TEXT PRIMARY KEY,
                lookup TEXT NOT NULL UNIQUE,
                label TEXT NOT NULL,
                shelfId TEXT NOT NULL REFERENCES cs03_composition_shelves(id)
              );
              CREATE TRIGGER cs03_composition_terminal_single
              AFTER UPDATE OF label ON cs03_composition_bins
              WHEN NEW.label='touched'
              BEGIN
                UPDATE cs03_composition_shelves
                SET label='terminal'
                WHERE id=NEW.shelfId;
              END;
            `);
          else
            database.exec(`
              CREATE TABLE cs03_composition_compound_shelves (
                tenant TEXT NOT NULL,
                serial INTEGER NOT NULL,
                label TEXT NOT NULL,
                PRIMARY KEY (tenant,serial)
              );
              CREATE TABLE cs03_composition_compound_bins (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                shelfTenant TEXT NOT NULL,
                shelfSerial INTEGER NOT NULL,
                FOREIGN KEY (shelfTenant,shelfSerial)
                  REFERENCES cs03_composition_compound_shelves(tenant,serial)
              );
              CREATE TABLE cs03_composition_compound_tickets (
                id TEXT PRIMARY KEY,
                note TEXT NOT NULL,
                binId TEXT NOT NULL REFERENCES cs03_composition_compound_bins(id)
              );
              CREATE TABLE cs03_composition_compound_holders (
                id TEXT PRIMARY KEY,
                lookup TEXT NOT NULL UNIQUE,
                label TEXT NOT NULL,
                shelfTenant TEXT NOT NULL,
                shelfSerial INTEGER NOT NULL,
                FOREIGN KEY (shelfTenant,shelfSerial)
                  REFERENCES cs03_composition_compound_shelves(tenant,serial)
              );
              CREATE TRIGGER cs03_composition_terminal_compound
              AFTER UPDATE OF label ON cs03_composition_compound_bins
              WHEN NEW.label='touched'
              BEGIN
                UPDATE cs03_composition_compound_shelves
                SET label='terminal'
                WHERE tenant=NEW.shelfTenant AND serial=NEW.shelfSerial;
              END;
            `);
          const rootInsert = database.prepare(
            isSingle
              ? "INSERT INTO cs03_composition_shelves VALUES (?,?)"
              : "INSERT INTO cs03_composition_compound_shelves VALUES ('t',?,?)"
          );
          const binInsert = database.prepare(
            isSingle
              ? "INSERT INTO cs03_composition_bins VALUES (?,?,?)"
              : "INSERT INTO cs03_composition_compound_bins VALUES (?,?, 't',?)"
          );
          const holderInsert = database.prepare(
            isSingle
              ? "INSERT INTO cs03_composition_holders VALUES (?,?,?,?)"
              : "INSERT INTO cs03_composition_compound_holders VALUES (?,?,?,'t',?)"
          );
          for (let root = 1; root <= recipe.rootCount; root += 1) {
            rootInsert.run(
              ...(isSingle
                ? [`s${root}`, `root-${root}`]
                : [root, `root-${root}`])
            );
            for (
              let binIndex = 1;
              binIndex <= recipe.seriesWidth;
              binIndex += 1
            )
              binInsert.run(
                `b${root}-${binIndex}`,
                "initial",
                isSingle ? `s${root}` : root
              );
            if (recipe.choice === "found")
              holderInsert.run(
                `h${root}`,
                `holder-${root}`,
                "initial",
                isSingle ? `s${root}` : root
              );
          }
        },
        async invoke(driver, candidateFactory) {
          assert(
            candidateFactory,
            "CS-03 extension campaigns require one candidate engine"
          );
          const result = await candidateFactory({
            schema: isSingle
              ? { shelf, bin, ticket, holder }
              : {
                  shelf: compoundShelf,
                  bin: compoundBin,
                  ticket: compoundTicket,
                  holder: compoundHolder,
                },
            driver,
          }).execute("shelf", "updateMany", {
            where: {},
            data: nested,
            limit: recipe.limit,
            select: { label: true },
          });
          if (recipe.limit === 0) controls.recordCut("stop:limit-zero");
          return result;
        },
        inspect(database) {
          return {
            roots: database
              .prepare(
                isSingle
                  ? "SELECT id,label FROM cs03_composition_shelves ORDER BY id"
                  : "SELECT tenant,serial,label FROM cs03_composition_compound_shelves ORDER BY tenant,serial"
              )
              .all(),
            bins: database
              .prepare(
                isSingle
                  ? "SELECT id,label,shelfId FROM cs03_composition_bins ORDER BY id"
                  : "SELECT id,label,shelfTenant,shelfSerial FROM cs03_composition_compound_bins ORDER BY id"
              )
              .all(),
            tickets: database
              .prepare(
                isSingle
                  ? "SELECT id,note,binId FROM cs03_composition_tickets ORDER BY id"
                  : "SELECT id,note,binId FROM cs03_composition_compound_tickets ORDER BY id"
              )
              .all(),
            holders: database
              .prepare(
                isSingle
                  ? "SELECT id,lookup,label,shelfId FROM cs03_composition_holders ORDER BY id"
                  : "SELECT id,lookup,label,shelfTenant,shelfSerial FROM cs03_composition_compound_holders ORDER BY id"
              )
              .all(),
          };
        },
        afterStatement(database, completion) {
          const cuts: string[] = [];
          statementCount += 1;
          const statement = completion.sql
            .trim()
            .split(whitespace, 1)[0]!
            .toUpperCase();
          const isSelect = statement === "SELECT";
          const rootTable = isSingle
            ? "cs03_composition_shelves"
            : "cs03_composition_compound_shelves";
          const binTable = isSingle
            ? "cs03_composition_bins"
            : "cs03_composition_compound_bins";
          const holderTable = isSingle
            ? "cs03_composition_holders"
            : "cs03_composition_compound_holders";
          if (
            isSelect &&
            !rootCaptureObserved &&
            completion.sql.includes(rootTable) &&
            completion.sql.includes("ORDER BY") &&
            completion.rows.length === selectedCount
          ) {
            rootCaptureObserved = true;
            cuts.push(`capture:roots/${selectedCount}`);
          }
          if (
            isSelect &&
            binCapture < selectedCount &&
            completion.sql.includes(binTable) &&
            completion.sql.includes("ORDER BY") &&
            completion.rows.length === recipe.seriesWidth
          ) {
            cuts.push(
              `capture:bins/root-member/${binCapture}/${recipe.seriesWidth}`
            );
            binCapture += 1;
          }
          if (
            isSelect &&
            choiceObservation < selectedCount &&
            completion.sql.includes(holderTable) &&
            lookupWhere.test(completion.sql)
          ) {
            assert.equal(
              completion.rows.length,
              recipe.choice === "found" ? 1 : 0
            );
            cuts.push(
              `choice:${recipe.choice}/root-member/${choiceObservation}`
            );
            choiceObservation += 1;
          }

          const completedBinRows = database
            .prepare(
              isSingle
                ? "SELECT b.id FROM cs03_composition_bins b JOIN cs03_composition_tickets t ON t.binId=b.id WHERE b.label='touched' ORDER BY b.id"
                : "SELECT b.id FROM cs03_composition_compound_bins b JOIN cs03_composition_compound_tickets t ON t.binId=b.id WHERE b.label='touched' ORDER BY b.id"
            )
            .all();
          for (const row of completedBinRows) {
            assert(isRecord(row) && typeof row.id === "string");
            if (completedBins.has(row.id)) continue;
            const match = /^b(\d+)-(\d+)$/.exec(row.id);
            assert(match);
            completedBins.add(row.id);
            cuts.push(
              `effect:bin-member/${Number(match[1]) - 1}/${Number(match[2]) - 1}`
            );
          }

          const completedChoiceRows = database
            .prepare(
              isSingle
                ? `SELECT shelfId root FROM cs03_composition_holders WHERE label='${recipe.choice === "found" ? "found" : "created"}' ORDER BY shelfId`
                : `SELECT shelfSerial root FROM cs03_composition_compound_holders WHERE label='${recipe.choice === "found" ? "found" : "created"}' ORDER BY shelfSerial`
            )
            .all();
          for (const row of completedChoiceRows) {
            assert(isRecord(row));
            const root =
              typeof row.root === "string"
                ? Number(row.root.slice(1))
                : row.root;
            assert(typeof root === "number");
            if (completedChoices.has(root)) continue;
            completedChoices.add(root);
            cuts.push(
              `effect:choice-${recipe.choice}/root-member/${root - 1}`
            );
          }
          if (
            isSelect &&
            !terminalResultObserved &&
            completedChoices.size === selectedCount &&
            completion.sql.includes(rootTable) &&
            completion.sql.includes('"label" AS "label"')
          ) {
            terminalResultObserved = true;
            cuts.push("result:terminal-roots");
          }
          return cuts;
        },
        assert(observation) {
          const cuts = observation.reachedCuts;
          const roots = observation.final.roots;
          const bins = observation.final.bins;
          const tickets = observation.final.tickets;
          const holders = observation.final.holders;
          assert(roots, "CS-03 composition inspect must publish root rows");
          assert(bins, "CS-03 composition inspect must publish bin rows");
          assert(tickets, "CS-03 composition inspect must publish ticket rows");
          assert(holders, "CS-03 composition inspect must publish holder rows");
          assert.deepEqual(observation.outcome, {
            kind: "success",
            value: Array.from({ length: selectedCount }, () => ({
              label: "terminal",
            })),
          });
          if (recipe.limit === 0) {
            for (const admission of [
              "admit:bin-template/operation",
              "admit:holder-template/operation",
              "admit:choice-template/operation/0",
              "admit:choice-template/operation/1",
            ])
              assertScheduledCut(
                recipe.schedule,
                cuts,
                admission,
                "stop:limit-zero"
              );
            assert.deepEqual(observation.final, observation.initial);
            assert.equal(statementCount, 0);
            assert.equal(ticketAdmission, 1);
            assert.equal(holderLookupAdmissions, 2);
            assert.equal(holderAdmission, 1);
            return;
          }
          assert.deepEqual(
            roots,
            Array.from({ length: recipe.rootCount }, (_, index) => {
              const root = index + 1;
              return isSingle
                ? {
                    id: `s${root}`,
                    label: root <= selectedCount ? "terminal" : `root-${root}`,
                  }
                : {
                    tenant: "t",
                    serial: root,
                    label: root <= selectedCount ? "terminal" : `root-${root}`,
                  };
            })
          );
          assert.deepEqual(
            bins,
            Array.from({ length: recipe.rootCount }, (_, rootIndex) =>
              Array.from({ length: recipe.seriesWidth }, (_, binIndex) => {
                const root = rootIndex + 1;
                const bin = binIndex + 1;
                return isSingle
                  ? {
                      id: `b${root}-${bin}`,
                      label: root <= selectedCount ? "touched" : "initial",
                      shelfId: `s${root}`,
                    }
                  : {
                      id: `b${root}-${bin}`,
                      label: root <= selectedCount ? "touched" : "initial",
                      shelfTenant: "t",
                      shelfSerial: root,
                    };
              })
            ).flat()
          );
          assert.deepEqual(
            tickets,
            Array.from({ length: selectedCount }, (_, rootIndex) =>
              Array.from({ length: recipe.seriesWidth }, (_, binIndex) => ({
                id: `ticket-${1 + selectedCount + rootIndex * recipe.seriesWidth + binIndex}`,
                note: "created",
                binId: `b${rootIndex + 1}-${binIndex + 1}`,
              }))
            )
              .flat()
              .sort((left, right) => left.id.localeCompare(right.id))
          );
          assert.deepEqual(
            holders,
            recipe.choice === "found"
              ? Array.from({ length: recipe.rootCount }, (_, index) => {
                  const root = index + 1;
                  return isSingle
                    ? {
                        id: `h${root}`,
                        lookup: `holder-${root}`,
                        label: root <= selectedCount ? "found" : "initial",
                        shelfId: `s${root}`,
                      }
                    : {
                        id: `h${root}`,
                        lookup: `holder-${root}`,
                        label: root <= selectedCount ? "found" : "initial",
                        shelfTenant: "t",
                        shelfSerial: root,
                      };
                })
              : Array.from({ length: selectedCount }, (_, index) => {
                  const root = index + 1;
                  return isSingle
                    ? {
                        id: `holder-new-${root}`,
                        lookup: `missing-${root}`,
                        label: "created",
                        shelfId: `s${root}`,
                      }
                    : {
                        id: `holder-new-${root}`,
                        lookup: `missing-${root}`,
                        label: "created",
                        shelfTenant: "t",
                        shelfSerial: root,
                      };
                })
          );
          for (const admission of [
            "admit:bin-template/operation",
            "admit:holder-template/operation",
            "admit:choice-template/operation/0",
            "admit:choice-template/operation/1",
          ])
            assertScheduledCut(
              recipe.schedule,
              cuts,
              admission,
              `capture:roots/${selectedCount}`
            );
          assert.equal(
            ticketAdmission,
            1 + selectedCount * (1 + recipe.seriesWidth)
          );
          assert.equal(holderLookupAdmissions, 2 + selectedCount * 2);
          assert.equal(holderAdmission, 1 + selectedCount);
          for (let root = 0; root < selectedCount; root += 1) {
            for (const admission of [
              `admit:bin-template/root-member/${root}`,
              `admit:holder-template/root-member/${root}`,
              `admit:choice-template/root-member/${root}/0`,
              `admit:choice-template/root-member/${root}/1`,
            ]) {
              assertScheduledCut(
                recipe.schedule,
                cuts,
                `capture:roots/${selectedCount}`,
                admission
              );
              assertScheduledCut(
                recipe.schedule,
                cuts,
                admission,
                "effect:bin-member/0/0"
              );
            }
            const binCapture =
              `capture:bins/root-member/${root}/${recipe.seriesWidth}`;
            for (let bin = 0; bin < recipe.seriesWidth; bin += 1) {
              const admission = `admit:bin-member/${root}/${bin}`;
              const effect = `effect:bin-member/${root}/${bin}`;
              assertScheduledCut(recipe.schedule, cuts, binCapture, admission);
              assertScheduledCut(
                recipe.schedule,
                cuts,
                admission,
                `effect:bin-member/${root}/0`
              );
              if (bin + 1 < recipe.seriesWidth)
                assertScheduledCut(
                  recipe.schedule,
                  cuts,
                  effect,
                  `effect:bin-member/${root}/${bin + 1}`
                );
            }
            const lastBinEffect =
              `effect:bin-member/${root}/${recipe.seriesWidth - 1}`;
            const choice = `choice:${recipe.choice}/root-member/${root}`;
            const choiceEffect =
              `effect:choice-${recipe.choice}/root-member/${root}`;
            assertScheduledCut(
              recipe.schedule,
              cuts,
              lastBinEffect,
              choiceEffect
            );
            assertScheduledCut(recipe.schedule, cuts, choice, choiceEffect);
            if (root + 1 < selectedCount)
              assertScheduledCut(
                recipe.schedule,
                cuts,
                choiceEffect,
                `effect:bin-member/${root + 1}/0`
              );
            else
              assertScheduledCut(
                recipe.schedule,
                cuts,
                choiceEffect,
                "result:terminal-roots"
              );
          }
        },
      };
    },
  };
}
