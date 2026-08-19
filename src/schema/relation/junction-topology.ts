/**
 * Resolved junction topology — the one owner of an ordinary many-to-many
 * pair's physical junction facts: the table, both complete ordered sides,
 * the canonical side order, the pair identity, and the derived constraint
 * names. Engine binder, migration serializer, and post-resolution validators
 * all read this projection instead of privately reconstructing it.
 *
 * DELIBERATELY NOT exported from the relation barrel (`./index.ts`): the
 * public API of `viborm/schema` stays frozen, and every consumer deep-imports
 * this module exactly as it already deep-imports `./helpers`.
 *
 * CALLER-POSITIONED CONSTRUCTION, CALLER-SEQUENCED NAMES — a permanent design
 * contract, not a transitional state. Each consumer's configuration-error
 * order is byte-pinned history: the engine reconciles the raw A/B pair before
 * either endpoint's row key is requested; the serializer resolves referential
 * actions, then row keys, before A/B; the validators ask for the three
 * constraint names in yet another sequence. The owner therefore never
 * resolves the table (the caller does, via `getJunctionTableName`, so table
 * refusals keep firing at each caller's historical position), never derives
 * model names or row keys (callers forward them, possibly empty, so
 * `getJunctionFieldGroups` stays the single emptiness guard), and exposes
 * constraint names as lazy memoized METHODS so the first ask — which differs
 * per consumer — is where a name refusal fires. Unifying those orders is an
 * explicit product decision, never a refactor.
 *
 * The module is layered as (i) ordinary-config acquisition — the
 * `getJunctionFieldGroups` call over the relation pair — and (ii) a
 * relation-free derivation from `{table, per-side {model, modelName, token,
 * fields, rowKey}, pairName}` (member zip, canonical order, name methods).
 * `resolvePolymorphicMemberJunctionTopology` feeds that same derivation with
 * tokens taken directly from the directed `.through()` map or the member
 * defaults `resolvePolymorphicMemberNames` owns; its referential actions are
 * fixed cascade, so `resolveJunctionPairActions` is never called on that path,
 * and no synthetic manyToMany state exists anywhere.
 */

import type { Model } from "../model";
import {
  expandJunctionFieldGroups,
  findPairedManyToManyState,
  generateJunctionFieldName,
  getJunctionConstraintName,
  getJunctionFieldGroups,
  type JunctionFieldGroup,
  JunctionPhysicalNameError,
  junctionSourceSideIsFirst,
  type RelationLike,
} from "./helpers";
import type { PolymorphicThroughEntry } from "./polymorphic";
import type { ReferentialAction } from "./types";

export interface JunctionEndpointInput {
  /** Carried opaquely; the owner never dereferences it (the engine projects it into its `JunctionSide`). */
  readonly model: Model<any>;
  /**
   * The CALLER's established name spelling: the engine passes
   * `names.ts ?? "unknown"`, serializer and validators pass schema keys —
   * identical only because hydration sets `names.ts` to the key. The owner
   * must not re-derive names.
   */
  readonly modelName: string;
  /**
   * Complete ordered row key, resolved by the CALLER with its own refusal
   * wording (engine: `QueryEngineError`; serializer: hydration wording;
   * validators: silent skip). May be empty — the owner forwards it so
   * `getJunctionFieldGroups` stays the SINGLE emptiness guard.
   */
  readonly rowKey: readonly string[];
}

export interface OrdinaryJunctionPairInput {
  /**
   * The manyToMany relation as seen FROM source. Pair reconciliation stays
   * inside the existing helpers this owner calls.
   */
  readonly relation: RelationLike;
  /**
   * Resolved FIRST by the caller via `getJunctionTableName` — table refusals
   * (through-disagreement, pair ambiguity) must keep firing at each caller's
   * historical position, before anything below.
   */
  readonly table: string;
  readonly source: JunctionEndpointInput;
  readonly target: JunctionEndpointInput;
}

/** One junction column paired with the endpoint field it references. */
export interface ResolvedJunctionMember {
  readonly junctionField: string;
  readonly referencedField: string;
}

export interface ResolvedJunctionSide {
  readonly model: Model<any>;
  readonly modelName: string;
  /** The `.A()`/`.B()` naming token or its generated equivalent — the constraint-name input. */
  readonly token: string;
  /** Complete ordered stored reference, model-key-catalog order (index-aligned with the input rowKey). */
  readonly members: readonly ResolvedJunctionMember[];
}

export interface ResolvedJunctionTopology {
  readonly table: string;
  readonly source: ResolvedJunctionSide;
  readonly target: ResolvedJunctionSide;
  /**
   * Canonical physical side order — `junctionSourceSideIsFirst` over the
   * token-expanded junction fields. A plain fact for the serializer and the
   * validators; the engine's `BoundJunctionMembership` does NOT gain this
   * field and membership-scope equality stays orientation-erased.
   */
  readonly sourceIsFirst: boolean;
  /** `state.name ?? paired?.name` — pair-identity input for the serializer's dedupe key. */
  readonly pairName: string | undefined;
  /**
   * `${table}_${sideToken}_fkey` via `getJunctionConstraintName`. Memoized
   * PER SIDE; computed on first call so CALLER SEQUENCING decides which
   * `JunctionPhysicalNameError` surfaces first (the validator asks
   * source → target → idx; the serializer asks idx → canonical-first →
   * canonical-second — both orders must survive).
   */
  foreignKeyName(side: "source" | "target"): string;
  /** `${table}_${secondToken}_idx` over the canonical SECOND side. Memoized. */
  reverseIndexName(): string;
  /**
   * `${table}_${targetToken}_key` over the complete TARGET side — the
   * singular-inverse unique-constraint name of a polymorphic member junction.
   * Memoized; asked LAST by both consumers (validator and serializer) so the
   * established refusal positions of the other three names stay put.
   */
  uniqueTargetName(): string;
}

/**
 * Resolve the complete junction topology of one ordinary many-to-many pair.
 *
 * Construction is placed exactly where every consumer calls
 * `getJunctionFieldGroups` today, so it throws exactly what that call throws
 * (row-key emptiness, A/B pair disagreement, token identifier, expanded-field
 * identifier, cross-side collision) at each consumer's historical position —
 * and adds NO guard of its own.
 */
export function resolveOrdinaryJunctionTopology(
  input: OrdinaryJunctionPairInput
): ResolvedJunctionTopology {
  const groups = getJunctionFieldGroups(
    input.relation,
    input.source.modelName,
    input.target.modelName,
    input.source.rowKey,
    input.target.rowKey
  );
  // The pair lookup's ambiguity refusal already fired at the caller's earlier
  // `getJunctionTableName` step, and fires inside the groups call above.
  const state = input.relation["~"].state;
  const pairName =
    state.name ?? findPairedManyToManyState(input.relation)?.name;
  return deriveJunctionTopology({
    table: input.table,
    source: sideFacts(input.source, groups.source),
    target: sideFacts(input.target, groups.target),
    pairName,
  });
}

export interface ResolvedJunctionPairActions {
  readonly onDelete: ReferentialAction | undefined;
  readonly onUpdate: ReferentialAction | undefined;
}

/**
 * Merge the pair's configured referential actions (either side may carry
 * them), refusing disagreement with the serializer's EXACT historical
 * messages, which embed `table`. Returns configured-or-undefined: the cascade
 * default and the driver mapping remain serializer policy
 * (`mapReferentialAction`). NEVER called by the engine — the bind path stays
 * action-refusal-free by construction (`BoundJunctionMembership` carries no
 * action field, and relation-key legality depends on refusal-free binds).
 */
export function resolveJunctionPairActions(
  relation: RelationLike,
  table: string
): ResolvedJunctionPairActions {
  const state = relation["~"].state;
  const paired = findPairedManyToManyState(relation);
  if (
    state.onDelete &&
    paired?.onDelete &&
    state.onDelete !== paired.onDelete
  ) {
    throw new Error(
      `Many-to-many relation pair for junction "${table}" disagrees on onDelete: '${state.onDelete}' vs '${paired.onDelete}'.`
    );
  }
  if (
    state.onUpdate &&
    paired?.onUpdate &&
    state.onUpdate !== paired.onUpdate
  ) {
    throw new Error(
      `Many-to-many relation pair for junction "${table}" disagrees on onUpdate: '${state.onUpdate}' vs '${paired.onUpdate}'.`
    );
  }
  return {
    onDelete: state.onDelete ?? paired?.onDelete,
    onUpdate: state.onUpdate ?? paired?.onUpdate,
  };
}

/** One endpoint of a polymorphic member junction: the ordinary endpoint facts plus the side naming token the caller resolved. */
export interface PolymorphicMemberJunctionInput {
  /** Caller-resolved by {@link resolvePolymorphicMemberNames} (or an explicit `.through()` entry), mirroring the ordinary table contract: refusals fire where the name is consumed, never here. */
  readonly table: string;
  readonly source: JunctionEndpointInput & { readonly token: string };
  readonly target: JunctionEndpointInput & { readonly token: string };
  readonly pairName: string | undefined;
}

/**
 * Resolve the complete junction topology of ONE polymorphic collection member —
 * a fixed-target junction between the owner model and one variant's model.
 *
 * No relation, no pair reconciliation, and no synthetic manyToMany state exist
 * on this path: the tokens arrive directly from the directed `.through()` entry
 * or the member defaults, so the pair-agreement guards never apply, and the
 * referential actions are fixed cascade, so {@link resolveJunctionPairActions}
 * is NEVER called for a member junction. Everything else — expansion guards,
 * canonical order, lazy caller-sequenced name methods — is byte-shared with the
 * ordinary derivation through `expandJunctionFieldGroups` and
 * `deriveJunctionTopology`.
 */
export function resolvePolymorphicMemberJunctionTopology(
  input: PolymorphicMemberJunctionInput
): ResolvedJunctionTopology {
  const groups = expandJunctionFieldGroups(
    input.source.modelName,
    input.target.modelName,
    input.source.token,
    input.target.token,
    input.source.rowKey,
    input.target.rowKey
  );
  return deriveJunctionTopology({
    table: input.table,
    source: sideFacts(input.source, groups.source),
    target: sideFacts(input.target, groups.target),
    pairName: input.pairName,
  });
}

export interface PolymorphicMemberNames {
  readonly table: string;
  readonly sourceToken: string;
  readonly targetToken: string;
}

/**
 * The ONE owner of a polymorphic collection member's junction names.
 *
 * Defaults: the table is `${ownerTable}_${relationField}_${publicType}`
 * (declaration-shaped, NOT the sorted-alphabetical ordinary generator — a
 * member junction has an owner side and a variant side, not two peers); the
 * source token mirrors `resolveJunctionFieldTokens`' convention (compound row
 * key → lowercased model name as a positional prefix, scalar → `modelId`); the
 * target token is VARIANT-derived (`publicType` rather than the target model's
 * name), which keeps same-model duplicate variants and self targets naturally
 * distinct — a self target whose variant spells the owner's own name collides
 * and is refused through the one cross-side collision guard, escaped via
 * `.through()`. An explicit `.through()` entry overrides all three names.
 *
 * The owner RETURNS NAMES ONLY. Identifier and length refusals fire where each
 * name is consumed: tokens and expanded fields through
 * `expandJunctionFieldGroups` / `getJunctionConstraintName`
 * (`JunctionPhysicalNameError`), the table through the definition-validation
 * rule (`isValidSchemaIdentifier` + reservation sets, issue P019).
 */
export function resolvePolymorphicMemberNames(input: {
  readonly ownerTableName: string;
  readonly ownerModelName: string;
  readonly relationField: string;
  readonly publicType: string;
  readonly ownerRowKeyIsCompound: boolean;
  readonly targetRowKeyIsCompound: boolean;
  readonly through: PolymorphicThroughEntry | undefined;
}): PolymorphicMemberNames {
  if (input.through) {
    return {
      table: input.through.table,
      sourceToken: input.through.source,
      targetToken: input.through.target,
    };
  }
  return {
    table: `${input.ownerTableName}_${input.relationField}_${input.publicType}`,
    sourceToken: input.ownerRowKeyIsCompound
      ? input.ownerModelName.toLowerCase()
      : generateJunctionFieldName(input.ownerModelName),
    targetToken: input.targetRowKeyIsCompound
      ? input.publicType.toLowerCase()
      : generateJunctionFieldName(input.publicType),
  };
}

/** Per-side facts the relation-free derivation consumes (the B2 seam's input). */
interface JunctionSideFacts {
  readonly model: Model<any>;
  readonly modelName: string;
  readonly token: string;
  readonly fields: readonly string[];
  readonly rowKey: readonly string[];
}

interface JunctionTopologyFacts {
  readonly table: string;
  readonly source: JunctionSideFacts;
  readonly target: JunctionSideFacts;
  readonly pairName: string | undefined;
}

function sideFacts(
  endpoint: JunctionEndpointInput,
  group: JunctionFieldGroup
): JunctionSideFacts {
  return {
    model: endpoint.model,
    modelName: endpoint.modelName,
    token: group.token,
    fields: group.fields,
    rowKey: endpoint.rowKey,
  };
}

/** Relation-free half of the resolution: member zip, canonical order, names. */
function deriveJunctionTopology(
  facts: JunctionTopologyFacts
): ResolvedJunctionTopology {
  const { table, source, target, pairName } = facts;
  const sourceIsFirst = junctionSourceSideIsFirst(
    source.modelName,
    source.fields,
    target.modelName,
    target.fields
  );
  const canonicalSecond = sourceIsFirst ? target : source;
  let sourceForeignKey: string | undefined;
  let targetForeignKey: string | undefined;
  let reverseIndex: string | undefined;
  let uniqueTarget: string | undefined;
  return {
    table,
    source: resolveSide(source),
    target: resolveSide(target),
    sourceIsFirst,
    pairName,
    foreignKeyName(side: "source" | "target"): string {
      // The SOLE guard against duplicate `${table}_${token}_fkey` names from
      // equal side tokens whose EXPANSIONS differ in arity (explicit scalar
      // token vs generated compound prefix): the expanded-field collision guard
      // never sees them, and JT004's raw check is blind to generated compound
      // prefixes by its own doc. Lazy, before memoizing, so each caller's
      // historical first-ask position stays where the refusal fires.
      if (source.token === target.token) {
        throw new JunctionPhysicalNameError(
          "collision",
          `Junction sides of '${table}' share naming token '${source.token}' and would derive the same foreign-key constraint name.`
        );
      }
      if (side === "source") {
        sourceForeignKey ??= getJunctionConstraintName(table, source, "fkey");
        return sourceForeignKey;
      }
      targetForeignKey ??= getJunctionConstraintName(table, target, "fkey");
      return targetForeignKey;
    },
    reverseIndexName(): string {
      reverseIndex ??= getJunctionConstraintName(table, canonicalSecond, "idx");
      return reverseIndex;
    },
    uniqueTargetName(): string {
      uniqueTarget ??= getJunctionConstraintName(table, target, "key");
      return uniqueTarget;
    },
  };
}

function resolveSide(side: JunctionSideFacts): ResolvedJunctionSide {
  return {
    model: side.model,
    modelName: side.modelName,
    token: side.token,
    members: side.rowKey.map((referencedField, index) => ({
      // `junctionFieldGroup` (helpers.ts) returns exactly `rowKeyArity` fields
      // for the same row-key list zipped here, so this lookup cannot miss. The
      // two historical consumer arity guards this zip replaces were unreachable
      // by the same argument and pinned by no test; an unreachable guard here
      // would violate one-guard-per-invariant and make the 100% relations
      // coverage gate unsatisfiable.
      junctionField: side.fields[index]!,
      referencedField,
    })),
  };
}
