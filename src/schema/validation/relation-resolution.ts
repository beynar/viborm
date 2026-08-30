/**
 * The one schema-wide relation topology owner (plan §6).
 *
 * A declaration states two facts: the slot cardinality its factory was spelled
 * with, and the target domain its argument names. Everything else about an edge
 * — who its partner is, which endpoint owns the foreign key, whether storage is
 * a row reference or a junction, whether that storage is unique, whether a
 * singular slot may be empty — is derived HERE, once per schema, from the whole
 * graph. Nothing downstream rescans for an inverse.
 *
 * The gate publishes a complete trusted index or a list of
 * `SchemaValidationIssue`s. There is no partial index and no `unresolved` arm: a
 * consumer holding an index holds a graph whose every physical fact the FK,
 * variant-storage and junction subowners invoked here have already proven.
 *
 * PAIRING IS A GRAPH, NOT A LADDER. Candidates are collected structurally, then
 * partitioned by the exact relation-name claim, then counted. No candidate wins
 * by being ordinary, variant, first, or sole.
 */

import { findReferenceableKey, getModelKeyCatalog, type Model } from "../model";
import {
  type JunctionOverrideView,
  JunctionPhysicalNameError,
  resolveOrdinaryJunctionNames,
} from "../relation/helpers";
import {
  type ResolvedJunctionTopology,
  resolveJunctionTopology,
} from "../relation/junction-topology";
import type { PolymorphicStorageColumn } from "../relation/polymorphic";
import type {
  AnyRelation,
  JunctionReferentialAction,
  ReferentialAction,
  RelationCardinality,
  RelationSlot,
  RelationState,
  VariantManyEntry,
  VariantOneEntry,
} from "../relation/types";
import { thrownAsError } from "./error";
import { checkStoredReference } from "./rules/fk";
import { getScalars } from "./rules/model-members";
import {
  checkVariantMemberJunctions,
  checkVariantRowStorage,
  collectReservedPhysicalNames,
  planVariantMemberNames,
  type StoredReferenceFact,
  variantRowIndexName,
} from "./rules/polymorphic";
import type { Schema, SchemaValidationIssue, ValidationContext } from "./types";

// =============================================================================
// TRUSTED FORMS (§6.6)
// =============================================================================

export type ResolvedVariantRowStorage = {
  readonly typeColumn: PolymorphicStorageColumn;
  readonly idColumn: PolymorphicStorageColumn;
  readonly indexName: string;
};

/** The exact normalized entry, narrowed to what physical storage may read. */
export type ResolvedVariantStorageIdentity = {
  readonly storedValue: string;
};

export type ResolvedVariantRowMember = {
  readonly variant: string;
  readonly entry: ResolvedVariantStorageIdentity;
  readonly targetModel: Model<any>;
  readonly referencedField: string;
  readonly inverse?: RelationSlot;
};

export type ResolvedVariantJunctionMember = {
  readonly variant: string;
  readonly entry: ResolvedVariantStorageIdentity;
  readonly inverse?: RelationSlot;
  /** A singular bound inverse makes this member's target side unique. */
  readonly uniqueTarget: boolean;
  readonly topology: ResolvedJunctionTopology;
};

export type ResolvedStoredReference = {
  readonly members: readonly [
    {
      readonly foreignField: string;
      readonly referencedField: string;
    },
    ...{
      readonly foreignField: string;
      readonly referencedField: string;
    }[],
  ];
  readonly onDelete?: ReferentialAction;
  readonly onUpdate?: ReferentialAction;
};

export type ResolvedRelationEdge =
  | {
      readonly kind: "foreignKey";
      readonly endpoints: readonly [RelationSlot, RelationSlot];
      readonly owner: RelationSlot;
      readonly reference: ResolvedStoredReference;
      readonly unique: boolean;
    }
  | {
      readonly kind: "junction";
      readonly endpoints: readonly [RelationSlot, RelationSlot];
      readonly topology: ResolvedJunctionTopology;
      readonly onDelete?: JunctionReferentialAction;
      readonly onUpdate?: JunctionReferentialAction;
    }
  | {
      readonly kind: "variantRowCarrier";
      readonly carrier: RelationSlot;
      readonly members: readonly [
        ResolvedVariantRowMember,
        ...ResolvedVariantRowMember[],
      ];
      readonly uniqueTarget: boolean;
      readonly storage: ResolvedVariantRowStorage;
    }
  | {
      readonly kind: "variantJunctionCarrier";
      readonly carrier: RelationSlot;
      readonly members: readonly [
        ResolvedVariantJunctionMember,
        ...ResolvedVariantJunctionMember[],
      ];
    };

export type ResolvedVariantRowEdge = Extract<
  ResolvedRelationEdge,
  { readonly kind: "variantRowCarrier" }
>;

export type ResolvedVariantJunctionEdge = Extract<
  ResolvedRelationEdge,
  { readonly kind: "variantJunctionCarrier" }
>;

export type ResolvedVariantEdge =
  | ResolvedVariantRowEdge
  | ResolvedVariantJunctionEdge;

/** The two model-target edge forms, the only ones an ordinary slot resolves to. */
export type ResolvedOrdinaryEdge = Exclude<
  ResolvedRelationEdge,
  ResolvedVariantEdge
>;

export type ResolvedSlot =
  | {
      readonly slot: RelationSlot;
      readonly edge: Exclude<ResolvedRelationEdge, ResolvedVariantEdge>;
      readonly member?: never;
    }
  | {
      /** The public carrier slot spans the edge's complete member collection. */
      readonly slot: RelationSlot;
      readonly edge: ResolvedVariantEdge;
      readonly member?: never;
    }
  | {
      /** An ordinary inverse is a view of exactly one existing member record. */
      readonly slot: RelationSlot;
      readonly edge: ResolvedVariantRowEdge;
      readonly member: ResolvedVariantRowEdge["members"][number];
    }
  | {
      readonly slot: RelationSlot;
      readonly edge: ResolvedVariantJunctionEdge;
      readonly member: ResolvedVariantJunctionEdge["members"][number];
    };

export type ResolvedRelationIndex = ReadonlyMap<
  Model<any>,
  ReadonlyMap<string, ResolvedSlot>
>;

/**
 * The trusted index XOR the reasons there is none.
 *
 * `issues` is present on BOTH arms and means the same thing on each: everything
 * the gate has to say about this schema. On the successful arm it can only hold
 * WARNINGS — one error is what makes the arm unsuccessful — and dropping them
 * there would silently lose every advisory the subowners produce about a schema
 * that happens to be valid, which is most of them.
 */
export type RelationResolution =
  | {
      readonly ok: true;
      readonly index: ResolvedRelationIndex;
      readonly issues: readonly SchemaValidationIssue[];
    }
  | {
      readonly ok: false;
      readonly issues: readonly SchemaValidationIssue[];
      readonly cause?: Error;
    };

/**
 * Stable unique edge enumeration, derived from the index rather than stored
 * beside it. Walk named schema/model/field order and yield an edge only at its
 * canonical anchor — a foreign key at its owner, a junction at `endpoints[0]`,
 * either variant family at its carrier — so carrier storage keeps its
 * historical serializer position even when an inverse model sorts earlier.
 */
export function* resolvedEdges(
  index: ResolvedRelationIndex
): Generator<ResolvedRelationEdge> {
  for (const [model, slots] of index) {
    for (const [field, resolved] of slots) {
      if (resolved.member) continue;
      const edge = resolved.edge;
      const anchor =
        edge.kind === "foreignKey"
          ? edge.owner
          : edge.kind === "junction"
            ? edge.endpoints[0]
            : edge.carrier;
      if (anchor.source === model && anchor.field === field) yield edge;
    }
  }
}

// =============================================================================
// CONTEXTUAL GRAPH NODES
// =============================================================================

interface RegisteredModel {
  readonly model: Model<any>;
  readonly name: string;
}

interface SlotNode {
  readonly slot: RelationSlot;
  readonly modelName: string;
  readonly field: string;
  readonly order: number;
  readonly state: RelationState;
  readonly relation: AnyRelation;
}

/** An ordinary slot, or one variant of a carrier: the two pairable things. */
interface Endpoint {
  readonly node: SlotNode;
  /** The variant key when this endpoint is one member of a carrier. */
  readonly variant: string | undefined;
  readonly target: Model<any>;
  readonly targetName: string;
  /** Members inherit the carrier's optional relation-name claim. */
  readonly name: string | undefined;
  readonly cardinality: RelationCardinality;
  /** Canonical position: model order, then field order, then variant order. */
  readonly order: number;
}

/**
 * An endpoint that IS one member of a carrier, so its variant key is settled.
 *
 * Carrier resolution asks each member for its key many times — for the name
 * prepass, the storage columns, the bound inverse, the junction override. That
 * key is settled exactly once, HERE, by the partition that selects members;
 * every later reader takes it as a fact rather than re-defaulting it.
 */
type VariantMember = Endpoint & { readonly variant: string };

const isVariantMember = (endpoint: Endpoint): endpoint is VariantMember =>
  endpoint.variant !== undefined;

type Verdict =
  | { readonly kind: "paired"; readonly partner: Endpoint }
  | { readonly kind: "missing" }
  | { readonly kind: "nameMismatch" }
  | { readonly kind: "ambiguous" };

type VariantMapEntry = VariantOneEntry | VariantManyEntry;

// =============================================================================
// THE GATE
// =============================================================================

export function resolveSchemaRelations(
  schema: Schema,
  context: ValidationContext
): RelationResolution {
  const issues: SchemaValidationIssue[] = [];
  const registration = registerModels(schema);

  const nodes = collectSlotNodes(registration.models);
  const settlement = settleTargets(nodes, registration.byIdentity, issues);
  if (settlement.cause) {
    return { ok: false, issues, cause: settlement.cause };
  }

  const endpoints = settlement.endpoints;
  const byHolder = new Map<Model<any>, Endpoint[]>();
  for (const endpoint of endpoints) {
    const held = byHolder.get(endpoint.node.slot.source);
    if (held) held.push(endpoint);
    else byHolder.set(endpoint.node.slot.source, [endpoint]);
  }

  const structural = new Map<Endpoint, Endpoint[]>();
  const verdicts = new Map<Endpoint, Verdict>();
  for (const endpoint of endpoints) {
    const candidates = (byHolder.get(endpoint.target) ?? []).filter(
      (candidate) =>
        candidate.target === endpoint.node.slot.source &&
        // The asking slot itself is never a candidate; a self edge needs two
        // distinct fields.
        candidate.node !== endpoint.node &&
        // Two direct variant carriers never pair: neither owns the other's
        // storage, and a carrier-wide name cannot choose a member.
        !(candidate.variant !== undefined && endpoint.variant !== undefined)
    );
    structural.set(endpoint, candidates);
    verdicts.set(endpoint, decide(endpoint, candidates));
  }

  reportPairingIssues(endpoints, structural, verdicts, issues);

  const publication: Publication = {
    edges: [],
    slots: [],
    storedReferences: [],
    junctionTables: new Map(),
    junctionNames: [],
    issues,
  };

  for (const endpoint of endpoints) {
    const verdict = verdicts.get(endpoint);
    if (verdict?.kind !== "paired") continue;
    const partner = verdict.partner;
    if (endpoint.variant !== undefined || partner.variant !== undefined) {
      continue;
    }
    // Both endpoints of an ordinary pair must select each other, and the pair
    // is resolved once, from its canonically first endpoint.
    if (verdicts.get(partner)?.kind !== "paired") continue;
    if (endpoint.order > partner.order) continue;
    const edge = resolveOrdinaryPair(endpoint, partner, publication);
    if (!edge) continue;
    publication.edges.push(edge);
    publication.slots.push(
      { slot: endpoint.node.slot, edge },
      { slot: partner.node.slot, edge }
    );
  }
  reportJunctionTableClaims(publication);
  reportRequiredCycles(publication, registration.byIdentity);

  resolveVariantCarriers(
    { schema, context, nodes, endpoints, verdicts },
    publication
  );

  if (issues.some((entry) => entry.severity === "error")) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    index: buildIndex(registration.models, publication.slots),
    issues,
  };
}

interface Publication {
  readonly edges: ResolvedRelationEdge[];
  readonly slots: ResolvedSlot[];
  readonly storedReferences: StoredReferenceFact[];
  /** Junction table name → the endpoint paths that claim it. */
  readonly junctionTables: Map<string, string[]>;
  /** Table and reverse-index names every ordinary junction reserves. */
  readonly junctionNames: string[];
  readonly issues: SchemaValidationIssue[];
}

// =============================================================================
// REGISTRATION
// =============================================================================

interface Registration {
  /** Schema key → model, first claim only. */
  readonly models: ReadonlyMap<string, Model<any>>;
  /** Identity lookup from a settled target value to the model it is. */
  readonly byIdentity: ReadonlyMap<unknown, RegisteredModel>;
}

/**
 * Index the schema by key and by model identity.
 *
 * There is no duplicate-registration check HERE. "One model object binds one
 * schema key" is proved by the registration preflight before hydration writes
 * anything (§7.1), which every effect-capable boundary runs before it reaches
 * this gate — so a second check would be a second guard for one invariant, and a
 * later one, after the names it protects were already written.
 */
function registerModels(schema: Schema): Registration {
  const models = new Map<string, Model<any>>();
  const byIdentity = new Map<unknown, RegisteredModel>();
  for (const [name, model] of schema) {
    models.set(name, model);
    byIdentity.set(model, { model, name });
  }
  return { models, byIdentity };
}

// =============================================================================
// SLOT NODES AND TARGET SETTLEMENT
// =============================================================================

function collectSlotNodes(models: ReadonlyMap<string, Model<any>>): SlotNode[] {
  const nodes: SlotNode[] = [];
  let order = 0;
  for (const [modelName, model] of models) {
    const relations: Record<string, AnyRelation> = model["~"].state.relations;
    for (const [field, relation] of Object.entries(relations)) {
      nodes.push({
        slot: { source: model, field },
        modelName,
        field,
        order: order++,
        state: relation["~"].state,
        relation,
      });
    }
  }
  return nodes;
}

interface Settlement {
  readonly endpoints: Endpoint[];
  readonly cause: Error | undefined;
}

/**
 * Consume each terminal's lazy once-cell exactly once per slot, in canonical
 * order, and prove the settled value is a registered model.
 *
 * A thrown getter stops resolution: the first failure in canonical order emits
 * its contextual issue and returns the terminal's own settled `Error`, so every
 * schema context observes the same object and later getters stay uninvoked.
 */
function settleTargets(
  nodes: readonly SlotNode[],
  byIdentity: ReadonlyMap<unknown, RegisteredModel>,
  issues: SchemaValidationIssue[]
): Settlement {
  const endpoints: Endpoint[] = [];
  let order = 0;
  for (const node of nodes) {
    const target = node.state.target;
    if (target.kind === "model") {
      let settled: unknown;
      try {
        settled = node.relation["~"].settleTarget();
      } catch (thrown) {
        issues.push(thrownTargetIssue("R006", node, undefined, thrown));
        return { endpoints, cause: thrownAsError(thrown) };
      }
      const registered = byIdentity.get(settled);
      if (!registered) {
        issues.push({
          code: "R006",
          message: `'${node.field}' in '${node.modelName}' targets a model that is not registered in the schema`,
          severity: "error",
          model: node.modelName,
          relation: node.field,
          repair:
            "Register the target model in the schema passed to the client",
        });
        continue;
      }
      endpoints.push(makeEndpoint(node, undefined, registered, order++));
      continue;
    }
    for (const variant of Object.keys(target.entries)) {
      let settled: unknown;
      try {
        settled = node.relation["~"].settleTarget(variant);
      } catch (thrown) {
        issues.push(thrownTargetIssue("P001", node, variant, thrown));
        return { endpoints, cause: thrownAsError(thrown) };
      }
      const registered = byIdentity.get(settled);
      if (!registered) {
        issues.push({
          code: "P001",
          message: `Variant '${variant}' in '${node.modelName}.${node.field}' is not registered in the schema`,
          severity: "error",
          model: node.modelName,
          relation: node.field,
          repair: `Register the '${variant}' target model in the schema`,
        });
        continue;
      }
      endpoints.push(makeEndpoint(node, variant, registered, order++));
    }
  }
  return { endpoints, cause: undefined };
}

function makeEndpoint(
  node: SlotNode,
  variant: string | undefined,
  registered: RegisteredModel,
  order: number
): Endpoint {
  return {
    node,
    variant,
    target: registered.model,
    targetName: registered.name,
    name: node.state.name,
    cardinality: node.state.cardinality,
    order,
  };
}

function thrownTargetIssue(
  code: string,
  node: SlotNode,
  variant: string | undefined,
  thrown: unknown
): SchemaValidationIssue {
  const where = variant ? `variant '${variant}' of ` : "";
  return {
    code,
    message: `Target getter for ${where}'${node.modelName}.${node.field}' threw: ${thrownAsError(thrown).message}`,
    severity: "error",
    model: node.modelName,
    relation: node.field,
    repair: "Make the target getter return a registered model without throwing",
  };
}

// =============================================================================
// THE CANDIDATE GRAPH (§6.2)
// =============================================================================

function decide(endpoint: Endpoint, candidates: readonly Endpoint[]): Verdict {
  const exact = matching(endpoint, candidates);
  const [only] = exact;
  if (only && exact.length === 1) return { kind: "paired", partner: only };
  if (exact.length > 1) return { kind: "ambiguous" };
  // §6.2 rule 4 reads the candidate count AFTER the label partition, so a
  // variant member left with no same-named candidate has zero candidates and
  // stays a valid direct-only member. The differently named candidate is always
  // an ordinary slot — carriers never pair with carriers — and it must itself
  // pair, so the mistake this could hide still reports exactly one diagnostic,
  // at that slot.
  if (candidates.length === 0 || endpoint.variant !== undefined) {
    return { kind: "missing" };
  }
  return { kind: "nameMismatch" };
}

function matching(
  endpoint: Endpoint,
  candidates: readonly Endpoint[]
): Endpoint[] {
  return candidates.filter((candidate) => candidate.name === endpoint.name);
}

function reportPairingIssues(
  endpoints: readonly Endpoint[],
  structural: ReadonlyMap<Endpoint, Endpoint[]>,
  verdicts: ReadonlyMap<Endpoint, Verdict>,
  issues: SchemaValidationIssue[]
): void {
  for (const endpoint of endpoints) {
    const verdict = verdicts.get(endpoint);
    // Both maps were filled from this same endpoint list, one entry each.
    const candidates = structural.get(endpoint)!;
    if (verdict?.kind === "missing") {
      // A variant member with no candidate is a valid direct-only member.
      if (endpoint.variant !== undefined) continue;
      issues.push({
        code: "R002",
        message: `'${endpoint.node.modelName}.${endpoint.node.field}' has no inverse relation in '${endpoint.targetName}'`,
        severity: "error",
        model: endpoint.node.modelName,
        relation: endpoint.node.field,
        repair: `Declare a slot on '${endpoint.targetName}' whose target is '${endpoint.node.modelName}'`,
      });
      continue;
    }
    if (verdict?.kind === "ambiguous") {
      const competing = matching(endpoint, candidates);
      issues.push({
        code: "R009",
        message: `${describe(endpoint)} has ${competing.length} competing inverse candidates in '${endpoint.targetName}'`,
        severity: "error",
        model: endpoint.node.modelName,
        relation: endpoint.node.field,
        candidates: competing.map(path),
        repair:
          "Give each intended pair the same distinct .name(...) on both endpoints",
      });
      continue;
    }
    if (verdict?.kind !== "nameMismatch") continue;
    // A mismatch is a fact about the PAIR, so it is reported once, at the
    // canonically first of the endpoints that disagree.
    const disagreeing = candidates.filter(
      (candidate) => verdicts.get(candidate)?.kind === "nameMismatch"
    );
    if (disagreeing.some((partner) => partner.order < endpoint.order)) continue;
    issues.push({
      code: "R010",
      message: `${describe(endpoint)} claims relation name ${label(endpoint.name)}, but no candidate in '${endpoint.targetName}' claims the same name`,
      severity: "error",
      model: endpoint.node.modelName,
      relation: endpoint.node.field,
      candidates: candidates.map(path),
      repair: "Spell the same .name(...) on both endpoints, or omit it on both",
    });
  }
}

function describe(endpoint: Endpoint): string {
  return endpoint.variant === undefined
    ? `'${endpoint.node.modelName}.${endpoint.node.field}'`
    : `Variant '${endpoint.variant}' of '${endpoint.node.modelName}.${endpoint.node.field}'`;
}

function path(endpoint: Endpoint): string {
  return endpoint.variant === undefined
    ? `${endpoint.node.modelName}.${endpoint.node.field}`
    : `${endpoint.node.modelName}.${endpoint.node.field}.${endpoint.variant}`;
}

function label(name: string | undefined): string {
  return name === undefined ? "no name" : `'${name}'`;
}

// =============================================================================
// ORDINARY TOPOLOGY (§6.3, §6.4)
// =============================================================================

function resolveOrdinaryPair(
  first: Endpoint,
  second: Endpoint,
  publication: Publication
): ResolvedOrdinaryEdge | undefined {
  const issues = publication.issues;
  const endpoints: readonly [RelationSlot, RelationSlot] = [
    first.node.slot,
    second.node.slot,
  ];
  if (first.cardinality === "many" && second.cardinality === "many") {
    return resolveJunctionEdge(first, second, endpoints, publication);
  }

  for (const endpoint of [first, second]) {
    if (endpoint.node.state.junction === undefined) continue;
    issues.push(
      misplaced(endpoint, "junction configuration", "an ordinary junction pair")
    );
    return undefined;
  }

  const owners = [first, second].filter(
    (endpoint) => endpoint.node.state.foreignKey !== undefined
  );
  if (owners.length === 2) {
    issues.push({
      code: "CM003",
      message: `'${first.node.modelName}.${first.node.field}' and '${second.node.modelName}.${second.node.field}' both complete a foreign key; exactly one endpoint owns it`,
      severity: "error",
      model: first.node.modelName,
      relation: first.node.field,
      candidates: [path(first), path(second)],
      repair: "Drop .fields(...).references(...) from one endpoint",
    });
    return undefined;
  }
  const owner = owners[0];
  if (!owner) {
    // Name the ONE singular endpoint when exactly one is singular — that is
    // the end whose slot cannot be empty and so the one that must store the
    // key. Otherwise the canonically first endpoint carries the refusal.
    const [onlySingular, alsoSingular] = [first, second].filter(
      (endpoint) => endpoint.cardinality === "one"
    );
    const required = onlySingular && !alsoSingular ? onlySingular : first;
    issues.push({
      code: "FK004",
      message: `'${required.node.modelName}.${required.node.field}' stores no foreign key; one endpoint of this edge must complete .fields(...).references(...)`,
      severity: "error",
      model: required.node.modelName,
      relation: required.node.field,
      repair: `Complete .fields(...).references(...) on '${required.node.modelName}.${required.node.field}'`,
    });
    return undefined;
  }

  const partner = owner === first ? second : first;
  // `owners` IS the endpoints whose foreign key is defined, so re-asking here
  // would be a second owner for the fact that filter already decided.
  const foreignKey = owner.node.state.foreignKey!;
  const check = checkStoredReference({
    modelName: owner.node.modelName,
    model: owner.node.slot.source,
    relationName: owner.node.field,
    targetName: partner.node.modelName,
    target: partner.node.slot.source,
    foreignKey,
  });
  issues.push(...check.issues);

  const unique = first.cardinality === "one" && second.cardinality === "one";
  if (!unique && declaresUniqueKey(owner.node.slot.source, foreignKey.fields)) {
    issues.push({
      code: "FK009",
      message: `'${owner.node.modelName}.${owner.node.field}' stores a unique foreign key, which contradicts the collection '${partner.node.modelName}.${partner.node.field}' declares`,
      severity: "error",
      model: owner.node.modelName,
      relation: owner.node.field,
      repair: `Drop the unique key on [${foreignKey.fields.join(", ")}], or declare '${partner.node.modelName}.${partner.node.field}' with s.toOne`,
    });
    return undefined;
  }
  if (!check.reference) return undefined;
  // The published local columns follow the NORMALIZED member order (a permuted
  // referenced tuple is reordered to its matched target key by
  // `checkStoredReference`), so the automatic-index name this fact reserves is
  // the same one the serializer derives from the members.
  publication.storedReferences.push({
    owner: owner.node.slot.source,
    fields: check.reference.members.map((member) => member.foreignField),
    unique,
  });
  return {
    kind: "foreignKey",
    endpoints,
    owner: owner.node.slot,
    reference: check.reference,
    unique,
  };
}

function resolveJunctionEdge(
  first: Endpoint,
  second: Endpoint,
  endpoints: readonly [RelationSlot, RelationSlot],
  publication: Publication
): ResolvedOrdinaryEdge | undefined {
  const issues = publication.issues;
  const configured = [first, second].filter(
    (endpoint) => endpoint.node.state.junction !== undefined
  );
  if (configured.length === 2) {
    issues.push({
      code: "R011",
      message: `'${first.node.modelName}.${first.node.field}' and '${second.node.modelName}.${second.node.field}' both configure this junction; exactly one endpoint owns every override`,
      severity: "error",
      model: first.node.modelName,
      relation: first.node.field,
      candidates: [path(first), path(second)],
      repair: "Keep the junction configuration on one endpoint only",
    });
    return undefined;
  }
  // `configured` holds the endpoints whose junction value is set, so the sole
  // configuring endpoint's overrides are there to read.
  const configuring = configured[0];
  const overrides =
    configuring === undefined
      ? undefined
      : configuring === first
        ? configuring.node.state.junction
        : mirrorOverrides(configuring.node.state.junction!);

  const sourceRowKey =
    getModelKeyCatalog(first.node.slot.source).rowKey?.fields ?? [];
  const targetRowKey =
    getModelKeyCatalog(second.node.slot.source).rowKey?.fields ?? [];
  const names = resolveOrdinaryJunctionNames({
    sourceModelName: first.node.modelName,
    targetModelName: second.node.modelName,
    sourceField: first.node.field,
    targetField: second.node.field,
    sourceRowKeyIsCompound: sourceRowKey.length > 1,
    targetRowKeyIsCompound: targetRowKey.length > 1,
    pairName: first.name,
    overrides,
  });
  claimJunctionTable(publication, names.table, first, second);
  try {
    const topology = resolveJunctionTopology({
      table: names.table,
      source: {
        model: first.node.slot.source,
        modelName: first.node.modelName,
        rowKey: sourceRowKey,
        token: names.sourceToken,
      },
      target: {
        model: second.node.slot.source,
        modelName: second.node.modelName,
        rowKey: targetRowKey,
        token: names.targetToken,
      },
      pairName: first.name,
    });
    topology.foreignKeyName("source");
    topology.foreignKeyName("target");
    publication.junctionNames.push(names.table, topology.reverseIndexName());
    const onDelete = overrides?.onDelete;
    const onUpdate = overrides?.onUpdate;
    return {
      kind: "junction",
      endpoints,
      topology,
      ...(onDelete ? { onDelete } : {}),
      ...(onUpdate ? { onUpdate } : {}),
    };
  } catch (error) {
    issues.push({
      code:
        error instanceof JunctionPhysicalNameError && error.kind === "collision"
          ? "JT003"
          : "JT002",
      message: thrownAsError(error).message,
      severity: "error",
      model: first.node.modelName,
      relation: first.node.field,
      repair:
        "Give this junction an explicit .through(...) table and distinct .source(...)/.target(...) tokens",
    });
    return undefined;
  }
}

function claimJunctionTable(
  publication: Publication,
  table: string,
  first: Endpoint,
  second: Endpoint
): void {
  const claims = publication.junctionTables.get(table);
  const claim = `${path(first)}, ${path(second)}`;
  if (claims) claims.push(claim);
  else publication.junctionTables.set(table, [claim]);
}

/** JT001: one physical junction table belongs to exactly one resolved pair. */
function reportJunctionTableClaims(publication: Publication): void {
  for (const [table, claims] of publication.junctionTables) {
    if (claims.length < 2) continue;
    publication.issues.push({
      code: "JT001",
      message: `Junction '${table}' is claimed by more than one relation pair: ${claims.join("; ")}`,
      severity: "error",
      candidates: claims,
      repair:
        "Give each pair its own .through(...) table or a distinct .name(...)",
    });
  }
}

/**
 * CM002: a cycle of required foreign keys can never be inserted.
 *
 * "Required" is derived, not declared: a foreign key whose every local member is
 * non-nullable makes its target an insert dependency of its owner.
 */
function reportRequiredCycles(
  publication: Publication,
  byIdentity: ReadonlyMap<unknown, RegisteredModel>
): void {
  const graph = new Map<string, string[]>();
  for (const registered of byIdentity.values()) graph.set(registered.name, []);
  for (const edge of publication.edges) {
    if (edge.kind !== "foreignKey") continue;
    const owner = edge.owner;
    const scalars = owner.source["~"].state.scalars;
    const required = edge.reference.members.every(
      (member) => scalars[member.foreignField]?.["~"].state.nullable !== true
    );
    if (!required) continue;
    const [first, second] = edge.endpoints;
    const partner = first === owner ? second : first;
    const from = byIdentity.get(owner.source)?.name;
    const to = byIdentity.get(partner.source)?.name;
    if (from !== undefined && to !== undefined) graph.get(from)?.push(to);
  }

  const visited = new Set<string>();
  const stack = new Set<string>();
  const reported = new Set<string>();
  const walk = (node: string, trail: string[]): void => {
    if (stack.has(node)) {
      const cycle = [...trail.slice(trail.indexOf(node)), node];
      const key = [...cycle].sort().join("->");
      if (reported.has(key)) return;
      reported.add(key);
      publication.issues.push({
        code: "CM002",
        message: `Circular required relations: ${cycle.join(" → ")}`,
        severity: "error",
        repair: "Make one foreign key in the cycle nullable",
      });
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.add(node);
    trail.push(node);
    // Seeded for every registered model, and a neighbour IS a registered name.
    for (const neighbor of graph.get(node)!) walk(neighbor, trail);
    stack.delete(node);
    trail.pop();
  };
  for (const node of graph.keys()) {
    if (!visited.has(node)) walk(node, []);
  }
}

/** The other endpoint's view of one owner's overrides: the two sides swap. */
function mirrorOverrides(
  overrides: JunctionOverrideView
): JunctionOverrideView {
  return {
    ...(overrides.table === undefined ? {} : { table: overrides.table }),
    ...(overrides.target === undefined ? {} : { source: overrides.target }),
    ...(overrides.source === undefined ? {} : { target: overrides.source }),
    ...(overrides.onDelete === undefined
      ? {}
      : { onDelete: overrides.onDelete }),
    ...(overrides.onUpdate === undefined
      ? {}
      : { onUpdate: overrides.onUpdate }),
  };
}

function misplaced(
  endpoint: Endpoint,
  what: string,
  where: string
): SchemaValidationIssue {
  return {
    code: "R012",
    message: `${describe(endpoint)} declares ${what}, which only ${where} may carry`,
    severity: "error",
    model: endpoint.node.modelName,
    relation: endpoint.node.field,
    repair: `Remove ${what} from '${endpoint.node.modelName}.${endpoint.node.field}'`,
  };
}

function declaresUniqueKey(
  model: Model<any>,
  fields: readonly string[]
): boolean {
  return findReferenceableKey(model, fields) !== undefined;
}

// =============================================================================
// VARIANT TOPOLOGY (§6.5)
// =============================================================================

interface GraphView {
  readonly schema: Schema;
  readonly context: ValidationContext;
  readonly nodes: readonly SlotNode[];
  readonly endpoints: readonly Endpoint[];
  readonly verdicts: ReadonlyMap<Endpoint, Verdict>;
}

function resolveVariantCarriers(
  graph: GraphView,
  publication: Publication
): void {
  // The variant map is read ONCE per carrier, here, where the partition that
  // selects carriers is the same expression that narrows the target. Every
  // later reader takes the entries as a fact instead of re-classifying a
  // declaration it already knows is a carrier's.
  const carriers: SlotNode[] = [];
  const entriesByCarrier = new Map<
    SlotNode,
    Readonly<Record<string, VariantMapEntry>>
  >();
  for (const node of graph.nodes) {
    const target = node.state.target;
    if (target.kind !== "variants") continue;
    carriers.push(node);
    entriesByCarrier.set(node, target.entries);
  }
  if (carriers.length === 0) return;

  // Every carrier gets an entry, empty or not: a carrier whose targets were all
  // refused above contributed no member, and the two passes below then read one
  // settled list in carrier order instead of each re-deciding what an absent
  // carrier means. A member's node IS a carrier — the same
  // `target.kind === "variants"` partition selected both — so the seeded list
  // is always there to push into.
  const membersByCarrier = new Map<SlotNode, VariantMember[]>();
  for (const carrier of carriers) membersByCarrier.set(carrier, []);
  for (const endpoint of graph.endpoints) {
    if (!isVariantMember(endpoint)) continue;
    membersByCarrier.get(endpoint.node)!.push(endpoint);
  }

  const memberNameCounts = new Map<string, number>();
  const indexNameCounts = new Map<string, number>();
  for (const [carrier, members] of membersByCarrier) {
    if (carrier.state.cardinality === "one") {
      const indexName = variantRowIndexName(tableOf(carrier), carrier.field);
      indexNameCounts.set(indexName, (indexNameCounts.get(indexName) ?? 0) + 1);
      continue;
    }
    for (const member of members) {
      const plan = planVariantMemberNames({
        model: carrier.slot.source,
        modelName: carrier.modelName,
        ownerTable: tableOf(carrier),
        relationName: carrier.field,
        member: memberInput(entriesByCarrier.get(carrier)!, member),
      });
      for (const claim of plan?.claims ?? []) {
        memberNameCounts.set(claim, (memberNameCounts.get(claim) ?? 0) + 1);
      }
    }
  }

  const reservedIndexes = collectReservedPhysicalNames({
    schema: graph.schema,
    ctx: graph.context,
    junctionNames: publication.junctionNames,
    storedReferences: publication.storedReferences,
  });

  for (const [carrier, members] of membersByCarrier) {
    const reservedColumns = new Set(
      getScalars(carrier.slot.source).map(
        ([field, scalar]) => scalar["~"].state.columnName ?? field
      )
    );
    const bound = bindMembers(members, graph, publication);
    const edge: ResolvedVariantEdge | undefined =
      carrier.state.cardinality === "one"
        ? resolveRowCarrier({
            carrier,
            entries: entriesByCarrier.get(carrier)!,
            members,
            bound,
            reservedColumns,
            reservedIndexes,
            indexNameCounts,
            publication,
          })
        : resolveMemberJunctionCarrier({
            carrier,
            entries: entriesByCarrier.get(carrier)!,
            members,
            bound,
            reservedColumns,
            reservedIndexes,
            memberNameCounts,
            publication,
          });
    if (!edge) continue;
    publication.edges.push(edge);
    publication.slots.push({ slot: carrier.slot, edge });
    // An inverse view points at the EXACT member object the carrier edge already
    // owns — `member.inverse` is the slot that member bound, so there is no
    // second lookup that could miss. The two storage families are walked
    // separately only because `ResolvedSlot` pairs each edge form with its own
    // member type; the bodies are one rule.
    if (edge.kind === "variantRowCarrier") {
      for (const member of edge.members) {
        if (member.inverse) {
          publication.slots.push({ slot: member.inverse, edge, member });
        }
      }
      continue;
    }
    for (const member of edge.members) {
      if (member.inverse) {
        publication.slots.push({ slot: member.inverse, edge, member });
      }
    }
  }
}

/**
 * Variant key → the ordinary slot resolved onto that member.
 *
 * A bound inverse is a VIEW over carrier-owned storage: it configures neither a
 * foreign key nor a junction, because the carrier already owns both.
 */
function bindMembers(
  members: readonly VariantMember[],
  graph: GraphView,
  publication: Publication
): Map<string, Endpoint> {
  const bound = new Map<string, Endpoint>();
  for (const member of members) {
    const verdict = graph.verdicts.get(member);
    if (verdict?.kind !== "paired") continue;
    const inverse = verdict.partner;
    if (graph.verdicts.get(inverse)?.kind !== "paired") continue;
    if (inverse.node.state.foreignKey !== undefined) {
      publication.issues.push(
        misplaced(inverse, "a foreign key", "an ordinary edge's owner")
      );
      continue;
    }
    if (inverse.node.state.junction !== undefined) {
      publication.issues.push(
        misplaced(
          inverse,
          "junction configuration",
          "an ordinary junction pair"
        )
      );
      continue;
    }
    bound.set(member.variant, inverse);
  }
  return bound;
}

interface CarrierInput {
  readonly carrier: SlotNode;
  /** The carrier's normalized variant map, narrowed once at the partition. */
  readonly entries: Readonly<Record<string, VariantMapEntry>>;
  readonly members: readonly VariantMember[];
  readonly bound: ReadonlyMap<string, Endpoint>;
  readonly reservedColumns: Set<string>;
  readonly reservedIndexes: Set<string>;
  readonly publication: Publication;
}

function resolveRowCarrier(
  input: CarrierInput & {
    readonly indexNameCounts: ReadonlyMap<string, number>;
  }
): ResolvedVariantRowEdge | undefined {
  const { carrier, members, bound, publication } = input;
  const cardinalities = new Set(
    [...bound.values()].map((inverse) => inverse.cardinality)
  );
  if (cardinalities.size > 1) {
    publication.issues.push({
      code: "P012",
      message: `Variant relation '${carrier.field}' in '${carrier.modelName}' cannot mix to-one and to-many inverses; one composite index serves the whole carrier`,
      severity: "error",
      model: carrier.modelName,
      relation: carrier.field,
      repair: "Give every bound inverse of this carrier the same cardinality",
    });
    return undefined;
  }
  const storage = checkVariantRowStorage({
    modelName: carrier.modelName,
    ownerTable: tableOf(carrier),
    relationName: carrier.field,
    optional: carrier.state.optional === true,
    members: members.map((member) => ({
      variant: member.variant,
      target: member.target,
    })),
    reservedColumns: input.reservedColumns,
    reservedIndexes: input.reservedIndexes,
    indexNameCounts: input.indexNameCounts,
  });
  publication.issues.push(...storage.issues);
  if (!storage.storage) return undefined;

  const entries = input.entries;
  const resolved: ResolvedVariantRowMember[] = [];
  for (const member of members) {
    const variant = member.variant;
    // Storage is published ONLY when every member resolved a referenced field,
    // and each member's key came from this same entry map — so both lookups are
    // reads of what the completeness check above already decided.
    const referencedField = storage.referencedFields.get(variant)!;
    const entry = entries[variant]!;
    const inverse = bound.get(variant);
    resolved.push({
      variant,
      entry,
      targetModel: member.target,
      referencedField,
      ...(inverse ? { inverse: inverse.node.slot } : {}),
    });
  }
  // Published storage requires one portable identity, so a carrier that reaches
  // here resolved at least one member.
  const [head, ...rest] = resolved;
  return {
    kind: "variantRowCarrier",
    carrier: carrier.slot,
    members: [head!, ...rest],
    uniqueTarget: cardinalities.has("one"),
    storage: storage.storage,
  };
}

function resolveMemberJunctionCarrier(
  input: CarrierInput & {
    readonly memberNameCounts: ReadonlyMap<string, number>;
  }
): ResolvedVariantJunctionEdge | undefined {
  const { carrier, members, bound, publication } = input;
  const junctions = checkVariantMemberJunctions({
    modelName: carrier.modelName,
    model: carrier.slot.source,
    ownerTable: tableOf(carrier),
    relationName: carrier.field,
    members: members.map((member) => memberInput(input.entries, member)),
    reservedColumns: input.reservedColumns,
    reservedIndexes: input.reservedIndexes,
    memberNameCounts: input.memberNameCounts,
  });
  publication.issues.push(...junctions.issues);

  const entries = input.entries;
  const resolved: ResolvedVariantJunctionMember[] = [];
  for (const member of members) {
    const variant = member.variant;
    const topology = junctions.topologies.get(variant);
    const entry = entries[variant];
    if (!(topology && entry)) return undefined;
    const inverse = bound.get(variant);
    resolved.push({
      variant,
      entry,
      uniqueTarget: inverse?.cardinality === "one",
      topology,
      ...(inverse ? { inverse: inverse.node.slot } : {}),
    });
  }
  const [head, ...rest] = resolved;
  if (!head) return undefined;
  return {
    kind: "variantJunctionCarrier",
    carrier: carrier.slot,
    members: [head, ...rest],
  };
}

function memberInput(
  entries: Readonly<Record<string, VariantMapEntry>>,
  member: VariantMember
) {
  return {
    variant: member.variant,
    target: member.target,
    targetName: member.targetName,
    junction: entries[member.variant]?.junction,
  };
}

function tableOf(node: SlotNode): string {
  return node.slot.source["~"].state.tableName ?? node.modelName;
}

// =============================================================================
// PUBLICATION
// =============================================================================

/**
 * Publish the slots as a per-model map in DECLARATION order.
 *
 * Resolution order is edge order — ordinary pairs first, at their canonically
 * first endpoint, then every variant carrier — so inserting `slots` as they were
 * produced would put a model's variant carrier after an ordinary slot declared
 * later. `resolvedEdges` promises schema/model/field order and the migration
 * serializer emits from it, so the shape order the model already holds is what
 * decides the map's order; the resolved slots are only looked up by it.
 */
function buildIndex(
  models: ReadonlyMap<string, Model<any>>,
  slots: readonly ResolvedSlot[]
): ResolvedRelationIndex {
  const resolvedBySlot = new Map<Model<any>, Map<string, ResolvedSlot>>();
  for (const resolved of slots) {
    const held = resolvedBySlot.get(resolved.slot.source);
    if (held) held.set(resolved.slot.field, resolved);
    else
      resolvedBySlot.set(
        resolved.slot.source,
        new Map([[resolved.slot.field, resolved]])
      );
  }
  const index = new Map<Model<any>, Map<string, ResolvedSlot>>();
  for (const model of models.values()) {
    const declared = resolvedBySlot.get(model);
    const ordered = new Map<string, ResolvedSlot>();
    const relations: Record<string, AnyRelation> = model["~"].state.relations;
    for (const field of Object.keys(relations)) {
      const resolved = declared?.get(field);
      if (resolved) ordered.set(field, resolved);
    }
    index.set(model, ordered);
  }
  return index;
}
