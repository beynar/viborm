import assert from "node:assert/strict";
import {
  type MeasurementEvent,
  measurementEventSchema,
  type SemanticInventory,
  semanticInventorySchema,
  type WorkEvent,
} from "./protocol";

class ObjectIdentities {
  private readonly byObject = new WeakMap<object, string>();
  private readonly byId = new Map<string, object>();

  bind(value: object, id: string, label: string): void {
    const previousId = this.byObject.get(value);
    const previousObject = this.byId.get(id);
    assert(
      previousId === undefined || previousId === id,
      `${label} object is already bound to '${previousId}'`
    );
    assert(
      previousObject === undefined || previousObject === value,
      `${label} identity '${id}' is already bound to another object`
    );
    this.byObject.set(value, id);
    this.byId.set(id, value);
  }

  alias(source: object, value: object, label: string): string {
    const id = this.get(source, label);
    this.aliasId(value, id, label);
    return id;
  }

  aliasId(value: object, id: string, label: string): void {
    assert(this.byId.has(id), `Unknown ${label} identity '${id}'`);
    const previousId = this.byObject.get(value);
    assert(
      previousId === undefined || previousId === id,
      `${label} object is already bound to '${previousId}'`
    );
    this.byObject.set(value, id);
  }

  get(value: object, label: string): string {
    const id = this.byObject.get(value);
    assert(id, `Unbound ${label} object`);
    return id;
  }

  find(value: object): string | undefined {
    return this.byObject.get(value);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  ids(): string[] {
    return [...this.byId.keys()].sort();
  }
}

interface OccurrenceBinding {
  occurrenceId: string;
  commandId: string;
  selectionId?: string;
}

interface OwnedFactBinding {
  id: string;
  occurrenceId: string;
}

/** Test-side bindings keep measurement identities out of production objects. */
export class SemanticInventoryBindings {
  private readonly commands = new ObjectIdentities();
  private readonly selections = new ObjectIdentities();
  private readonly occurrenceIds = new ObjectIdentities();
  private readonly occurrences = new Map<string, OccurrenceBinding>();
  private readonly readIds = new ObjectIdentities();
  private readonly reads = new Map<string, OwnedFactBinding>();
  private readonly writeIds = new ObjectIdentities();
  private readonly writes = new Map<string, OwnedFactBinding>();
  private readonly activations = new ObjectIdentities();
  private readonly activationStates = new WeakMap<
    object,
    Map<"unconditional" | "unobserved" | "found" | "missing", string>
  >();

  bindCommand(command: object, commandId: string): void {
    this.commands.bind(command, commandId, "Command");
  }

  bindSelection(selection: object, selectionId: string): void {
    this.selections.bind(selection, selectionId, "Selection");
  }

  bindOccurrence(
    occurrence: object,
    occurrenceId: string,
    command: object,
    selection?: object
  ): void {
    const commandId = this.commands.get(command, "command");
    const selectionId = selection
      ? this.selections.get(selection, "selection")
      : undefined;
    this.occurrenceIds.bind(occurrence, occurrenceId, "Occurrence");
    const binding = {
      occurrenceId,
      commandId,
      ...(selectionId && { selectionId }),
    };
    const previous = this.occurrences.get(occurrenceId);
    assert(
      previous === undefined ||
        (previous.commandId === commandId &&
          previous.selectionId === selectionId),
      `Occurrence identity '${occurrenceId}' changed meaning`
    );
    this.occurrences.set(occurrenceId, binding);
  }

  aliasOccurrence(source: object, occurrence: object): void {
    this.occurrenceIds.alias(source, occurrence, "Occurrence");
    const states = this.activationStates.get(source);
    if (states) this.activationStates.set(occurrence, states);
  }

  bindRead(read: object, readId: string, occurrence: object): void {
    this.bindFact(this.readIds, this.reads, read, readId, occurrence, "Read");
  }

  claimRead(read: object, occurrence: object): string {
    const readId = this.factId("read", occurrence);
    const existing = this.readIds.find(read);
    if (existing) {
      assert.equal(existing, readId, "Read object changed semantic identity");
      return existing;
    }
    const owner = this.reads.get(readId);
    if (owner) {
      assert.equal(
        owner.occurrenceId,
        this.occurrenceId(occurrence),
        "Read representation changed semantic owner"
      );
      this.readIds.aliasId(read, readId, "Read");
      return readId;
    }
    this.bindRead(read, readId, occurrence);
    return readId;
  }

  bindWrite(write: object, writeId: string, occurrence: object): void {
    this.bindFact(
      this.writeIds,
      this.writes,
      write,
      writeId,
      occurrence,
      "Write"
    );
  }

  claimWrite(write: object, occurrence: object): string {
    const writeId = this.factId("write", occurrence);
    const existing = this.writeIds.find(write);
    if (existing) {
      assert.equal(existing, writeId, "Write object changed semantic identity");
      return existing;
    }
    const owner = this.writes.get(writeId);
    if (owner) {
      assert.equal(
        owner.occurrenceId,
        this.occurrenceId(occurrence),
        "Write representation changed semantic owner"
      );
      this.writeIds.aliasId(write, writeId, "Write");
      return writeId;
    }
    this.bindWrite(write, writeId, occurrence);
    return writeId;
  }

  bindActivationState(
    occurrence: object,
    state: "unconditional" | "unobserved" | "found" | "missing",
    activationId: string
  ): void {
    this.occurrenceId(occurrence);
    const states = this.activationStates.get(occurrence) ?? new Map();
    const previous = states.get(state);
    assert(
      previous === undefined || previous === activationId,
      `Activation state '${state}' changed identity`
    );
    states.set(state, activationId);
    this.activationStates.set(occurrence, states);
    if (!this.activations.has(activationId))
      this.bindActivation({}, activationId);
  }

  activationStateId(
    occurrence: object,
    state: "unconditional" | "unobserved" | "found" | "missing"
  ): string {
    const activationId = this.activationStates.get(occurrence)?.get(state);
    assert(activationId, `Unbound '${state}' activation state`);
    return activationId;
  }

  commandId(command: object): string {
    return this.commands.get(command, "command");
  }

  selectionId(selection: object): string {
    return this.selections.get(selection, "selection");
  }

  occurrenceId(occurrence: object): string {
    return this.occurrenceIds.get(occurrence, "occurrence");
  }

  readId(read: object): string {
    return this.readIds.get(read, "read");
  }

  readOccurrenceId(read: object): string {
    const readId = this.readId(read);
    const occurrenceId = this.reads.get(readId)?.occurrenceId;
    assert(occurrenceId, "Read has no occurrence owner");
    return occurrenceId;
  }

  writeId(write: object): string {
    return this.writeIds.get(write, "write");
  }

  inventory(): SemanticInventory {
    return semanticInventorySchema.parse({
      commandIds: this.commands.ids(),
      occurrences: [...this.occurrences.values()].sort((left, right) =>
        left.occurrenceId.localeCompare(right.occurrenceId)
      ),
      selectionIds: this.selections.ids(),
      reads: [...this.reads.values()]
        .map(({ id: readId, occurrenceId }) => ({ readId, occurrenceId }))
        .sort((left, right) => left.readId.localeCompare(right.readId)),
      writes: [...this.writes.values()]
        .map(({ id: writeId, occurrenceId }) => ({ writeId, occurrenceId }))
        .sort((left, right) => left.writeId.localeCompare(right.writeId)),
      activationIds: this.activations.ids(),
    });
  }

  assertEvent(event: MeasurementEvent): void {
    const occurrence = (id: string) =>
      assert(this.occurrences.has(id), `Unknown occurrence '${id}'`);
    if (event.kind === "occurrenceVisit") occurrence(event.occurrenceId);
    else if (event.kind === "readVisit") {
      occurrence(event.occurrenceId);
      assert(this.readIds.has(event.readId), "Unknown read identity");
      assert.equal(
        this.reads.get(event.readId)?.occurrenceId,
        event.occurrenceId,
        "Read visit changed occurrence owner"
      );
      assert(this.activations.has(event.activationId), "Unknown activation");
    } else if (event.kind === "writeVisit") {
      occurrence(event.occurrenceId);
      assert(this.writeIds.has(event.writeId), "Unknown write identity");
      assert.equal(
        this.writes.get(event.writeId)?.occurrenceId,
        event.occurrenceId,
        "Write visit changed occurrence owner"
      );
      assert(this.activations.has(event.activationId), "Unknown activation");
    } else if (event.kind === "overlapPair") {
      assert(this.readIds.has(event.readId), "Unknown pair read");
      assert(this.writeIds.has(event.writeId), "Unknown pair write");
      assert(this.activations.has(event.activationId), "Unknown activation");
    } else if (event.kind === "prefixRead") {
      occurrence(event.consumerOccurrenceId);
      occurrence(event.prefixOccurrenceId);
    } else if (event.kind === "referenceCopy") occurrence(event.occurrenceId);
    else if (event.kind === "ownerScanRead") {
      occurrence(event.ownerOccurrenceId);
      occurrence(event.candidateOccurrenceId);
    }
  }

  private bindFact(
    identities: ObjectIdentities,
    facts: Map<string, OwnedFactBinding>,
    value: object,
    id: string,
    occurrence: object,
    label: string
  ): void {
    const occurrenceId = this.occurrenceId(occurrence);
    identities.bind(value, id, label);
    const previous = facts.get(id);
    assert(
      previous === undefined || previous.occurrenceId === occurrenceId,
      `${label} identity '${id}' changed owner`
    );
    facts.set(id, { id, occurrenceId });
  }

  private factId(kind: "read" | "write", occurrence: object): string {
    const occurrenceId = this.occurrenceId(occurrence);
    return `${kind}:${occurrenceId.slice("occurrence:".length)}`;
  }

  private bindActivation(activation: object, activationId: string): void {
    this.activations.bind(activation, activationId, "Activation");
  }
}

export interface StructuralMeasurementHooks {
  readonly identities: SemanticInventoryBindings;
  emit(event: WorkEvent): void;
  deferOccurrenceVisit(event: {
    readonly analysisEpoch: string;
    readonly occurrence: object;
    readonly phase: "construct";
  }): void;
  deferReferenceCopy(event: {
    readonly analysisEpoch: string;
    readonly occurrence: object;
    readonly destinationOccurrence: object;
    readonly purpose: "semanticPublication";
  }): void;
  bindCapturedMember(event: CapturedMemberBinding): void;
}

export interface CapturedMemberBinding {
  readonly parentOccurrence: object;
  readonly occurrence: object;
  readonly command: object;
  readonly selection?: object;
  readonly captureOrdinal: number;
}

export type CapturedMemberBinder = (
  event: CapturedMemberBinding,
  identities: SemanticInventoryBindings
) => void;

let activeHooks: StructuralMeasurementHooks | undefined;

/** Temporary source patches call this; ordinary builds have no active hook. */
export function structuralMeasurementHooks():
  | StructuralMeasurementHooks
  | undefined {
  return activeHooks;
}

export async function captureStructuralMeasurement<Value>(
  caseId: string,
  identities: SemanticInventoryBindings,
  run: () => Value | Promise<Value>,
  bindCapturedMember?: CapturedMemberBinder
): Promise<{
  value: Value;
  events: readonly MeasurementEvent[];
  semanticInventory: SemanticInventory;
}> {
  assert(!activeHooks, "Structural measurement must execute serially");
  const pending: Array<(bindings: SemanticInventoryBindings) => WorkEvent> = [];
  activeHooks = {
    identities,
    emit(workEvent) {
      pending.push(() => workEvent);
    },
    deferOccurrenceVisit(event) {
      const { analysisEpoch, occurrence, phase } = event;
      pending.push((bindings) => ({
        kind: "occurrenceVisit",
        analysisEpoch,
        occurrenceId: bindings.occurrenceId(occurrence),
        phase,
      }));
    },
    deferReferenceCopy(event) {
      const { analysisEpoch, occurrence, destinationOccurrence, purpose } =
        event;
      pending.push((bindings) => ({
        kind: "referenceCopy",
        analysisEpoch,
        occurrenceId: bindings.occurrenceId(occurrence),
        destination: `children:${bindings.occurrenceId(destinationOccurrence)}`,
        purpose,
      }));
    },
    bindCapturedMember(event) {
      assert(bindCapturedMember, "Captured-member binder is not installed");
      bindCapturedMember(event, identities);
    },
  };
  try {
    const value = await run();
    const events = pending.map((resolve, sequence) => {
      const event = measurementEventSchema.parse({
        ...resolve(identities),
        caseId,
        sequence,
      });
      identities.assertEvent(event);
      return event;
    });
    return { value, events, semanticInventory: identities.inventory() };
  } finally {
    activeHooks = undefined;
  }
}
