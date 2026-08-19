import { isValidSchemaIdentifier } from "../../identifier";
import { getModelKeyCatalog, Model } from "../../model";
import {
  collectInverseCandidates,
  getCompatiblePolymorphicInverseBinding,
  getPolymorphicInverseBinding,
  getPolymorphicInverseCandidates,
  type PolymorphicInverseCardinality,
  type PolymorphicJunctionMember,
  type PolymorphicStorageMember,
  type PolymorphicThroughEntry,
} from "../../relation";
import { getJunctionTableName } from "../../relation/helpers";
import {
  resolveOrdinaryJunctionTopology,
  resolvePolymorphicMemberJunctionTopology,
  resolvePolymorphicMemberNames,
} from "../../relation/junction-topology";
import { string } from "../../scalars";
import type { Scalar } from "../../scalars/base";
import type {
  Schema,
  SchemaValidationIssue,
  ValidationContext,
  ValidationRule,
} from "../types";
import {
  findModelName,
  getPolymorphicRelations,
  getRelations,
  getScalars,
} from "./model-members";

const STORED_TYPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/;
const PORTABLE_ID_TYPES = new Set(["string", "int", "bigint"]);

function issue(
  code: string,
  message: string,
  model: string,
  relation: string,
  severity: "error" | "warning" = "error"
): SchemaValidationIssue {
  return { code, message, severity, model, relation };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownKeys(value: unknown): readonly PropertyKey[] {
  if (typeof value !== "object" || value === null) return [];
  return Reflect.ownKeys(value);
}

function ownStringKeys(value: unknown): string[] {
  return ownKeys(value).filter((key): key is string => typeof key === "string");
}

function junctionPhysicalNames(
  schema: Schema,
  ctx: ValidationContext
): Set<string> {
  const names = new Set<string>();
  for (const [sourceName, source] of schema) {
    for (const [, relation] of getRelations(source)) {
      const state = relation["~"].state;
      if (state.type !== "manyToMany") continue;
      const target = state.getter();
      const targetName = findModelName(ctx, target);
      if (!targetName) continue;
      // A fields-less manyToMany whose compatible binding resolves is a
      // polymorphic member VIEW: it owns no ordinary junction, so reserving the
      // phantom generated names here would false-collide against the member's
      // own defaults.
      if (getCompatiblePolymorphicInverseBinding(state, source)) continue;
      const sourceRowKey = getModelKeyCatalog(source).rowKey?.fields;
      const targetRowKey = getModelKeyCatalog(target).rowKey?.fields;
      if (!(sourceRowKey?.length && targetRowKey?.length)) continue;
      try {
        const tableName = getJunctionTableName(
          relation,
          sourceName,
          targetName
        );
        const topology = resolveOrdinaryJunctionTopology({
          relation,
          table: tableName,
          source: {
            model: source,
            modelName: sourceName,
            rowKey: sourceRowKey,
          },
          target: {
            model: target,
            modelName: targetName,
            rowKey: targetRowKey,
          },
        });
        // The reservation set is EXACTLY {table, canonical-second reverse
        // index} — never the fkey names — and the table is reserved BEFORE the
        // index name is computed, so a junction whose index name is refused
        // still reserves its table name.
        names.add(tableName);
        names.add(topology.reverseIndexName());
      } catch {
        // Relation validation reports malformed junction configuration.
      }
    }
  }
  return names;
}

function singlePrimaryKey(
  model: Model<any>
): { readonly field: string; readonly scalar: Scalar } | undefined {
  if (
    model["~"].state.compoundId &&
    Object.keys(model["~"].state.compoundId).length > 0
  ) {
    return undefined;
  }
  const primaryKeys = getScalars(model).filter(
    ([, scalar]) => scalar["~"].state.isId
  );
  if (primaryKeys.length !== 1) return undefined;
  const [field, scalar] = primaryKeys[0]!;
  return { field, scalar };
}

function serializedForeignKeyIndexNames(
  model: Model<any>,
  tableName: string
): readonly string[] {
  const state = model["~"].state;
  const columnName = (field: string) =>
    state.scalars[field]?.["~"].state.columnName ?? field;
  const primaryKeyColumns = getScalars(model)
    .filter(([, scalar]) => scalar["~"].state.isId)
    .map(([field]) => columnName(field));
  if (state.compoundId) {
    const compoundIdName = Object.keys(state.compoundId)[0];
    const compoundId = compoundIdName
      ? state.compoundId[compoundIdName]
      : undefined;
    if (compoundId?.entries) {
      primaryKeyColumns.push(
        ...Object.keys(compoundId.entries).map(columnName)
      );
    }
  }
  const uniqueColumns = getScalars(model)
    .filter(([, scalar]) => scalar["~"].state.isUnique)
    .map(([field]) => [columnName(field)]);
  if (state.compoundUniques) {
    for (const constraintName of Object.keys(state.compoundUniques)) {
      const constraint = state.compoundUniques[constraintName];
      if (constraint?.entries) {
        uniqueColumns.push(Object.keys(constraint.entries).map(columnName));
      }
    }
  }
  const declaredIndexes = state.indexes.map((index) => ({
    name: index.options.name ?? `${tableName}_${index.fields.join("_")}_idx`,
    columns: index.fields.map(columnName),
    where: index.options.where,
  }));
  const oneToOneColumns = getRelations(model)
    .map(([, relation]) => relation["~"].state)
    .filter(
      (relation) =>
        relation.type === "oneToOne" &&
        relation.fields !== undefined &&
        relation.references !== undefined &&
        relation.getter()?.["~"]
    )
    .map((relation) => relation.fields!.map(columnName));
  const coveringColumns = [
    primaryKeyColumns,
    ...uniqueColumns,
    ...oneToOneColumns,
    ...declaredIndexes
      .filter((index) => !index.where)
      .map((index) => index.columns),
  ];
  const emittedNames = new Set(declaredIndexes.map((index) => index.name));
  const automaticNames: string[] = [];
  for (const [, relation] of getRelations(model)) {
    const relationState = relation["~"].state;
    if (
      relationState.type !== "manyToOne" ||
      relationState.fields === undefined ||
      relationState.references === undefined ||
      !relationState.getter()?.["~"]
    ) {
      continue;
    }
    const foreignKeyColumns = relationState.fields.map(columnName);
    const alreadyIndexed = coveringColumns.some((columns) =>
      foreignKeyColumns.every(
        (column, position) => columns[position] === column
      )
    );
    if (alreadyIndexed) continue;
    const preferredName = `${tableName}_${foreignKeyColumns.join("_")}_idx`;
    const name = emittedNames.has(preferredName)
      ? `${tableName}_${foreignKeyColumns.join("_")}_fkey_idx`
      : preferredName;
    if (emittedNames.has(name)) continue;
    emittedNames.add(name);
    automaticNames.push(name);
  }
  return automaticNames;
}

function validateInverseBindings(
  name: string,
  model: Model<any>,
  ctx: ValidationContext
): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];
  for (const [relationName, relation] of getRelations(model)) {
    const relationState = relation["~"].state;
    // Copy #4 of the shape disjunction, WIDENED to the four fields-less shapes
    // so P004/P005/P010 (and P016 below) reach the new inverse spellings.
    const isPolymorphicInverseCandidate =
      relationState.type === "oneToMany" ||
      ((relationState.type === "oneToOne" ||
        relationState.type === "manyToOne" ||
        relationState.type === "manyToMany") &&
        (relationState.fields === undefined ||
          relationState.fields.length === 0));
    if (!isPolymorphicInverseCandidate) continue;
    const target = relationState.getter();
    if (!findModelName(ctx, target)) continue;
    const candidates = getPolymorphicInverseCandidates(target, model);
    if (candidates.length === 0) continue;
    if (
      relationState.type === "manyToMany" &&
      (relationState.through !== undefined ||
        relationState.A !== undefined ||
        relationState.B !== undefined ||
        relationState.onDelete !== undefined ||
        relationState.onUpdate !== undefined) &&
      getCompatiblePolymorphicInverseBinding(relationState, model)
    ) {
      issues.push(
        issue(
          "P016",
          `Polymorphic-bound manyToMany '${relationName}' in '${name}' cannot configure .through(), .A(), .B(), .onDelete(), or .onUpdate(); member junctions are fixed`,
          name,
          relationName
        )
      );
    }
    const relationGroups = getPolymorphicRelations(target);
    const pairingName = relationState.name;
    /**
     * P020 — the DDL half-pair. A polymorphic-bound `manyToMany` is a member
     * VIEW: the serializer emits no ordinary junction for it, and the
     * validator reserves no ordinary junction names for it. If the TARGET
     * declares a `manyToMany` that would have PAIRED with this one — same two
     * models, same pairing name — and that partner has no member view of its
     * own, the partner serializes an ordinary junction table ALONE. The schema
     * then means two different things on its two sides: member-junction
     * membership here, a two-sided ordinary junction there.
     *
     * No other guard covers it. JT004 compares the two sides' declared table
     * and column configuration and finds nothing to conflict about (both sides
     * are unconfigured), and P016 refuses only configuration spelled ON the
     * view. Refusing at definition validation is what keeps the serializer's
     * view exclusion honest without precedence surgery in the resolver.
     */
    if (
      relationState.type === "manyToMany" &&
      getCompatiblePolymorphicInverseBinding(relationState, model)
    ) {
      const orphanedPartner = getRelations(target).find(([, candidate]) => {
        const partnerState = candidate["~"].state;
        return (
          partnerState.type === "manyToMany" &&
          partnerState.getter() === model &&
          partnerState.name === pairingName &&
          !getCompatiblePolymorphicInverseBinding(partnerState, target)
        );
      });
      if (orphanedPartner) {
        issues.push(
          issue(
            "P020",
            `Polymorphic-bound manyToMany '${relationName}' in '${name}' is paired with ordinary manyToMany '${orphanedPartner[0]}' on its target; one side reads member junctions while the other declares an ordinary junction table`,
            name,
            relationName
          )
        );
      }
    }
    // The ONE ordinary-candidate scan (`@schema/relation/inverse`). What
    // follows is NOT a second resolution: the resolver answers WHICH edge
    // wins, while this rule enumerates the ways a polymorphic pairing can be
    // ill-formed (P004/P005/P010) — reasons a bare `missing` verdict cannot
    // carry. The two agree by construction on the atoms they share.
    const ordinaryInverses = collectInverseCandidates(target, model);
    const namedPolymorphic =
      pairingName === undefined
        ? []
        : relationGroups.filter(
            ([, candidate]) => candidate["~"].state.name === pairingName
          );
    const namedOrdinary =
      pairingName === undefined
        ? []
        : ordinaryInverses.filter(
            (candidate) => candidate.pairingName === pairingName
          );
    if (namedPolymorphic.length > 0 && namedOrdinary.length > 0) {
      issues.push(
        issue(
          "P004",
          `Polymorphic inverse '${relationName}' in '${name}' cannot share pairing name '${pairingName}' with an ordinary inverse`,
          name,
          relationName
        )
      );
      continue;
    }
    if (namedPolymorphic.length !== 1 && ordinaryInverses.length > 0) {
      continue;
    }
    let selectedRelationKey: string | undefined;
    if (relationGroups.length === 1) {
      selectedRelationKey = relationGroups[0]?.[0];
    } else if (pairingName === undefined) {
      issues.push(
        issue(
          "P005",
          `Polymorphic inverse '${relationName}' in '${name}' targets a model with multiple polymorphic relations and requires .name()`,
          name,
          relationName
        )
      );
      continue;
    } else {
      const named = relationGroups.filter(
        ([, candidate]) => candidate["~"].state.name === pairingName
      );
      if (named.length !== 1) {
        issues.push(
          issue(
            "P004",
            `Polymorphic inverse '${relationName}' in '${name}' must select exactly one candidate with .name('${pairingName}')`,
            name,
            relationName
          )
        );
        continue;
      }
      selectedRelationKey = named[0]?.[0];
    }
    const selected = candidates.filter(
      (candidate) => candidate.relationKey === selectedRelationKey
    );
    if (selected?.length !== 1) {
      issues.push(
        issue(
          "P010",
          `Polymorphic inverse '${relationName}' in '${name}' occurs more than once in its selected target map`,
          name,
          relationName
        )
      );
      continue;
    }
    /**
     * P021 — §6.3 ("an inverse of a `toMany` group is optional and clearable")
     * made TRUE BY CONSTRUCTION rather than hoped for.
     *
     * A SINGULAR inverse of a collection (`manyToOne` bound to a collection
     * group) is a slot whose membership is one member-junction row. Its removal
     * verbs — `disconnect` and `delete` — hang on `slotMayBeEmpty(state)`, i.e.
     * on the declaration writing `.optional()`, and on nothing else: the
     * clearability owner's `manyToMany` arm is never consulted for this shape
     * (`validation/relations/update.ts` reaches `membershipCanBeCleared` only on
     * the fields-less `oneToOne` branch). Nor does create-time requiredness fill
     * the gap: `getFkRequirementKeySets` groups only fields-BEARING to-ones and
     * `toOne` polymorphic groups, so a non-optional fields-less inverse carries
     * no create obligation either.
     *
     * Without this rule the declaration is silently degraded: a slot you can
     * fill and never empty, with no error anywhere saying so. Refusing at
     * DEFINITION validation is what keeps `slotMayBeEmpty` a pure one-owner
     * state read — the rejected alternative was a junction-aware override inside
     * the clearability owner, which would put a second, shape-aware writer on
     * the same rule.
     *
     * The PLURAL inverse (`manyToMany` over the same group) is untouched: its
     * `disconnect` short-circuits on `state.type === "manyToMany"`, so an
     * unmarked plural inverse is already clearable and requires nothing.
     */
    const binding = getCompatiblePolymorphicInverseBinding(
      relationState,
      model
    );
    if (
      binding?.groupCardinality === "many" &&
      relationState.type === "manyToOne" &&
      relationState.optional !== true
    ) {
      issues.push(
        issue(
          "P021",
          `Polymorphic inverse '${relationName}' in '${name}' holds at most one membership of collection '${binding.relationKey}' and must be .optional(); without it the slot can be filled but never emptied`,
          name,
          relationName
        )
      );
    }
  }
  return issues;
}

/**
 * The RELATION-WIDE inverse cardinality of one toOne group (plan §2.3). Copy
 * #5 of the shape disjunction, DELIBERATELY NOT widened to the junction
 * shapes: `getCompatiblePolymorphicInverseBinding` refuses a manyToOne /
 * manyToMany over a toOne group, so those shapes can never contribute here —
 * widening the derivation would only let them flip a toOne group's storage
 * shape or trip P012, which is exactly what the projection forbids.
 */
function inverseCardinality(
  schema: Schema,
  owner: Model<any>,
  relationName: string
): PolymorphicInverseCardinality | "mixed" {
  const cardinalities = new Set<PolymorphicInverseCardinality>();
  for (const [, source] of schema) {
    for (const [, relation] of getRelations(source)) {
      const state = relation["~"].state;
      const cardinality =
        state.type === "oneToMany"
          ? "many"
          : state.type === "oneToOne" &&
              (state.fields === undefined || state.fields.length === 0)
            ? "one"
            : undefined;
      if (!cardinality || state.getter() !== owner) continue;
      const binding = getPolymorphicInverseBinding(owner, source, state.name);
      if (binding?.relationKey === relationName) cardinalities.add(cardinality);
    }
  }
  if (cardinalities.size > 1) return "mixed";
  return cardinalities.values().next().value ?? "many";
}

interface CollectionThroughFacts {
  readonly valid: boolean;
  readonly entries: ReadonlyMap<string, PolymorphicThroughEntry>;
}

const THROUGH_ENTRY_KEYS = ["table", "source", "target"] as const;

/**
 * ONE read of a collection state's raw `.through()` map — verdict and
 * extracted entries from the same property reads, so a hostile accessor cannot
 * answer the P017 validation with one value and the naming owner with another
 * (class-built carriers are already data-snapshotted at construction; this
 * discipline covers forced carriers too). Own keys must be exactly the public
 * variants; each entry a plain record with own keys exactly {table, source,
 * target}, all strings — the runtime mirror of the `.through()` type contract.
 */
function readThroughMap(
  through: unknown,
  targetKeys: readonly string[]
): CollectionThroughFacts {
  if (through === undefined) return { valid: true, entries: new Map() };
  const entries = new Map<string, PolymorphicThroughEntry>();
  if (!isPlainRecord(through)) return { valid: false, entries };
  let valid = ownKeys(through).length === targetKeys.length;
  for (const publicType of targetKeys) {
    const entry: unknown = Reflect.get(through, publicType);
    if (!isPlainRecord(entry)) {
      valid = false;
      continue;
    }
    const entryKeyCount = ownKeys(entry).length;
    const table: unknown = Reflect.get(entry, "table");
    const source: unknown = Reflect.get(entry, "source");
    const target: unknown = Reflect.get(entry, "target");
    if (
      entryKeyCount !== THROUGH_ENTRY_KEYS.length ||
      typeof table !== "string" ||
      typeof source !== "string" ||
      typeof target !== "string"
    ) {
      valid = false;
      continue;
    }
    entries.set(publicType, { table, source, target });
  }
  return { valid, entries };
}

/**
 * Schema-wide prepass over every collection member's physical names — the
 * member counterpart of {@link junctionPhysicalNames}, counted rather than
 * merely collected so that one member's check can tell "someone ELSE claims
 * this name" (count > 1) apart from its own single claim. Malformed
 * configuration is skipped silently here; the per-relation loop reports it.
 */
function memberPhysicalNames(
  schema: Schema,
  ctx: ValidationContext
): Map<string, number> {
  const counts = new Map<string, number>();
  const claim = (physicalName: string) =>
    counts.set(physicalName, (counts.get(physicalName) ?? 0) + 1);
  for (const [ownerName, owner] of schema) {
    const ownerTable = owner["~"].state.tableName ?? ownerName;
    const ownerRowKey = getModelKeyCatalog(owner).rowKey?.fields;
    if (!ownerRowKey?.length) continue;
    for (const [relationName, relation] of getPolymorphicRelations(owner)) {
      const state = relation["~"].state;
      if (Reflect.get(state, "cardinality") !== "many") continue;
      const through = readThroughMap(
        Reflect.get(state, "through"),
        ownStringKeys(state.targets)
      );
      for (const {
        publicType,
        targetGetter,
        targetModel,
        storedType,
      } of relation["~"].targetEntries()) {
        if (typeof targetGetter !== "function") continue;
        const targetName =
          targetModel instanceof Model
            ? ctx.modelToName.get(targetModel)
            : undefined;
        if (!(targetModel instanceof Model && targetName !== undefined)) {
          continue;
        }
        if (typeof storedType !== "string") continue;
        const targetRowKey = getModelKeyCatalog(targetModel).rowKey?.fields;
        if (!targetRowKey?.length) continue;
        const names = resolvePolymorphicMemberNames({
          ownerTableName: ownerTable,
          ownerModelName: ownerName,
          relationField: relationName,
          publicType,
          ownerRowKeyIsCompound: ownerRowKey.length > 1,
          targetRowKeyIsCompound: targetRowKey.length > 1,
          through: through.entries.get(publicType),
        });
        claim(names.table);
        try {
          const topology = resolvePolymorphicMemberJunctionTopology({
            table: names.table,
            source: {
              model: owner,
              modelName: ownerName,
              rowKey: ownerRowKey,
              token: names.sourceToken,
            },
            target: {
              model: targetModel,
              modelName: targetName,
              rowKey: targetRowKey,
              token: names.targetToken,
            },
            pairName: `${ownerName}.${relationName}.${publicType}`,
          });
          claim(topology.foreignKeyName("source"));
          claim(topology.foreignKeyName("target"));
          claim(topology.reverseIndexName());
        } catch {
          // The per-relation loop reports malformed member configuration.
        }
      }
    }
  }
  return counts;
}

/**
 * Per-MEMBER inverse cardinality (plan §2.3) — a collection group has no
 * relation-wide storage shape, so each variant's inverse chooses "one" or
 * "many" independently: "one" for a bound fields-less manyToOne, "many" for a
 * bound fields-less manyToMany. The RETAINED shapes contribute NOTHING — they
 * are toOne semantics, dormant over a toMany group in B2. A member bound by
 * more than one inverse relation is conflicted (P015); an unbound member
 * defaults to "many", the shareable reading (plan §2.4).
 */
function collectionMemberInverses(
  schema: Schema,
  owner: Model<any>,
  relationName: string
): {
  readonly cardinalities: ReadonlyMap<string, "one" | "many">;
  readonly conflicted: ReadonlySet<string>;
} {
  const cardinalities = new Map<string, "one" | "many">();
  const conflicted = new Set<string>();
  for (const [, source] of schema) {
    for (const [, relation] of getRelations(source)) {
      const state = relation["~"].state;
      if (state.type !== "manyToOne" && state.type !== "manyToMany") continue;
      if (state.getter() !== owner) continue;
      const binding = getCompatiblePolymorphicInverseBinding(state, source);
      if (binding?.relationKey !== relationName) continue;
      if (cardinalities.has(binding.publicType)) {
        conflicted.add(binding.publicType);
      }
      cardinalities.set(
        binding.publicType,
        state.type === "manyToOne" ? "one" : "many"
      );
    }
  }
  return { cardinalities, conflicted };
}

interface CollectionRelationInput {
  readonly schema: Schema;
  readonly name: string;
  readonly model: Model<any>;
  readonly ctx: ValidationContext;
  readonly relationName: string;
  readonly state: { readonly targets: unknown };
  readonly issues: SchemaValidationIssue[];
  /** Error count taken BEFORE the relation's content phase — the storage gate's baseline. */
  readonly errorCount: number;
  readonly targetEntries: readonly {
    readonly publicType: string;
    readonly targetGetter: unknown;
    readonly targetModel: unknown;
    readonly storedType: unknown;
  }[];
  readonly targetKeys: readonly string[];
  readonly reservedColumns: Set<string>;
  readonly reservedIndexes: Set<string>;
  readonly memberNameCounts: ReadonlyMap<string, number>;
  readonly ownerTable: string;
}

/**
 * The collection content pipeline (plan §5): P017 through-map exactness, P018
 * owner row key, per-target resolution (P001 as the toOne arm spells it, P009
 * in its complete-row-key reading — §13.2 pins that NO portable-representation
 * check applies to a collection), member naming + topology with every
 * `JunctionPhysicalNameError` mapped to P019, per-member inverse cardinality
 * with P015 — then the toOne arm's exact storage gate, storing the
 * `kind: "toMany"` descriptor only for a complete, error-free relation.
 * These rules are the ONLY judges of a collection relation: nothing is appended
 * after this returns (P014's blanket refusal stood there until Package B3).
 */
function validateCollectionRelation(input: CollectionRelationInput): void {
  const {
    schema,
    name,
    model,
    ctx,
    relationName,
    state,
    issues,
    errorCount,
    targetEntries,
    targetKeys,
    reservedColumns,
    reservedIndexes,
    memberNameCounts,
    ownerTable,
  } = input;
  const through = readThroughMap(Reflect.get(state, "through"), targetKeys);
  if (!through.valid) {
    issues.push(
      issue(
        "P017",
        `Polymorphic relation '${relationName}' in '${name}' has an invalid .through() map; it must map exactly the public variants to { table, source, target }`,
        name,
        relationName
      )
    );
  }
  const ownerRowKey = getModelKeyCatalog(model).rowKey?.fields;
  if (!ownerRowKey?.length) {
    issues.push(
      issue(
        "P018",
        `Polymorphic relation '${relationName}' in '${name}' requires a complete owner row key for its member junctions`,
        name,
        relationName
      )
    );
  }

  const resolvedTargets: Array<{
    readonly publicType: string;
    readonly storedType: string;
    readonly targetModel: Model<any>;
    readonly targetName: string;
    readonly rowKey: readonly string[];
  }> = [];
  for (const {
    publicType,
    targetGetter,
    targetModel,
    storedType,
  } of targetEntries) {
    if (typeof targetGetter !== "function") {
      issues.push(
        issue(
          "P001",
          `Polymorphic target '${publicType}' in '${name}.${relationName}' is not a model getter`,
          name,
          relationName
        )
      );
      continue;
    }
    const targetName =
      targetModel instanceof Model
        ? ctx.modelToName.get(targetModel)
        : undefined;
    if (!(targetModel instanceof Model && targetName !== undefined)) {
      issues.push(
        issue(
          "P001",
          `Polymorphic target '${publicType}' in '${name}.${relationName}' is not registered in the schema`,
          name,
          relationName
        )
      );
      continue;
    }
    const rowKey = getModelKeyCatalog(targetModel).rowKey?.fields;
    if (!rowKey?.length) {
      issues.push(
        issue(
          "P009",
          `Polymorphic target '${publicType}' in '${name}.${relationName}' requires a complete row key`,
          name,
          relationName
        )
      );
      continue;
    }
    if (typeof storedType !== "string") continue;
    resolvedTargets.push({
      publicType,
      storedType,
      targetModel,
      targetName,
      rowKey,
    });
  }

  const inverses = collectionMemberInverses(schema, model, relationName);
  for (const publicType of inverses.conflicted) {
    issues.push(
      issue(
        "P015",
        `Polymorphic member '${publicType}' of '${name}.${relationName}' is bound by more than one inverse relation`,
        name,
        relationName
      )
    );
  }

  const members = new Map<string, PolymorphicJunctionMember>();
  if (ownerRowKey?.length) {
    for (const target of resolvedTargets) {
      const names = resolvePolymorphicMemberNames({
        ownerTableName: ownerTable,
        ownerModelName: name,
        relationField: relationName,
        publicType: target.publicType,
        ownerRowKeyIsCompound: ownerRowKey.length > 1,
        targetRowKeyIsCompound: target.rowKey.length > 1,
        through: through.entries.get(target.publicType),
      });
      try {
        const junction = resolvePolymorphicMemberJunctionTopology({
          table: names.table,
          source: {
            model,
            modelName: name,
            rowKey: ownerRowKey,
            token: names.sourceToken,
          },
          target: {
            model: target.targetModel,
            modelName: target.targetName,
            rowKey: target.rowKey,
            token: names.targetToken,
          },
          pairName: `${name}.${relationName}.${target.publicType}`,
        });
        // The validator's historical name-probe order: source fkey, target
        // fkey, reverse index (mirroring `junctionFieldsValid`), then the
        // unique target-side "key" name LAST — it is one character shorter
        // than the already-validated target fkey, so asking it here can never
        // introduce a refusal the fkey ask did not already fire.
        const sourceForeignKey = junction.foreignKeyName("source");
        const targetForeignKey = junction.foreignKeyName("target");
        const reverseIndex = junction.reverseIndexName();
        const uniqueTarget = junction.uniqueTargetName();
        const collision = [names.table, reverseIndex].find(
          (physicalName) =>
            !isValidSchemaIdentifier(physicalName) ||
            reservedColumns.has(physicalName) ||
            reservedIndexes.has(physicalName) ||
            (memberNameCounts.get(physicalName) ?? 0) > 1
        );
        // Reserved even when refused, mirroring the greedy ordinary-junction
        // discipline: a refused member still claims its physical names — the
        // unique target-side name included, whatever the member's inverse
        // cardinality is today, so an inverse flip elsewhere cannot newly
        // collide an already-valid schema.
        reservedIndexes.add(names.table);
        reservedIndexes.add(sourceForeignKey);
        reservedIndexes.add(targetForeignKey);
        reservedIndexes.add(reverseIndex);
        reservedIndexes.add(uniqueTarget);
        if (collision !== undefined) {
          issues.push(
            issue(
              "P019",
              `Polymorphic member '${target.publicType}' in '${name}.${relationName}' has an invalid or colliding junction name '${collision}'`,
              name,
              relationName
            )
          );
          continue;
        }
        members.set(target.publicType, {
          publicType: target.publicType,
          storedType: target.storedType,
          targetModel: target.targetModel,
          inverseCardinality:
            inverses.cardinalities.get(target.publicType) ?? "many",
          junction,
        });
      } catch {
        // Every throw on this path is a physical-name refusal
        // (`JunctionPhysicalNameError`): row-key emptiness is pre-checked by
        // P018 and P009 above, and no other guard exists on the member path.
        reservedIndexes.add(names.table);
        issues.push(
          issue(
            "P019",
            `Polymorphic member '${target.publicType}' in '${name}.${relationName}' has an invalid or colliding junction name '${names.table}'`,
            name,
            relationName
          )
        );
      }
    }
  }

  const nextErrorCount = issues.filter(
    (entry) => entry.severity === "error"
  ).length;
  if (
    nextErrorCount !== errorCount ||
    resolvedTargets.length !== targetEntries.length ||
    resolvedTargets.length === 0
  ) {
    return;
  }
  model["~"].setPolymorphicStorage(relationName, {
    kind: "toMany",
    relationName,
    ownerModel: model,
    members,
  });
}

export function validatePolymorphicRelations(
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx: ValidationContext
): SchemaValidationIssue[] {
  const issues = validateInverseBindings(name, model, ctx);
  const reservedColumns = new Set(
    getScalars(model).map(
      ([field, scalar]) => scalar["~"].state.columnName ?? field
    )
  );
  const reservedIndexes = new Set<string>();
  for (const [candidateName, candidate] of schema) {
    const tableName = candidate["~"].state.tableName ?? candidateName;
    for (const index of candidate["~"].state.indexes) {
      reservedIndexes.add(
        index.options.name ?? `${tableName}_${index.fields.join("_")}_idx`
      );
    }
    const scalars = getScalars(candidate);
    if (
      scalars.some(([, scalar]) => scalar["~"].state.isId) ||
      candidate["~"].state.compoundId
    ) {
      reservedIndexes.add(`${tableName}_pkey`);
    }
    for (const [field, scalar] of scalars) {
      if (scalar["~"].state.isUnique && !scalar["~"].state.isId) {
        const column = scalar["~"].state.columnName ?? field;
        reservedIndexes.add(`${tableName}_${column}_key`);
      }
    }
    for (const constraint of Object.keys(
      candidate["~"].state.compoundUniques ?? {}
    )) {
      reservedIndexes.add(`${tableName}_${constraint}_key`);
    }
    for (const indexName of serializedForeignKeyIndexNames(
      candidate,
      tableName
    )) {
      reservedIndexes.add(indexName);
    }
  }
  for (const tableName of ctx.tableToModels.keys())
    reservedIndexes.add(tableName);
  for (const physicalName of junctionPhysicalNames(schema, ctx)) {
    reservedIndexes.add(physicalName);
  }
  const memberNameCounts = memberPhysicalNames(schema, ctx);
  const ownerTable = model["~"].state.tableName ?? name;

  for (const [relationName, relation] of getPolymorphicRelations(model)) {
    const errorCount = issues.filter(
      (entry) => entry.severity === "error"
    ).length;
    const state = relation["~"].state;
    // Read raw: the input is untrusted here. `s.polymorphicToOne` and
    // `s.polymorphicToMany` each stamp their own cardinality, so no spelling
    // reaches this branch — but a forged carrier handed straight to a terminal's
    // constructor can, and this one site establishes the fact that every reader
    // downstream takes from `polymorphicCardinality`.
    const declaredCardinality: unknown = Reflect.get(state, "cardinality");
    if (declaredCardinality !== "one" && declaredCardinality !== "many") {
      issues.push(
        issue(
          "P013",
          `Polymorphic relation '${relationName}' in '${name}' carries no cardinality; declare it with s.polymorphicToOne() or s.polymorphicToMany()`,
          name,
          relationName
        )
      );
      continue;
    }
    const targets: unknown = state.targets;
    const values: unknown = state.values;
    const targetOwnKeys = ownKeys(targets);
    const valueOwnKeys = ownKeys(values);
    const targetKeys = ownStringKeys(targets);
    const valueKeys = ownStringKeys(values);

    if (isPlainRecord(targets) && targetKeys.length === 0) {
      issues.push(
        issue(
          "P007",
          `Polymorphic relation '${relationName}' in '${name}' requires at least one target`,
          name,
          relationName
        )
      );
    }
    const targetEntries = isPlainRecord(targets)
      ? relation["~"].targetEntries()
      : [];
    if (targetKeys.length === 1) {
      issues.push(
        issue(
          "P011",
          `Polymorphic relation '${relationName}' in '${name}' has one target; use an ordinary relation unless future variants are required`,
          name,
          relationName,
          "warning"
        )
      );
    }

    const exactValues =
      isPlainRecord(targets) &&
      isPlainRecord(values) &&
      targetOwnKeys.length === targetKeys.length &&
      valueOwnKeys.length === valueKeys.length &&
      targetKeys.length === valueKeys.length &&
      targetKeys.every((publicType) => valueKeys.includes(publicType));
    const storedValues = isPlainRecord(values)
      ? valueKeys.map((publicType) => Reflect.get(values, publicType))
      : [];
    if (
      !exactValues ||
      targetKeys.some((publicType) => !isValidSchemaIdentifier(publicType)) ||
      storedValues.some(
        (storedType) =>
          typeof storedType !== "string" || !STORED_TYPE.test(storedType)
      ) ||
      new Set(storedValues).size !== storedValues.length
    ) {
      issues.push(
        issue(
          "P003",
          `Polymorphic relation '${relationName}' in '${name}' has invalid or non-unique discriminator keys/values`,
          name,
          relationName
        )
      );
    }

    if (declaredCardinality === "many") {
      validateCollectionRelation({
        schema,
        name,
        model,
        ctx,
        relationName,
        state,
        issues,
        errorCount,
        targetEntries,
        targetKeys,
        reservedColumns,
        reservedIndexes,
        memberNameCounts,
        ownerTable,
      });
      /**
       * NO BLANKET REFUSAL HERE. P014 stood at exactly this point until
       * Package B3, because a collection descriptor existed with no DDL behind
       * it. It has DDL now — the serializer emits one member junction table per
       * variant from this same stored topology — so a well-formed collection
       * schema is a legal schema, and `validateCollectionRelation` above is its
       * only judge.
       *
       * What a collection schema still cannot do is be READ or WRITTEN through
       * the client: that refusal moved to the grammar owner, where
       * `getPolymorphicRelationsSchemas` omits all six operation-schema
       * families for a `"many"` group and the strict object refuses every
       * collection key as unknown at parse. Reinstating a definition-level
       * refusal here would be a second guard on that invariant and would also
       * make the schema unmigratable, which is precisely what B3 fixed.
       */
      continue;
    }

    const typeColumnName = `${relationName}_type`;
    const idColumnName = `${relationName}_id`;
    const indexName = `${ownerTable}_${relationName}_poly_idx`;
    const generatedNamesValid =
      isValidSchemaIdentifier(typeColumnName) &&
      isValidSchemaIdentifier(idColumnName) &&
      isValidSchemaIdentifier(indexName) &&
      !reservedColumns.has(typeColumnName) &&
      !reservedColumns.has(idColumnName) &&
      !reservedIndexes.has(indexName) &&
      [...schema].filter(([candidateName, candidate]) => {
        const table = candidate["~"].state.tableName ?? candidateName;
        return getPolymorphicRelations(candidate).some(
          ([candidateRelation]) =>
            `${table}_${candidateRelation}_poly_idx` === indexName
        );
      }).length === 1;
    if (!generatedNamesValid) {
      issues.push(
        issue(
          "P008",
          `Polymorphic relation '${relationName}' in '${name}' has invalid or colliding generated storage names`,
          name,
          relationName
        )
      );
    }
    reservedColumns.add(typeColumnName);
    reservedColumns.add(idColumnName);
    reservedIndexes.add(indexName);

    const resolvedTargets: Array<{
      readonly publicType: string;
      readonly storedType: string;
      readonly targetModel: Model<any>;
      readonly primaryKey: { readonly field: string; readonly scalar: Scalar };
    }> = [];
    for (const {
      publicType,
      targetGetter,
      targetModel,
      storedType,
    } of targetEntries) {
      if (typeof targetGetter !== "function") {
        issues.push(
          issue(
            "P001",
            `Polymorphic target '${publicType}' in '${name}.${relationName}' is not a model getter`,
            name,
            relationName
          )
        );
        continue;
      }
      if (!(targetModel instanceof Model && ctx.modelToName.has(targetModel))) {
        issues.push(
          issue(
            "P001",
            `Polymorphic target '${publicType}' in '${name}.${relationName}' is not registered in the schema`,
            name,
            relationName
          )
        );
        continue;
      }
      const primaryKey = singlePrimaryKey(targetModel);
      if (!primaryKey) {
        issues.push(
          issue(
            "P009",
            `Polymorphic target '${publicType}' in '${name}.${relationName}' requires one scalar primary key`,
            name,
            relationName
          )
        );
        continue;
      }
      if (typeof storedType !== "string") continue;
      resolvedTargets.push({
        publicType,
        storedType,
        targetModel,
        primaryKey,
      });
    }

    const firstType = resolvedTargets[0]?.primaryKey.scalar["~"].state.type;
    const portableIds = resolvedTargets.every(({ primaryKey }) => {
      const scalar = primaryKey.scalar;
      return (
        PORTABLE_ID_TYPES.has(scalar["~"].state.type) &&
        !scalar["~"].state.array &&
        scalar["~"].nativeType === undefined &&
        scalar["~"].state.type === firstType
      );
    });
    if (resolvedTargets.length > 0 && !portableIds) {
      issues.push(
        issue(
          "P002",
          `Polymorphic targets in '${name}.${relationName}' require one compatible portable primary-key representation`,
          name,
          relationName
        )
      );
    }

    const nextErrorCount = issues.filter(
      (entry) => entry.severity === "error"
    ).length;
    if (
      nextErrorCount !== errorCount ||
      resolvedTargets.length !== targetEntries.length ||
      resolvedTargets.length === 0
    ) {
      continue;
    }

    const firstTarget = resolvedTargets[0]!;
    const cardinality = inverseCardinality(schema, model, relationName);
    if (cardinality === "mixed") {
      issues.push(
        issue(
          "P012",
          `Polymorphic relation '${relationName}' in '${name}' cannot mix one-to-one and one-to-many inverses`,
          name,
          relationName
        )
      );
      continue;
    }
    const members = new Map<string, PolymorphicStorageMember>();
    for (const target of resolvedTargets) {
      members.set(target.publicType, {
        storedType: target.storedType,
        targetModel: target.targetModel,
        referencedField: target.primaryKey.field,
      });
    }
    const nullable = state.optional === true;
    model["~"].setPolymorphicStorage(relationName, {
      kind: "toOne",
      relationName,
      ownerModel: model,
      indexName,
      typeColumn: { name: typeColumnName, scalar: string(), nullable },
      idColumn: {
        name: idColumnName,
        scalar: firstTarget.primaryKey.scalar,
        nullable,
      },
      inverseCardinality: cardinality,
      members,
    });
  }
  return issues;
}

export const polymorphicRules: ValidationRule[] = [
  validatePolymorphicRelations,
];
