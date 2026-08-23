/**
 * Resolved junction topology — the one owner of a junction's physical facts:
 * the table, both complete ordered sides, the canonical side order, the pair
 * identity, and the derived constraint names.
 *
 * DELIBERATELY NOT exported from the relation barrel (`./index.ts`): the public
 * API of `viborm/schema` stays frozen, and every consumer deep-imports this
 * module.
 *
 * ONE ENTRY, ONE CALLER. The full-schema relation resolver hands this owner an
 * already-paired, already-oriented junction and stores the result on the
 * resolved edge; engine binder and migration serializer read that stored value
 * instead of expanding a second time. Ordinary pairs and variant member
 * junctions differ only in where their tokens come from, so they share one
 * derivation rather than two entry points with two refusal orders.
 *
 * Constraint names stay lazy memoized METHODS. The gate asks all four during
 * resolution, so a published edge carries them settled; laziness is what keeps
 * the equal-token refusal attached to the first ask rather than to construction.
 */

import type { Model } from "../model";
import {
  expandJunctionFieldGroups,
  generateJunctionFieldName,
  getJunctionConstraintName,
  type JunctionFieldGroup,
  JunctionPhysicalNameError,
  junctionSourceSideIsFirst,
} from "./helpers";
import type { VariantJunctionOverride } from "./types";

export interface JunctionEndpointInput {
  /** Carried opaquely; the owner never dereferences it (the engine projects it into its `JunctionSide`). */
  readonly model: Model<any>;
  /**
   * The CALLER's established name spelling: the engine passes
   * `names.ts ?? "unknown"`, the resolver passes schema keys — identical only
   * because hydration sets `names.ts` to the key. The owner must not re-derive
   * names.
   */
  readonly modelName: string;
  /**
   * Complete ordered row key, resolved by the CALLER. May be empty — the owner
   * forwards it so `expandJunctionFieldGroups` stays the SINGLE emptiness
   * guard.
   */
  readonly rowKey: readonly string[];
  /** The side naming token, resolved by the caller from overrides or defaults. */
  readonly token: string;
}

export interface JunctionTopologyInput {
  readonly table: string;
  readonly source: JunctionEndpointInput;
  readonly target: JunctionEndpointInput;
  readonly pairName: string | undefined;
}

/** One junction column paired with the endpoint field it references. */
export interface ResolvedJunctionMember {
  readonly junctionField: string;
  readonly referencedField: string;
}

export interface ResolvedJunctionSide {
  readonly model: Model<any>;
  readonly modelName: string;
  /** The declared side token or its generated equivalent — the constraint-name input. */
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
   * token-expanded junction fields. A plain fact for the serializer; the
   * engine's `BoundJunctionMembership` does NOT gain this field and
   * membership-scope equality stays orientation-erased.
   */
  readonly sourceIsFirst: boolean;
  /** The agreed relation-name claim — pair-identity input for the serializer's dedupe key. */
  readonly pairName: string | undefined;
  /** `${table}_${sideToken}_fkey` via `getJunctionConstraintName`. Memoized per side. */
  foreignKeyName(side: "source" | "target"): string;
  /** `${table}_${secondToken}_idx` over the canonical SECOND side. Memoized. */
  reverseIndexName(): string;
  /**
   * `${table}_${targetToken}_key` over the complete TARGET side — the
   * singular-inverse unique-constraint name.
   */
  uniqueTargetName(): string;
}

/**
 * Resolve one junction's complete physical topology.
 *
 * Throws exactly what `expandJunctionFieldGroups` throws (row-key emptiness,
 * token identifier, expanded-field identifier, cross-side collision) and adds
 * no guard of its own beyond the equal-token refusal on the first fkey ask.
 */
export function resolveJunctionTopology(
  input: JunctionTopologyInput
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

export interface VariantMemberNames {
  readonly table: string;
  readonly sourceToken: string;
  readonly targetToken: string;
}

/**
 * The ONE owner of a variant collection member's junction names.
 *
 * Defaults: the table is `${ownerTable}_${relationField}_${publicType}`
 * (declaration-shaped, NOT the sorted-alphabetical ordinary generator — a
 * member junction has an owner side and a variant side, not two peers); the
 * source token follows the ordinary convention (compound row key → lowercased
 * owner schema key as a positional prefix, scalar →
 * `<lowercasedOwnerSchemaKey>Id`); the target token is
 * VARIANT-derived (`publicType` rather than the target model's name), which
 * keeps same-model duplicate variants and self targets naturally distinct — a
 * self target whose variant spells the owner's own name collides and is refused
 * through the one cross-side collision guard, escaped via `.through()`. An
 * explicit `.through()` entry overrides all three names.
 *
 * The owner RETURNS NAMES ONLY. Identifier and length refusals fire where each
 * name is consumed.
 */
export function resolveVariantMemberNames(input: {
  readonly ownerTableName: string;
  readonly ownerModelName: string;
  readonly relationField: string;
  readonly publicType: string;
  readonly ownerRowKeyIsCompound: boolean;
  readonly targetRowKeyIsCompound: boolean;
  readonly junction: VariantJunctionOverride | undefined;
}): VariantMemberNames {
  if (input.junction) {
    return {
      table: input.junction.table,
      sourceToken: input.junction.source,
      targetToken: input.junction.target,
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

/** Per-side facts the relation-free derivation consumes. */
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
      // never sees them.
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
      // for the same row-key list zipped here, so this lookup cannot miss.
      junctionField: side.fields[index]!,
      referencedField,
    })),
  };
}
