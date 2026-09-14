import assert from "node:assert/strict";
import {
  type MeasurementCase,
  type MeasurementEvent,
  measurementEventSchema,
  overlapPairKey,
  semanticPrefixKey,
  type WorkCounters,
  workCountersSchema,
} from "./protocol";

function emptyCounters(): WorkCounters {
  return {
    occurrenceVisits: 0,
    constructionOccurrenceVisits: 0,
    logicalOccurrenceVisits: 0,
    physicalOccurrenceVisits: 0,
    expansionOccurrenceVisits: 0,
    readVisits: 0,
    writeVisits: 0,
    overlapPairChecks: 0,
    overlapAtomChecks: 0,
    necessaryDistinctOverlapPairs: 0,
    speculativeDistinctOverlapPairs: 0,
    redundantRepeatedOverlapPairs: 0,
    necessaryDistinctOverlapAtoms: 0,
    speculativeDistinctOverlapAtoms: 0,
    redundantRepeatedOverlapAtoms: 0,
    prefixReads: 0,
    distinctSemanticPrefixReads: 0,
    redundantRepeatedPrefixReads: 0,
    navigationPrefixReads: 0,
    referenceCopies: 0,
    semanticPublicationCopies: 0,
    ancestorPrefixCopies: 0,
    siblingPrefixCopies: 0,
    suffixDetachCopies: 0,
    suffixRestoreCopies: 0,
    ownerScanReads: 0,
  };
}

function incrementOccurrencePhase(
  counters: WorkCounters,
  phase: Extract<MeasurementEvent, { kind: "occurrenceVisit" }>["phase"]
): void {
  counters.occurrenceVisits++;
  if (phase === "construct") counters.constructionOccurrenceVisits++;
  else if (phase === "logical") counters.logicalOccurrenceVisits++;
  else if (phase === "physical") counters.physicalOccurrenceVisits++;
  else counters.expansionOccurrenceVisits++;
}

function incrementCopyPurpose(
  counters: WorkCounters,
  purpose: Extract<MeasurementEvent, { kind: "referenceCopy" }>["purpose"]
): void {
  counters.referenceCopies++;
  if (purpose === "semanticPublication") counters.semanticPublicationCopies++;
  else if (purpose === "ancestorPrefix") counters.ancestorPrefixCopies++;
  else if (purpose === "siblingPrefix") counters.siblingPrefixCopies++;
  else if (purpose === "suffixDetach") counters.suffixDetachCopies++;
  else counters.suffixRestoreCopies++;
}

function classifyDistinctChecks(
  groups: ReadonlyMap<string, { count: number; necessary: boolean }>,
  counters: WorkCounters,
  kind: "pair" | "atom"
): void {
  for (const group of groups.values()) {
    if (kind === "pair") {
      if (group.necessary) counters.necessaryDistinctOverlapPairs++;
      else counters.speculativeDistinctOverlapPairs++;
      counters.redundantRepeatedOverlapPairs += group.count - 1;
    } else {
      if (group.necessary) counters.necessaryDistinctOverlapAtoms++;
      else counters.speculativeDistinctOverlapAtoms++;
      counters.redundantRepeatedOverlapAtoms += group.count - 1;
    }
  }
}

export function assertCounterPartitions(counters: WorkCounters): void {
  assert.equal(
    counters.occurrenceVisits,
    counters.constructionOccurrenceVisits +
      counters.logicalOccurrenceVisits +
      counters.physicalOccurrenceVisits +
      counters.expansionOccurrenceVisits,
    "Occurrence phase counters do not partition occurrence visits"
  );
  assert.equal(
    counters.overlapPairChecks,
    counters.necessaryDistinctOverlapPairs +
      counters.speculativeDistinctOverlapPairs +
      counters.redundantRepeatedOverlapPairs,
    "Overlap pair classes do not partition pair checks"
  );
  assert.equal(
    counters.overlapAtomChecks,
    counters.necessaryDistinctOverlapAtoms +
      counters.speculativeDistinctOverlapAtoms +
      counters.redundantRepeatedOverlapAtoms,
    "Overlap atom classes do not partition atom checks"
  );
  assert.equal(
    counters.prefixReads,
    counters.distinctSemanticPrefixReads +
      counters.redundantRepeatedPrefixReads +
      counters.navigationPrefixReads,
    "Prefix classes do not partition prefix reads"
  );
  assert.equal(
    counters.referenceCopies,
    counters.semanticPublicationCopies +
      counters.ancestorPrefixCopies +
      counters.siblingPrefixCopies +
      counters.suffixDetachCopies +
      counters.suffixRestoreCopies,
    "Copy purposes do not partition reference copies"
  );
  workCountersSchema.parse(counters);
}

export function reduceMeasurementEvents(
  caseId: string,
  events: readonly MeasurementEvent[]
): WorkCounters {
  const parsedEvents = measurementEventSchema.array().parse(events);
  const counters = emptyCounters();
  const pairs = new Map<string, { count: number; necessary: boolean }>();
  const atoms = new Map<string, { count: number; necessary: boolean }>();
  const atomCounts = new Map<string, Map<string, number>>();
  const semanticPrefixes = new Set<string>();

  for (const [sequence, event] of parsedEvents.entries()) {
    assert.equal(event.caseId, caseId, "Event belongs to another case");
    assert.equal(event.sequence, sequence, "Event sequence is not contiguous");
    if (event.kind === "occurrenceVisit") {
      incrementOccurrencePhase(counters, event.phase);
    } else if (event.kind === "readVisit") {
      counters.readVisits++;
    } else if (event.kind === "writeVisit") {
      counters.writeVisits++;
    } else if (event.kind === "overlapPair") {
      counters.overlapPairChecks++;
      assert.equal(
        event.pairKey,
        overlapPairKey(event),
        "Overlap pair key does not match its semantic identity"
      );
      const previous = pairs.get(event.pairKey);
      const necessary = event.disposition !== "discarded";
      pairs.set(event.pairKey, {
        count: (previous?.count ?? 0) + 1,
        necessary: (previous?.necessary ?? false) || necessary,
      });
    } else if (event.kind === "overlapAtom") {
      counters.overlapAtomChecks++;
      const components = atomCounts.get(event.pairKey) ?? new Map();
      components.set(event.component, (components.get(event.component) ?? 0) + 1);
      atomCounts.set(event.pairKey, components);
    } else if (event.kind === "prefixRead") {
      counters.prefixReads++;
      if (event.purpose === "navigation") counters.navigationPrefixReads++;
      else {
        const key = semanticPrefixKey(event);
        if (semanticPrefixes.has(key)) counters.redundantRepeatedPrefixReads++;
        else {
          semanticPrefixes.add(key);
          counters.distinctSemanticPrefixReads++;
        }
      }
    } else if (event.kind === "referenceCopy") {
      incrementCopyPurpose(counters, event.purpose);
    } else counters.ownerScanReads++;
  }

  for (const [pairKey, components] of atomCounts) {
    const pair = pairs.get(pairKey);
    assert(pair, "Overlap atom has no matching pair check");
    for (const [component, count] of components) {
      atoms.set(JSON.stringify([pairKey, component]), {
        count,
        necessary: pair.necessary,
      });
    }
  }
  classifyDistinctChecks(pairs, counters, "pair");
  classifyDistinctChecks(atoms, counters, "atom");
  assertCounterPartitions(counters);
  return counters;
}

export function assertMeasurementCaseReduction(
  measurementCase: MeasurementCase,
  events: readonly MeasurementEvent[]
): void {
  assert.equal(
    measurementCase.eventCount,
    events.length,
    "Measurement case event count does not match its raw events"
  );
  assert.deepEqual(
    measurementCase.counters,
    reduceMeasurementEvents(measurementCase.caseId, events),
    "Measurement case counters do not match their raw-event reduction"
  );
}
