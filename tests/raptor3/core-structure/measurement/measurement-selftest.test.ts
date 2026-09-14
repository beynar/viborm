import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  captureStructuralMeasurement,
  SemanticInventoryBindings,
  structuralMeasurementHooks,
} from "./hooks";
import {
  measurementCaseSchema,
  measurementEventSchema,
  overlapPairKey,
  structuralSizes,
} from "./protocol";
import {
  assertMeasurementCaseReduction,
  reduceMeasurementEvents,
} from "./reducer";
import { structuralMeasurementRecipes } from "./structural-recipes";

describe("CS-02 structural work protocol", () => {
  it("binds one semantic occurrence across recipe and runtime representations", () => {
    const identities = new SemanticInventoryBindings();
    const command = {};
    const recipeOccurrence = {};
    const runtimeOccurrence = {};
    const recipeWrite = {};
    const runtimeWrite = {};
    identities.bindCommand(command, "command:root");
    identities.bindOccurrence(recipeOccurrence, "occurrence:root", command);
    identities.bindWrite(recipeWrite, "write:root", recipeOccurrence);
    identities.bindActivationState(
      recipeOccurrence,
      "unconditional",
      "activation:root"
    );

    identities.aliasOccurrence(recipeOccurrence, runtimeOccurrence);

    assert.equal(identities.occurrenceId(runtimeOccurrence), "occurrence:root");
    assert.equal(
      identities.activationStateId(runtimeOccurrence, "unconditional"),
      "activation:root"
    );
    assert.equal(
      identities.claimWrite(runtimeWrite, runtimeOccurrence),
      "write:root"
    );
  });

  it("reduces emitted work by semantic identity, activation, and actual copy", async () => {
    const identities = new SemanticInventoryBindings();
    const command = {};
    const selection = {};
    const firstOccurrence = {};
    const secondOccurrence = {};
    const capturedCommand = {};
    const capturedOccurrence = {};
    const read = {};
    const write = {};
    identities.bindCommand(command, "command:shared");
    identities.bindSelection(selection, "selection:shared");
    identities.bindOccurrence(
      firstOccurrence,
      "occurrence:first",
      command,
      selection
    );
    identities.bindOccurrence(
      secondOccurrence,
      "occurrence:second",
      command,
      selection
    );
    identities.bindRead(read, "read:membership", firstOccurrence);
    identities.bindWrite(write, "write:membership", secondOccurrence);
    identities.bindActivationState(
      firstOccurrence,
      "found",
      "activation:found"
    );
    const predicate: "membership" = "membership";
    const pair = {
      analysisEpoch: "epoch:initial",
      readId: identities.readId(read),
      readRevision: 0,
      writeId: identities.writeId(write),
      writeRevision: 0,
      activationId: identities.activationStateId(firstOccurrence, "found"),
      predicate,
    };
    const pairKey = overlapPairKey(pair);

    const captured = await captureStructuralMeasurement(
      "structure/self-test",
      identities,
      () => {
        const hooks = structuralMeasurementHooks();
        assert(hooks);
        hooks.deferOccurrenceVisit({
          analysisEpoch: "epoch:initial",
          occurrence: firstOccurrence,
          phase: "construct",
        });
        hooks.deferReferenceCopy({
          analysisEpoch: "epoch:initial",
          occurrence: capturedOccurrence,
          destinationOccurrence: secondOccurrence,
          purpose: "semanticPublication",
        });
        hooks.emit({
          kind: "occurrenceVisit",
          analysisEpoch: "epoch:initial",
          occurrenceId: identities.occurrenceId(secondOccurrence),
          phase: "construct",
        });
        hooks.emit({
          kind: "occurrenceVisit",
          analysisEpoch: "epoch:initial",
          occurrenceId: identities.occurrenceId(firstOccurrence),
          phase: "logical",
        });
        hooks.emit({
          kind: "occurrenceVisit",
          analysisEpoch: "epoch:initial",
          occurrenceId: identities.occurrenceId(secondOccurrence),
          phase: "physical",
        });
        hooks.bindCapturedMember({
          parentOccurrence: firstOccurrence,
          occurrence: capturedOccurrence,
          command: capturedCommand,
          selection,
          captureOrdinal: 0,
        });
        hooks.emit({
          kind: "occurrenceVisit",
          analysisEpoch: "epoch:series/0",
          occurrenceId: identities.occurrenceId(capturedOccurrence),
          phase: "expand",
        });
        hooks.emit({
          kind: "readVisit",
          analysisEpoch: "epoch:initial",
          occurrenceId: identities.occurrenceId(firstOccurrence),
          readId: identities.readId(read),
          revision: 0,
          activationId: identities.activationStateId(firstOccurrence, "found"),
        });
        hooks.emit({
          kind: "writeVisit",
          analysisEpoch: "epoch:initial",
          occurrenceId: identities.occurrenceId(secondOccurrence),
          writeId: identities.writeId(write),
          revision: 0,
          activationId: identities.activationStateId(firstOccurrence, "found"),
        });
        const dispositions: readonly ("consumed" | "discarded")[] = [
          "consumed",
          "discarded",
        ];
        for (const disposition of dispositions) {
          hooks.emit({
            kind: "overlapPair",
            ...pair,
            pairKey,
            disposition,
          });
          hooks.emit({
            kind: "overlapAtom",
            analysisEpoch: "epoch:initial",
            pairKey,
            component: "pa",
            comparison: "equal",
          });
        }
        const resumedPair = {
          ...pair,
          analysisEpoch: "epoch:series/0",
        };
        hooks.emit({
          kind: "occurrenceVisit",
          analysisEpoch: resumedPair.analysisEpoch,
          occurrenceId: identities.occurrenceId(secondOccurrence),
          phase: "expand",
        });
        hooks.emit({
          kind: "overlapPair",
          ...resumedPair,
          pairKey: overlapPairKey(resumedPair),
          disposition: "consumed",
        });
        hooks.emit({
          kind: "overlapAtom",
          analysisEpoch: resumedPair.analysisEpoch,
          pairKey: overlapPairKey(resumedPair),
          component: "pa",
          comparison: "equal",
        });
        const prefixPurposes: readonly ("comparison" | "navigation")[] = [
          "comparison",
          "comparison",
          "navigation",
        ];
        for (const purpose of prefixPurposes) {
          hooks.emit({
            kind: "prefixRead",
            analysisEpoch: "epoch:initial",
            consumerOccurrenceId: identities.occurrenceId(firstOccurrence),
            prefixOccurrenceId: identities.occurrenceId(secondOccurrence),
            prefixRevision: 0,
            purpose,
          });
        }
        hooks.emit({
          kind: "prefixRead",
          analysisEpoch: "epoch:series/0",
          consumerOccurrenceId: identities.occurrenceId(firstOccurrence),
          prefixOccurrenceId: identities.occurrenceId(secondOccurrence),
          prefixRevision: 0,
          purpose: "comparison",
        });
        const copyPurposes: readonly (
          | "semanticPublication"
          | "ancestorPrefix"
          | "siblingPrefix"
          | "suffixDetach"
          | "suffixRestore"
        )[] = [
          "semanticPublication",
          "ancestorPrefix",
          "siblingPrefix",
          "suffixDetach",
          "suffixRestore",
        ];
        for (const purpose of copyPurposes) {
          hooks.emit({
            kind: "referenceCopy",
            analysisEpoch: "epoch:initial",
            occurrenceId: identities.occurrenceId(secondOccurrence),
            destination: `destination:${purpose}`,
            purpose,
          });
        }
        hooks.emit({
          kind: "ownerScanRead",
          analysisEpoch: "epoch:initial",
          ownerOccurrenceId: identities.occurrenceId(firstOccurrence),
          candidateOccurrenceId: identities.occurrenceId(secondOccurrence),
        });
      },
      (event, bindings) => {
        assert.equal(event.captureOrdinal, 0);
        const occurrenceId = `${bindings.occurrenceId(event.parentOccurrence)}/member/0`;
        bindings.bindCommand(event.command, "command:captured-member");
        bindings.bindOccurrence(
          event.occurrence,
          occurrenceId,
          event.command,
          event.selection
        );
      }
    );

    assert.equal(captured.semanticInventory.commandIds.length, 2);
    assert.equal(captured.semanticInventory.occurrences.length, 3);
    assert.equal(captured.semanticInventory.selectionIds.length, 1);
    assert.deepEqual(captured.events[1], {
      kind: "referenceCopy",
      caseId: "structure/self-test",
      analysisEpoch: "epoch:initial",
      sequence: 1,
      occurrenceId: "occurrence:first/member/0",
      destination: "children:occurrence:second",
      purpose: "semanticPublication",
    });
    const counters = reduceMeasurementEvents(
      "structure/self-test",
      captured.events
    );
    assert.deepEqual(counters, {
      occurrenceVisits: 6,
      constructionOccurrenceVisits: 2,
      logicalOccurrenceVisits: 1,
      physicalOccurrenceVisits: 1,
      expansionOccurrenceVisits: 2,
      readVisits: 1,
      writeVisits: 1,
      overlapPairChecks: 3,
      overlapAtomChecks: 3,
      necessaryDistinctOverlapPairs: 2,
      speculativeDistinctOverlapPairs: 0,
      redundantRepeatedOverlapPairs: 1,
      necessaryDistinctOverlapAtoms: 2,
      speculativeDistinctOverlapAtoms: 0,
      redundantRepeatedOverlapAtoms: 1,
      prefixReads: 4,
      distinctSemanticPrefixReads: 2,
      redundantRepeatedPrefixReads: 1,
      navigationPrefixReads: 1,
      referenceCopies: 6,
      semanticPublicationCopies: 2,
      ancestorPrefixCopies: 1,
      siblingPrefixCopies: 1,
      suffixDetachCopies: 1,
      suffixRestoreCopies: 1,
      ownerScanReads: 1,
    });
    const digest = "0".repeat(64);
    const measurementCase = measurementCaseSchema.parse({
      caseId: "structure/self-test",
      slice: "structure",
      profile: "sqlite-interactive",
      recipeSha256: digest,
      scheduleSha256: digest,
      semanticInventory: captured.semanticInventory,
      outcomeSha256: digest,
      counters,
      eventCount: captured.events.length,
      eventsSha256: digest,
    });
    assertMeasurementCaseReduction(measurementCase, captured.events);
    assert.throws(() =>
      assertMeasurementCaseReduction(
        { ...measurementCase, eventCount: measurementCase.eventCount + 1 },
        captured.events
      )
    );
  });

  it("refuses malformed events instead of normalizing them", () => {
    assert.throws(() =>
      measurementEventSchema.parse({
        kind: "occurrenceVisit",
        caseId: "structure/malformed",
        analysisEpoch: "epoch:initial",
        sequence: 0,
        occurrenceId: "occurrence:root",
        phase: "logical",
        extra: true,
      })
    );
    assert.throws(() =>
      reduceMeasurementEvents("structure/malformed", [
        {
          kind: "overlapPair",
          caseId: "structure/malformed",
          analysisEpoch: "epoch:initial",
          sequence: 0,
          pairKey: "fabricated",
          readId: "read:one",
          readRevision: 0,
          writeId: "write:one",
          writeRevision: 0,
          activationId: "activation:one",
          predicate: "membership",
          disposition: "consumed",
        },
      ])
    );
  });
});

describe("CS-02 structural measurement recipes", () => {
  const recipes = structuralMeasurementRecipes();

  it("freezes the 28-case structural matrix without runtime count formulas", () => {
    assert.equal(recipes.length, 28);
    for (const recipe of recipes) {
      const { semanticInventory } = recipe;
      assert.deepEqual(
        semanticInventory.commandIds,
        [...semanticInventory.commandIds].sort()
      );
      assert.deepEqual(
        semanticInventory.occurrences.map(({ occurrenceId }) => occurrenceId),
        semanticInventory.occurrences
          .map(({ occurrenceId }) => occurrenceId)
          .sort((left, right) => left.localeCompare(right))
      );
      assert.deepEqual(
        semanticInventory.reads.map(({ readId }) => readId),
        semanticInventory.reads
          .map(({ readId }) => readId)
          .sort((left, right) => left.localeCompare(right))
      );
      assert.deepEqual(
        semanticInventory.writes.map(({ writeId }) => writeId),
        semanticInventory.writes
          .map(({ writeId }) => writeId)
          .sort((left, right) => left.localeCompare(right))
      );
      assert.deepEqual(
        semanticInventory.selectionIds,
        [...semanticInventory.selectionIds].sort()
      );
      assert.deepEqual(
        semanticInventory.activationIds,
        [...semanticInventory.activationIds].sort()
      );
    }
    assert.deepEqual(
      [...new Set(recipes.map(({ size }) => size))].sort(
        (left, right) => left - right
      ),
      structuralSizes
    );
    assert.equal(
      recipes.filter(({ kind }) => kind === "depth-create").length,
      4
    );
    assert.equal(
      recipes.filter(({ kind }) => kind === "width-create").length,
      4
    );
    assert.equal(
      recipes.filter(({ kind }) => kind === "width-overlap").length,
      4
    );
    assert.equal(
      recipes.filter(({ kind }) => kind.startsWith("series-choice-")).length,
      16
    );
  });

  it("pins depth and width public inputs to independent logical-order oracles", () => {
    const depth = recipes.find(
      (recipe) => recipe.kind === "depth-create" && recipe.size === 32
    );
    const width = recipes.find(
      (recipe) => recipe.kind === "width-create" && recipe.size === 32
    );
    assert(depth?.kind === "depth-create");
    assert(width?.kind === "width-create");
    assert.equal(depth.oracle.logicalOrder.length, 33);
    assert.equal(width.oracle.logicalOrder.length, 33);
    assert.equal(width.data.children?.create.length, 32);
    let node = depth.data;
    for (let level = 0; level < 32; level++) {
      assert.equal(node.children?.create.length, 1);
      const child = node.children?.create[0];
      assert(child);
      node = child;
    }
    assert.equal(node.children, undefined);
  });

  it("pins only real compound-membership equality, never an expected scan total", () => {
    const overlap = recipes.find(
      (recipe) => recipe.kind === "width-overlap" && recipe.size === 8
    );
    assert(overlap?.kind === "width-overlap");
    assert.deepEqual(overlap.keyFields, ["pa", "pb"]);
    assert.equal(overlap.oracle.positivePairs.length, 8);
    for (const [index, pair] of overlap.oracle.positivePairs.entries()) {
      const reader = overlap.readers[index];
      const writer = overlap.writers[index];
      assert(reader);
      assert(writer);
      assert.equal(pair.readId, reader.readerId);
      assert.equal(pair.writeId, writer.writerId);
      assert.deepEqual(reader.selector, writer.selector);
      assert.deepEqual(writer.selector, { slug: `kid-${index}` });
    }
    const readerOccurrence = overlap.semanticInventory.occurrences.find(
      ({ occurrenceId }) => occurrenceId.endsWith("root/reader/0")
    );
    const templateOccurrence = overlap.semanticInventory.occurrences.find(
      ({ occurrenceId }) => occurrenceId.endsWith("root/reader/0/template")
    );
    const captureOccurrence = overlap.semanticInventory.occurrences.find(
      ({ occurrenceId }) => occurrenceId.endsWith("root/reader/0/capture")
    );
    assert(readerOccurrence?.selectionId);
    assert.equal(templateOccurrence?.selectionId, readerOccurrence.selectionId);
    assert(captureOccurrence);
    assert.equal(captureOccurrence.selectionId, undefined);
    assert.equal(
      overlap.semanticInventory.reads.some(
        ({ occurrenceId }) => occurrenceId === captureOccurrence.occurrenceId
      ),
      false
    );
    assert.equal(
      overlap.semanticInventory.writes.some(
        ({ occurrenceId }) => occurrenceId === captureOccurrence.occurrenceId
      ),
      false
    );
    assert(
      overlap.semanticInventory.writes.some(
        ({ occurrenceId }) => occurrenceId === templateOccurrence?.occurrenceId
      )
    );
    assert.equal("overlapPairChecks" in overlap.oracle, false);
  });

  it("pins branch activation priority after every selected member is admitted", () => {
    const profiles: readonly ("sqlite-interactive" | "sqlite-atomic-batch")[] =
      ["sqlite-interactive", "sqlite-atomic-batch"];
    for (const profile of profiles) {
      const foundTie = recipes.find(
        (recipe) =>
          recipe.kind === "series-choice-found" &&
          recipe.size === 1 &&
          recipe.profile === profile
      );
      const found = recipes.find(
        (recipe) =>
          recipe.kind === "series-choice-found" &&
          recipe.size === 8 &&
          recipe.profile === profile
      );
      const missing = recipes.find(
        (recipe) =>
          recipe.kind === "series-choice-missing" &&
          recipe.size === 8 &&
          recipe.profile === profile
      );
      assert(foundTie?.kind === "series-choice-found");
      assert(found?.kind === "series-choice-found");
      assert(missing?.kind === "series-choice-missing");
      assert.deepEqual(foundTie.oracle.memberPath, [0]);
      assert.equal(foundTie.oracle.relation, "earlyTicket");
      assert.deepEqual(found.oracle.memberPath, [0]);
      assert.equal(found.oracle.relation, "lateTicket");
      assert.deepEqual(missing.oracle.memberPath, [7]);
      assert.equal(missing.oracle.relation, "earlyTicket");
      for (const recipe of [found, missing]) {
        assert.equal(
          recipe.schedule.filter((step) => step.startsWith("admit:")).length,
          8
        );
        assert(recipe.schedule.at(-1)?.startsWith("fail:member/"));
        const reusedSelections = new Map<string, number>();
        for (const occurrence of recipe.semanticInventory.occurrences) {
          if (!occurrence.selectionId) continue;
          reusedSelections.set(
            occurrence.selectionId,
            (reusedSelections.get(occurrence.selectionId) ?? 0) + 1
          );
        }
        assert(
          [...reusedSelections.values()].some((occurrences) => occurrences > 1),
          "Selection identity must remain distinct from occurrence identity"
        );
        const occurrenceAt = (path: string) =>
          recipe.semanticInventory.occurrences.find(({ occurrenceId }) =>
            occurrenceId.endsWith(path)
          );
        const series = occurrenceAt("root/series");
        const capture = occurrenceAt("root/series/capture");
        const template = occurrenceAt("root/series/template");
        assert(series?.selectionId);
        assert(capture);
        assert(template?.selectionId);
        assert.equal(capture.selectionId, undefined);
        assert.equal(template.selectionId, series.selectionId);
        assert.equal(
          recipe.semanticInventory.reads.some(
            ({ occurrenceId }) => occurrenceId === capture.occurrenceId
          ),
          false
        );
        assert.equal(
          recipe.semanticInventory.writes.some(
            ({ occurrenceId }) => occurrenceId === capture.occurrenceId
          ),
          false
        );
        assert(
          recipe.semanticInventory.writes.some(
            ({ occurrenceId }) => occurrenceId === template.occurrenceId
          )
        );
        const memberSelectionIds = Array.from(
          { length: recipe.size },
          (_, index) => {
            const member = occurrenceAt(`root/series/member/${index}`);
            assert(member?.selectionId);
            assert(
              recipe.semanticInventory.writes.some(
                ({ occurrenceId }) => occurrenceId === member.occurrenceId
              )
            );
            return member.selectionId;
          }
        );
        assert.equal(new Set(memberSelectionIds).size, recipe.size);
        assert.equal(memberSelectionIds.includes(series.selectionId), false);
        for (const armPath of [
          "root/choice/early/found",
          "root/choice/late/found",
          "root/choice/late/missing",
        ]) {
          const arm = recipe.semanticInventory.occurrences.find(
            ({ occurrenceId }) => occurrenceId.endsWith(armPath)
          );
          assert(arm);
          assert(
            recipe.semanticInventory.writes.some(
              ({ occurrenceId }) => occurrenceId === arm.occurrenceId
            )
          );
        }
        assert.equal(
          occurrenceAt("root/choice/early/found")?.selectionId,
          occurrenceAt("root/choice/early")?.selectionId
        );
        assert.equal(
          occurrenceAt("root/choice/late/found")?.selectionId,
          occurrenceAt("root/choice/late")?.selectionId
        );
        assert.equal(
          occurrenceAt("root/choice/late/missing")?.selectionId,
          undefined
        );
        for (const innerPath of [
          "root/choice/early/found/earlyTicket/connect",
          "root/choice/late/found/lateTicket/connect",
        ]) {
          const inner = occurrenceAt(innerPath);
          assert(inner?.selectionId);
          assert.notEqual(
            inner.selectionId,
            occurrenceAt(
              innerPath.includes("earlyTicket")
                ? "root/choice/early"
                : "root/choice/late"
            )?.selectionId
          );
          assert(
            recipe.semanticInventory.reads.some(
              ({ occurrenceId }) => occurrenceId === inner.occurrenceId
            )
          );
          assert(
            recipe.semanticInventory.writes.some(
              ({ occurrenceId }) => occurrenceId === inner.occurrenceId
            )
          );
        }
        for (const choice of ["early", "late"]) {
          assert(
            recipe.semanticInventory.activationIds.some((activationId) =>
              activationId.endsWith(
                `root/choice/${choice}/attempt/0/observation/${choice === "early" ? 0 : 1}/unobserved`
              )
            )
          );
        }
      }
    }
  });
});
