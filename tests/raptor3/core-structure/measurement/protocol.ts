import { z } from "zod";

const identity = z.string().min(1).max(512);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const safeCount = z.number().int().nonnegative().safe();

export const structuralSizes: readonly [1, 2, 8, 32] = [1, 2, 8, 32];
export const measurementProfiles: readonly [
  "construction-only",
  "sqlite-interactive",
  "sqlite-atomic-batch",
] = [
  "construction-only",
  "sqlite-interactive",
  "sqlite-atomic-batch",
];

const eventEnvelope = {
  caseId: identity,
  analysisEpoch: identity,
  sequence: safeCount,
};
const event = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.strictObject({ ...eventEnvelope, ...shape });

export const measurementEventSchema = z.discriminatedUnion("kind", [
  event({
    kind: z.literal("occurrenceVisit"),
    occurrenceId: identity,
    phase: z.enum(["construct", "logical", "physical", "expand"]),
  }),
  event({
    kind: z.literal("readVisit"),
    occurrenceId: identity,
    readId: identity,
    revision: safeCount,
    activationId: identity,
  }),
  event({
    kind: z.literal("writeVisit"),
    occurrenceId: identity,
    writeId: identity,
    revision: safeCount,
    activationId: identity,
  }),
  event({
    kind: z.literal("overlapPair"),
    pairKey: z.string().min(1),
    readId: identity,
    readRevision: safeCount,
    writeId: identity,
    writeRevision: safeCount,
    activationId: identity,
    predicate: z.enum(["membership", "target"]),
    disposition: z.enum(["consumed", "publishedDeferred", "discarded"]),
  }),
  event({
    kind: z.literal("overlapAtom"),
    pairKey: z.string().min(1),
    component: identity,
    comparison: z.enum(["equal", "disjoint", "unknown"]),
  }),
  event({
    kind: z.literal("prefixRead"),
    consumerOccurrenceId: identity,
    prefixOccurrenceId: identity,
    prefixRevision: safeCount,
    purpose: z.enum(["comparison", "publication", "navigation"]),
  }),
  event({
    kind: z.literal("referenceCopy"),
    occurrenceId: identity,
    destination: identity,
    purpose: z.enum([
      "semanticPublication",
      "ancestorPrefix",
      "siblingPrefix",
      "suffixDetach",
      "suffixRestore",
    ]),
  }),
  event({
    kind: z.literal("ownerScanRead"),
    ownerOccurrenceId: identity,
    candidateOccurrenceId: identity,
  }),
]);

export type MeasurementEvent = z.infer<typeof measurementEventSchema>;
type WithoutEventEnvelope<Event> = Event extends unknown
  ? Omit<Event, "caseId" | "sequence">
  : never;
export type WorkEvent = WithoutEventEnvelope<MeasurementEvent>;

const workCounterShape = {
  occurrenceVisits: safeCount,
  constructionOccurrenceVisits: safeCount,
  logicalOccurrenceVisits: safeCount,
  physicalOccurrenceVisits: safeCount,
  expansionOccurrenceVisits: safeCount,
  readVisits: safeCount,
  writeVisits: safeCount,
  overlapPairChecks: safeCount,
  overlapAtomChecks: safeCount,
  necessaryDistinctOverlapPairs: safeCount,
  speculativeDistinctOverlapPairs: safeCount,
  redundantRepeatedOverlapPairs: safeCount,
  necessaryDistinctOverlapAtoms: safeCount,
  speculativeDistinctOverlapAtoms: safeCount,
  redundantRepeatedOverlapAtoms: safeCount,
  prefixReads: safeCount,
  distinctSemanticPrefixReads: safeCount,
  redundantRepeatedPrefixReads: safeCount,
  navigationPrefixReads: safeCount,
  referenceCopies: safeCount,
  semanticPublicationCopies: safeCount,
  ancestorPrefixCopies: safeCount,
  siblingPrefixCopies: safeCount,
  suffixDetachCopies: safeCount,
  suffixRestoreCopies: safeCount,
  ownerScanReads: safeCount,
};

export const workCountersSchema = z.strictObject(workCounterShape);
export type WorkCounters = z.infer<typeof workCountersSchema>;

const occurrenceInventorySchema = z.strictObject({
  occurrenceId: identity,
  commandId: identity,
  selectionId: identity.optional(),
});
const ownedFactSchema = z.strictObject({
  occurrenceId: identity,
});
const readInventorySchema = ownedFactSchema.extend({ readId: identity });
const writeInventorySchema = ownedFactSchema.extend({ writeId: identity });

function addDuplicateIssues(
  values: readonly string[],
  label: string,
  context: z.RefinementCtx
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value))
      context.addIssue({ code: "custom", message: `Duplicate ${label} '${value}'` });
    seen.add(value);
  }
}

export const semanticInventorySchema = z
  .strictObject({
    commandIds: z.array(identity),
    occurrences: z.array(occurrenceInventorySchema),
    selectionIds: z.array(identity),
    reads: z.array(readInventorySchema),
    writes: z.array(writeInventorySchema),
    activationIds: z.array(identity),
  })
  .superRefine((inventory, context) => {
    addDuplicateIssues(inventory.commandIds, "command identity", context);
    addDuplicateIssues(
      inventory.occurrences.map(({ occurrenceId }) => occurrenceId),
      "occurrence identity",
      context
    );
    addDuplicateIssues(inventory.selectionIds, "selection identity", context);
    addDuplicateIssues(
      inventory.reads.map(({ readId }) => readId),
      "read identity",
      context
    );
    addDuplicateIssues(
      inventory.writes.map(({ writeId }) => writeId),
      "write identity",
      context
    );
    addDuplicateIssues(inventory.activationIds, "activation identity", context);
    const commands = new Set(inventory.commandIds);
    const occurrences = new Set(
      inventory.occurrences.map(({ occurrenceId }) => occurrenceId)
    );
    const selections = new Set(inventory.selectionIds);
    for (const occurrence of inventory.occurrences) {
      if (!commands.has(occurrence.commandId))
        context.addIssue({
          code: "custom",
          message: `Occurrence '${occurrence.occurrenceId}' has an unknown command`,
        });
      if (occurrence.selectionId && !selections.has(occurrence.selectionId))
        context.addIssue({
          code: "custom",
          message: `Occurrence '${occurrence.occurrenceId}' has an unknown Selection`,
        });
    }
    for (const fact of [...inventory.reads, ...inventory.writes]) {
      if (!occurrences.has(fact.occurrenceId))
        context.addIssue({
          code: "custom",
          message: `Fact has an unknown occurrence '${fact.occurrenceId}'`,
        });
    }
  });
export type SemanticInventory = z.infer<typeof semanticInventorySchema>;

export const measurementCaseSchema = z.strictObject({
  caseId: identity,
  slice: z.enum(["structure", "a", "b", "composition"]),
  profile: z.enum(measurementProfiles),
  seed: safeCount.optional(),
  size: z
    .union([z.literal(1), z.literal(2), z.literal(8), z.literal(32)])
    .optional(),
  recipeSha256: sha256,
  scheduleSha256: sha256,
  semanticInventory: semanticInventorySchema,
  outcomeSha256: sha256,
  counters: workCountersSchema,
  eventCount: safeCount,
  eventsSha256: sha256,
});
export type MeasurementCase = z.infer<typeof measurementCaseSchema>;

export const measurementEventsFileSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    cases: z.array(
      z.strictObject({
        caseId: identity,
        events: z.array(measurementEventSchema),
      })
    ),
  })
  .superRefine((file, context) => {
    addDuplicateIssues(
      file.cases.map(({ caseId }) => caseId),
      "measurement case",
      context
    );
    for (const measurementCase of file.cases) {
      if (
        measurementCase.events.some(
          ({ caseId }) => caseId !== measurementCase.caseId
        )
      )
        context.addIssue({
          code: "custom",
          message: `Case '${measurementCase.caseId}' contains a foreign event`,
        });
    }
  });
export type MeasurementEventsFile = z.infer<
  typeof measurementEventsFileSchema
>;

const raptor3IdentitySchema = z.strictObject({
  production: sha256,
  harness: sha256,
  runtime: z.strictObject({
    node: z.string().min(1),
    platform: z.string().min(1),
    architecture: z.string().min(1),
    sqliteDriver: z.string().min(1),
    vitest: z.string().min(1),
  }),
});

export const measurementReceiptSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    qualifying: z.literal(true),
    alternative: z.enum([
      "flat-history-reference",
      "shared-occurrence-candidate",
    ]),
    mode: z.enum([
      "cs02-structure-measure",
      "cs03-a-measure",
      "cs03-b-measure",
      "cs03-composition-measure",
    ]),
    baseIdentity: raptor3IdentitySchema,
    instrumentedIdentity: raptor3IdentitySchema,
    instrumentationPatchFile: z.literal("instrumentation.patch"),
    instrumentationPatchSha256: sha256,
    counterContractSha256: sha256,
    profiles: z.array(z.enum(measurementProfiles)),
    firstSeed: safeCount.optional(),
    seedCount: z.literal(100).optional(),
    cases: z.array(measurementCaseSchema),
    eventsFileSha256: sha256,
    replays: safeCount,
    skipped: z.literal(0),
  })
  .superRefine((receipt, context) => {
    addDuplicateIssues(
      receipt.cases.map(({ caseId }) => caseId),
      "receipt case",
      context
    );
  });
export type MeasurementReceipt = z.infer<typeof measurementReceiptSchema>;

export function overlapPairKey(input: {
  analysisEpoch: string;
  readId: string;
  readRevision: number;
  writeId: string;
  writeRevision: number;
  activationId: string;
  predicate: "membership" | "target";
}): string {
  return JSON.stringify([
    input.analysisEpoch,
    input.readId,
    input.readRevision,
    input.writeId,
    input.writeRevision,
    input.activationId,
    input.predicate,
  ]);
}

export function semanticPrefixKey(
  event: Extract<MeasurementEvent, { kind: "prefixRead" }>
): string {
  return JSON.stringify([
    event.analysisEpoch,
    event.consumerOccurrenceId,
    event.prefixOccurrenceId,
    event.prefixRevision,
    event.purpose,
  ]);
}
