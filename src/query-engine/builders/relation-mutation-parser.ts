import type {
  PolymorphicJunctionMember,
  PolymorphicToOneStorage,
} from "@schema/relation";
import {
  splitToOneUpdateTarget,
  type ToOneUpdateEnvelope,
  toOneUpdateSourceData,
} from "@validation/relations/to-one-update-form";
import { isRecord } from "@validation/value-guards";
import {
  getPolymorphicRelationInfo,
  getRelationInfo,
  isPolymorphicRelation,
  isRelation,
} from "../context";
import {
  isPolymorphicToOneRelationInfo,
  NestedWriteError,
  type PolymorphicRelationInfo,
  type PolymorphicToManyRelationInfo,
  type QueryScope,
  type RelationInfo,
  type ResolvedPolymorphicEdge,
} from "../types";
import { bindPolymorphicCollectionMember } from "./polymorphic-collection-mutation";
import { resolvePolymorphicMutationIntent } from "./polymorphic-mutation";
import type { JunctionBoundRelation } from "./relation-data-builder";

export interface ConnectOrCreateInput {
  readonly where: Record<string, unknown>;
  readonly create: RecordMutationData;
}

export interface NestedUpdateManyInput {
  readonly where?: Record<string, unknown>;
  readonly data: RecordMutationData;
}

/**
 * One schema-transformed record mutation beside the exact caller record that
 * produced it. The source is absent only for internal callers that already lost
 * the trust-boundary input; it is never reconstructed from `parsed`, because
 * validation transforms are not idempotent.
 */
export interface RecordMutationData {
  readonly parsed: Record<string, unknown>;
  readonly source: Record<string, unknown> | undefined;
}

/**
 * **The own-write linearization order (ATOM's `Mutation order`).** The ONE sequence
 * in which sibling mutation kinds on a single relation compose — used both to EMIT
 * the parts and to DERIVE their legality, so the soundness theorem is stated over
 * exactly the order that runs. Read that doctrine before touching it; the three
 * stages are:
 *
 *  1. **named readers** — kinds that address rows they NAME and read committed state
 *     to do it (`disconnect`, `delete`, `update`, `upsert`, `connectOrCreate`). Their
 *     writes are bounded by the identity the payload spells.
 *  2. **unbounded writers** — kinds whose footprint is a whole-membership declaration
 *     or a filter (`set`, `updateMany`, `deleteMany`). Every read must precede them.
 *  3. **pure adders** — kinds that read nothing (`connect`, `create`, `createMany`).
 *     Their writes land last, where no decision read can be invalidated by them.
 *
 * The stage boundary is the invariant: **every read is ordered before every write it
 * could not bound.** What survives rejection is then only a genuine payload
 * contradiction — two kinds naming the SAME row — never an artefact of the order.
 */
const RELATION_MUTATION_KEYS = [
  // 1 — named readers
  "disconnect",
  "delete",
  "update",
  "upsert",
  "connectOrCreate",
  // 2 — unbounded writers
  "set",
  "updateMany",
  "deleteMany",
  // 3 — pure adders
  "connect",
  "create",
  "createMany",
] as const;

export interface PartitionedModelData {
  readonly scalarData: Record<string, unknown>;
  readonly relationPayloads: Readonly<
    Record<
      string,
      {
        readonly relationInfo: RelationInfo;
        readonly payload: unknown;
      }
    >
  >;
  /**
   * WIDENED IN PACKAGE D to carry either storage arm. A collection key
   * partitions here now, because its write family is real; every consumer
   * dispatches on `storage.kind` at the point where the two storages stop
   * meaning the same thing, and the ONE consumer that cannot — the bulk
   * `createMany` shortcut, which stores private owner columns — narrows with
   * `isPolymorphicToOneRelationInfo` before it reads.
   */
  readonly polymorphicPayloads: Readonly<
    Record<
      string,
      {
        readonly relation: PolymorphicRelationInfo;
        readonly payload: unknown;
      }
    >
  >;
}

export interface CorrelatedRelationMutationTarget {
  readonly kind: "correlated";
  readonly filter?: Record<string, unknown>;
}

export interface UniqueRelationMutationTarget {
  readonly kind: "unique";
  readonly where: Record<string, unknown>;
}

export interface NormalizedRelationUpdate {
  readonly target:
    | CorrelatedRelationMutationTarget
    | UniqueRelationMutationTarget;
  readonly data: RecordMutationData;
}

export interface NormalizedRelationUpsert {
  readonly target:
    | CorrelatedRelationMutationTarget
    | UniqueRelationMutationTarget;
  readonly create: RecordMutationData;
  readonly update: RecordMutationData;
}

export type CurrentOrSelectorTargets =
  | { readonly kind: "current" }
  | {
      readonly kind: "selectors";
      readonly targets: readonly Record<string, unknown>[];
    };

export type RelationMutationEntry =
  | {
      readonly kind: "create";
      readonly items: readonly RecordMutationData[];
    }
  | {
      readonly kind: "createMany";
      readonly rows: readonly RecordMutationData[];
      readonly skipDuplicates?: boolean;
    }
  | {
      readonly kind: "connect";
      readonly targets: readonly Record<string, unknown>[];
    }
  | {
      readonly kind: "connectOrCreate";
      readonly items: readonly ConnectOrCreateInput[];
    }
  | {
      readonly kind: "disconnect";
      readonly target: CurrentOrSelectorTargets;
    }
  | {
      readonly kind: "delete";
      readonly target: CurrentOrSelectorTargets;
    }
  | {
      readonly kind: "set";
      readonly targets: readonly Record<string, unknown>[];
    }
  | {
      readonly kind: "update";
      readonly items: readonly NormalizedRelationUpdate[];
    }
  | {
      readonly kind: "updateMany";
      readonly items: readonly NestedUpdateManyInput[];
    }
  | {
      readonly kind: "deleteMany";
      readonly filters: readonly Record<string, unknown>[];
    }
  | {
      readonly kind: "upsert";
      readonly items: readonly NormalizedRelationUpsert[];
    };

export interface RelationMutationProgram {
  readonly relationInfo: RelationInfo;
  readonly entries: readonly RelationMutationEntry[];
}

export function partitionModelData(
  ctx: QueryScope,
  data: Record<string, unknown>
): PartitionedModelData {
  const scalarData: Record<string, unknown> = {};
  const relationPayloads: Record<
    string,
    { readonly relationInfo: RelationInfo; readonly payload: unknown }
  > = {};
  const polymorphicPayloads: Record<
    string,
    {
      readonly relation: PolymorphicRelationInfo;
      readonly payload: unknown;
    }
  > = {};

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (isPolymorphicRelation(ctx.model, key)) {
      const relation = getPolymorphicRelationInfo(ctx, key);
      // BOTH ARMS, since Package D. Package C widened the scope to carry
      // collection storage for READS only, and a collection key partitioned into
      // nothing because its write family was refused by name. D makes that family
      // real, so the key partitions here and `buildPolymorphicMutationProgram`
      // dispatches on the storage arm.
      if (relation) {
        polymorphicPayloads[key] = { relation, payload: value };
      }
      continue;
    }
    if (!isRelation(ctx.model, key)) {
      scalarData[key] = value;
      continue;
    }

    const relationInfo = getRelationInfo(ctx, key);
    if (relationInfo) relationPayloads[key] = { relationInfo, payload: value };
  }

  return { scalarData, relationPayloads, polymorphicPayloads };
}

/**
 * Build one relation program from schema output. `sourcePayload` is the exact
 * relation value handed to that schema. It is optional only for analytical and
 * compile-level callers that begin with an already parsed tree; every
 * record-bearing entry then states `source: undefined` and is not replayable.
 */
export function buildRelationMutationProgram(
  relationInfo: RelationInfo,
  parsedPayload: unknown,
  sourcePayload?: unknown
): RelationMutationProgram | undefined {
  if (!hasRelationMutationInput(parsedPayload)) {
    if (isRecord(parsedPayload) && Object.keys(parsedPayload).length > 0) {
      throw new NestedWriteError(
        `Unsupported nested write operation on relation '${relationInfo.name}': ${Object.keys(parsedPayload).join(", ")}`,
        relationInfo.name
      );
    }
    return undefined;
  }

  const entries: RelationMutationEntry[] = [];
  for (const kind of RELATION_MUTATION_KEYS) {
    const value = parsedPayload[kind];
    if (value === undefined || value === false) continue;

    switch (kind) {
      case "create":
        entries.push({
          kind,
          items: parseRecordMutationItems(
            value,
            sourceMutationValue(sourcePayload, kind),
            relationInfo,
            kind
          ),
        });
        break;
      case "createMany": {
        const envelope = requireRecordEnvelope(relationInfo, kind, value);
        const sourceEnvelope = sourceMutationEnvelope(
          relationInfo,
          kind,
          sourcePayload
        );
        entries.push({
          kind,
          rows: pairRecordMutationItems(
            requireRecordArrayField(relationInfo, kind, envelope, "data"),
            sourceEnvelope
              ? requireRecordArrayField(
                  relationInfo,
                  kind,
                  sourceEnvelope,
                  "data"
                )
              : undefined
          ),
          ...(typeof envelope.skipDuplicates === "boolean"
            ? { skipDuplicates: envelope.skipDuplicates }
            : {}),
        });
        break;
      }
      case "connect":
        entries.push({
          kind,
          targets: parseSingleOrArrayRecord(value, relationInfo, kind),
        });
        break;
      case "connectOrCreate":
        entries.push({
          kind,
          items: parseConnectOrCreateItems(
            relationInfo,
            value,
            sourceMutationValue(sourcePayload, kind)
          ),
        });
        break;
      case "disconnect":
      case "delete":
        entries.push({
          kind,
          target:
            value === true
              ? { kind: "current" }
              : {
                  kind: "selectors",
                  targets: parseSingleOrArrayRecord(value, relationInfo, kind),
                },
        });
        break;
      case "set":
        entries.push({
          kind,
          targets: parseSingleOrArrayRecord(value, relationInfo, kind),
        });
        break;
      case "update":
        entries.push({
          kind,
          items: parseNormalizedUpdates(
            relationInfo,
            value,
            sourceMutationValue(sourcePayload, kind)
          ),
        });
        break;
      case "updateMany":
        entries.push({
          kind,
          items: parseNormalizedUpdateMany(
            relationInfo,
            value,
            sourceMutationValue(sourcePayload, kind)
          ),
        });
        break;
      case "deleteMany":
        entries.push({
          kind,
          filters: parseNormalizedDeleteMany(relationInfo, value),
        });
        break;
      case "upsert":
        entries.push({
          kind,
          items: parseNormalizedUpserts(
            relationInfo,
            value,
            sourceMutationValue(sourcePayload, kind)
          ),
        });
        break;
      default: {
        const exhaustive: never = kind;
        throw new TypeError(`Unknown relation mutation kind: ${exhaustive}`);
      }
    }
  }

  return entries.length > 0 ? { relationInfo, entries } : undefined;
}

/**
 * ONE relation key's parsed mutation — the whole truth about that key, in one value.
 *
 * The three arms are the three things a record's `data` can say about a relation:
 * an ordinary program, a direct polymorphic payload whose public discriminator
 * resolved to one concrete edge (program AND edge — the edge is what lowers the
 * private `(type, id)` pair), and a targetless direct disconnect, which names no
 * target and so has NO program at all: it is one empty private storage assignment.
 *
 * The third arm is why this is a union rather than a program map. A targetless
 * disconnect used to live in a companion map keyed by the same names, and every
 * reader that consulted programs alone silently dropped it (the measured defect
 * quoted in `relation-key-legality.relationWriteKeys`). A reader can still ignore
 * it — but only by naming it, because the compiler makes the arm visible.
 *
 * `name` is the key the payload spelled. For both program-carrying arms it equals
 * `program.relationInfo.name`: a resolved edge keeps the polymorphic relation's own
 * name (`resolvePolymorphicEdge`), so the concrete manyToOne it synthesizes is not a
 * second name.
 */
export type ParsedRelationMutation =
  | {
      readonly kind: "ordinary";
      readonly name: string;
      readonly program: RelationMutationProgram;
    }
  | {
      readonly kind: "polymorphicTarget";
      readonly name: string;
      readonly program: RelationMutationProgram;
      readonly edge: ResolvedPolymorphicEdge;
    }
  | {
      readonly kind: "polymorphicDisconnect";
      readonly name: string;
      readonly storage: PolymorphicToOneStorage;
    }
  | PolymorphicCollectionArm;

/**
 * The FOURTH arm (Package D): one direct polymorphic COLLECTION key, lowered
 * into per-(kind, variant) runs against per-variant member junctions.
 *
 * `name` is the PAYLOAD KEY ("items"). This is the ONE place the invariant in
 * the union's doc above does not hold: for the two program-carrying arms
 * `name === program.relationInfo.name`, while here each entry's program carries
 * its own VARIANT-QUALIFIED carrier name ("items.post"), because one payload key
 * writes several member tables and their step ids must not collide.
 *
 * `relation` and `clearsAll` are carried because two of this arm's facts are
 * RELATION-WIDE and cannot be recovered from the entries:
 *
 *  - the CONFIGURED variant set, which the `set` clear-all barrier must cover in
 *    `storage.members` declaration order INCLUDING variants the payload never
 *    mentions (that is what "clears unmentioned variants" means);
 *  - whether `set` was spelled AT ALL, which `set: []` makes unrecoverable from
 *    the entries: it clears every variant and has no runs to derive from.
 */
export interface PolymorphicCollectionArm {
  readonly kind: "polymorphicCollection";
  readonly name: string;
  readonly relation: PolymorphicToManyRelationInfo;
  readonly entries: readonly PolymorphicCollectionEntry[];
  /** `set` was spelled — `set: []` included, which clears and adds nothing. */
  readonly clearsAll: boolean;
}

/**
 * The arms that carry ONE `RelationMutationProgram`.
 *
 * Spelled POSITIVELY (Package D). It used to subtract the one armless arm, which
 * meant a new arm joined the set by default — and the collection arm is armless
 * in a second way the subtraction could not have caught: it carries a LIST of
 * programs, each against a pre-bound member junction whose topology
 * `bindRelation` cannot recover (`classifyRelation` resolves the VARIANT
 * orientation, the reverse of what a direct entry needs, and refuses the carrier
 * outright). A future fifth arm now has to opt IN.
 */
export type ProgramRelationMutation = Extract<
  ParsedRelationMutation,
  { kind: "ordinary" | "polymorphicTarget" }
>;

/**
 * One record's parsed `data`: its scalars, and ONE ordered collection of every
 * relation key it writes.
 *
 * COLLECTION ORDER is a behavior surface: every ordinary relation in payload key
 * order, THEN every polymorphic relation in payload key order. It is the grouping
 * {@link buildParsedRelationPrograms} and the two root constructors have always
 * produced, and it decides step-id allocation order (and therefore `#1` suffixes),
 * planning order, guard order and OwnWrite append order. Payload key order is NOT
 * this order; pinned by `polymorphic-write-plan.core.test.ts` ("collection order is
 * ordinary-then-polymorphic, NOT payload key order").
 */
export interface ParsedRecordPrograms {
  readonly scalarData: Record<string, unknown>;
  readonly relations: readonly ParsedRelationMutation[];
}

/**
 * Every entry that carries a program, in collection order.
 *
 * A targetless polymorphic disconnect is absent — it has no program, exactly as it
 * was absent from the former program map — so a walk that asks a program's question
 * (position, entries, foreign fields) keeps its current domain. A reader that must
 * see the disconnect walks the collection itself.
 */
export function relationMutationPrograms(
  relations: readonly ParsedRelationMutation[]
): readonly RelationMutationProgram[] {
  const programs: RelationMutationProgram[] = [];
  for (const entry of relations) {
    if (entry.kind === "ordinary" || entry.kind === "polymorphicTarget") {
      programs.push(entry.program);
    }
  }
  return programs;
}

/**
 * Every direct polymorphic COLLECTION key, in collection order.
 *
 * The sibling of {@link relationMutationPrograms} for the arm that arm cannot
 * carry. Every consumer of the programs walk got a NAMED decision when this was
 * introduced (plan §1.2's table) rather than inheriting a silent skip; the two
 * that must VISIT — the junction-target recursion and the collection
 * coordinator's own mounts — walk this.
 */
export function polymorphicCollectionArms(
  relations: readonly ParsedRelationMutation[]
): readonly PolymorphicCollectionArm[] {
  const arms: PolymorphicCollectionArm[] = [];
  for (const entry of relations) {
    if (entry.kind === "polymorphicCollection") arms.push(entry);
  }
  return arms;
}

export function buildPolymorphicMutationProgram(
  ctx: QueryScope,
  relation: PolymorphicRelationInfo,
  parsedPayload: unknown,
  sourcePayload?: unknown
): Extract<
  ParsedRelationMutation,
  {
    kind:
      | "polymorphicTarget"
      | "polymorphicDisconnect"
      | "polymorphicCollection";
  }
> {
  // THE ONE STORAGE DISPATCH on the write path, so the three record producers
  // (`buildParsedRelationPrograms`, `UpdateOperation`, `UpsertOperation`) stay
  // byte-identical to each other and none of them learns which arm it holds.
  if (!isPolymorphicToOneRelationInfo(relation)) {
    const { entries, clearsAll } = resolvePolymorphicCollectionEntries(
      ctx,
      relation,
      parsedPayload,
      sourcePayload
    );
    return {
      kind: "polymorphicCollection",
      name: relation.name,
      relation,
      entries,
      clearsAll,
    };
  }
  const intent = resolvePolymorphicMutationIntent(ctx, relation, parsedPayload);
  if (intent.kind === "disconnect") {
    return {
      kind: "polymorphicDisconnect",
      name: relation.name,
      storage: intent.storage,
    };
  }
  const program = buildRelationMutationProgram(
    intent.edge.relationInfo,
    { [intent.operation]: intent.payload },
    polymorphicSourceProgram(intent.operation, sourcePayload)
  );
  if (!program) {
    throw new NestedWriteError(
      `Polymorphic relation '${relation.name}' produced no target mutation.`,
      relation.name
    );
  }
  return {
    kind: "polymorphicTarget",
    name: relation.name,
    program,
    edge: intent.edge,
  };
}

/**
 * ONE (kind, variant) CONTIGUOUS RUN of a collection payload, lowered into
 * ordinary relation-mutation vocabulary against ONE pre-bound member junction.
 */
export interface PolymorphicCollectionEntry {
  readonly publicType: string;
  readonly member: PolymorphicJunctionMember;
  /** OWNER-oriented, pre-bound. `cardinality === member.inverseCardinality`. */
  readonly junction: JunctionBoundRelation;
  /** Exactly ONE {@link RelationMutationEntry}, built by the ordinary builder. */
  readonly program: RelationMutationProgram;
  /** Attribution, e.g. `items.connect[1..3]`; callers prefix their own path. */
  readonly path: string;
}

/**
 * Untag one verb item: strip the discriminator, hand back the ORDINARY payload
 * the shared builder already knows how to parse.
 *
 * Exhaustive over the eleven §9.1 verbs, so a twelfth is a compile error here
 * rather than an item that silently lowers to `undefined`.
 */
function untagCollectionItem(
  kind: (typeof RELATION_MUTATION_KEYS)[number],
  item: Record<string, unknown>
): unknown {
  switch (kind) {
    case "connect":
    case "set":
    case "disconnect":
    case "delete":
    case "deleteMany":
      return item.where;
    case "create":
      return item.data;
    case "createMany":
      return {
        data: item.data,
        ...(item.skipDuplicates === undefined
          ? {}
          : { skipDuplicates: item.skipDuplicates }),
      };
    case "connectOrCreate":
      return { where: item.where, create: item.create };
    case "update":
      return { where: item.where, data: item.data };
    case "updateMany":
      return {
        data: item.data,
        ...(item.where === undefined ? {} : { where: item.where }),
      };
    case "upsert":
      return {
        where: item.where,
        create: item.create,
        update: item.update,
      };
    default: {
      const exhaustive: never = kind;
      throw new TypeError(`Unknown collection mutation kind: ${exhaustive}`);
    }
  }
}

/** Every tagged item of one verb, as a list, whatever arity the caller spelled. */
function collectionVerbItems(
  relation: PolymorphicToManyRelationInfo,
  kind: string,
  value: unknown
): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (isRecord(item) && typeof item.type === "string") return item;
    throw new NestedWriteError(
      `Malformed nested '${kind}' operation on polymorphic collection '${relation.name}': every item must carry its 'type' discriminator.`,
      relation.name,
      { meta: { operation: kind } }
    );
  });
}

/**
 * Lower one direct polymorphic COLLECTION payload into per-(kind, variant) runs.
 *
 * It repeats the trick the to-one arm already uses — unwrap the tagged envelope
 * into ordinary verb vocabulary, then feed {@link buildRelationMutationProgram} —
 * with {@link bindPolymorphicCollectionMember} supplying topology in place of
 * `resolvePolymorphicEdge`. What is new is the GRANULARITY.
 *
 * ENTRY GRANULARITY = per (kind, variant) MAXIMAL CONTIGUOUS RUN. A per-item
 * entry could not carry a BULK program (`createMany`, `deleteMany`,
 * `updateMany`), which §9.3 requires an entry to be able to; a per-variant
 * regrouping would reorder declared positions, which the junction estate's own
 * `contiguousJunctionCreateManyRuns` is built never to do. So
 * `connect: [post, video, post]` is THREE runs, never two.
 *
 * ORDER is {@link RELATION_MUTATION_KEYS} outer — the own-write linearization,
 * unchanged — and declared array position inner.
 *
 * `createMany` is the one verb whose run is always ONE GROUP: each group is
 * already a bulk unit and carries its own `skipDuplicates`, so merging two
 * adjacent same-variant groups would either lose a flag or invent a third
 * meaning for it.
 */
function resolvePolymorphicCollectionEntries(
  ctx: QueryScope,
  relation: PolymorphicToManyRelationInfo,
  parsedPayload: unknown,
  sourcePayload: unknown
): {
  readonly entries: readonly PolymorphicCollectionEntry[];
  readonly clearsAll: boolean;
} {
  if (!isRecord(parsedPayload)) {
    throw new NestedWriteError(
      `Polymorphic collection '${relation.name}' produced an invalid mutation payload.`,
      relation.name
    );
  }
  const entries: PolymorphicCollectionEntry[] = [];
  let clearsAll = false;
  for (const kind of RELATION_MUTATION_KEYS) {
    const value = parsedPayload[kind];
    if (value === undefined) continue;
    if (kind === "set") clearsAll = true;
    const items = collectionVerbItems(relation, kind, value);
    const sources = collectionVerbSources(
      relation,
      kind,
      sourcePayload,
      items.length
    );
    let start = 0;
    while (start < items.length) {
      const publicType = String(items[start]!.type);
      let end = start + 1;
      // `createMany` groups never merge (see the doc above); every other verb's
      // run extends while the discriminator holds.
      if (kind !== "createMany") {
        while (end < items.length && items[end]!.type === publicType) end += 1;
      }
      entries.push(
        buildCollectionEntry({
          ctx,
          relation,
          kind,
          publicType,
          items: items.slice(start, end),
          sources: sources?.slice(start, end),
          start,
          end,
        })
      );
      start = end;
    }
  }
  return { entries, clearsAll };
}

/** The caller's own record for one verb, aligned index for index with the parse. */
function collectionVerbSources(
  relation: PolymorphicToManyRelationInfo,
  kind: string,
  sourcePayload: unknown,
  parsedCount: number
): Record<string, unknown>[] | undefined {
  const value = isRecord(sourcePayload) ? sourcePayload[kind] : undefined;
  if (value === undefined) return undefined;
  const sources = collectionVerbItems(relation, kind, value);
  if (sources.length !== parsedCount) {
    throw new TypeError(
      `Polymorphic collection '${relation.name}' mutation source has ${sources.length} '${kind}' item(s) for ${parsedCount} parsed item(s).`
    );
  }
  return sources;
}

function buildCollectionEntry(input: {
  ctx: QueryScope;
  relation: PolymorphicToManyRelationInfo;
  kind: (typeof RELATION_MUTATION_KEYS)[number];
  publicType: string;
  items: readonly Record<string, unknown>[];
  sources: readonly Record<string, unknown>[] | undefined;
  start: number;
  end: number;
}): PolymorphicCollectionEntry {
  const { ctx, relation, kind, publicType } = input;
  const member = relation.storage.members.get(publicType);
  if (!member) {
    throw new NestedWriteError(
      `Unknown polymorphic target '${publicType}' for collection '${relation.name}'.`,
      relation.name,
      { meta: { operation: kind } }
    );
  }
  const junction = bindPolymorphicCollectionMember(ctx, relation, member);
  const untagged = input.items.map((item) => untagCollectionItem(kind, item));
  // `createMany` is a BARE envelope in the ordinary vocabulary, not a list —
  // which is exactly why its run is one group.
  const parsedVerb = kind === "createMany" ? untagged[0] : untagged;
  const sourceVerb = input.sources
    ? kind === "createMany"
      ? untagCollectionItem(kind, input.sources[0]!)
      : input.sources.map((item) => untagCollectionItem(kind, item))
    : undefined;
  const program = buildRelationMutationProgram(
    junction.relationInfo,
    { [kind]: parsedVerb },
    sourceVerb === undefined ? undefined : { [kind]: sourceVerb }
  );
  if (!program) {
    throw new NestedWriteError(
      `Polymorphic collection '${relation.name}' produced no '${kind}' mutation for variant '${publicType}'.`,
      relation.name,
      { meta: { operation: kind } }
    );
  }
  return {
    publicType,
    member,
    junction,
    program,
    path: `${relation.name}.${kind}[${input.start}..${input.end - 1}]`,
  };
}

/**
 * Partition one parsed record while retaining its source recursively. Production
 * operation shells pass `sourceData` whenever they still own the caller record.
 * Source-less callers may analyze existing schema output, but must not use it as a
 * validation replay input.
 */
export function buildParsedRelationPrograms(
  ctx: QueryScope,
  parsedData: Record<string, unknown>,
  sourceData?: Record<string, unknown>
): ParsedRecordPrograms {
  const { scalarData, relationPayloads, polymorphicPayloads } =
    partitionModelData(ctx, parsedData);
  // TWO PASSES, and the grouping is the contract (see {@link ParsedRecordPrograms}):
  // every ordinary relation before every polymorphic one. The root update/upsert
  // constructors spell the same two passes because their per-relation transforms
  // must keep that validation order (ATOM §19).
  const relations: ParsedRelationMutation[] = [];
  for (const [relationName, { relationInfo, payload }] of Object.entries(
    relationPayloads
  )) {
    const program = buildRelationMutationProgram(
      relationInfo,
      payload,
      sourceData?.[relationName]
    );
    if (program) {
      relations.push({ kind: "ordinary", name: relationName, program });
    }
  }
  for (const { relation, payload } of Object.values(polymorphicPayloads)) {
    relations.push(
      buildPolymorphicMutationProgram(
        ctx,
        relation,
        payload,
        sourceData?.[relation.name]
      )
    );
  }
  return { scalarData, relations };
}

function hasRelationMutationInput(
  value: unknown
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return RELATION_MUTATION_KEYS.some((key) => {
    if (key !== "set") return value[key] !== undefined;
    return Array.isArray(value.set) || isRecord(value.set);
  });
}

function parseConnectOrCreateItems(
  relationInfo: RelationInfo,
  value: unknown,
  sourceValue: unknown
): ConnectOrCreateInput[] {
  const inputs = parseSingleOrArrayRecord(
    value,
    relationInfo,
    "connectOrCreate"
  );
  const sources = parseSourceRecords(
    sourceValue,
    relationInfo,
    "connectOrCreate"
  );
  return inputs.map((input, index) => ({
    where: requireRecordField(relationInfo, "connectOrCreate", input, "where"),
    create: recordMutationData(
      requireRecordField(relationInfo, "connectOrCreate", input, "create"),
      sourceRecordField(
        relationInfo,
        "connectOrCreate",
        sources,
        index,
        "create"
      )
    ),
  }));
}

function parseNormalizedUpdates(
  relationInfo: RelationInfo,
  value: unknown,
  sourceValue: unknown
): NormalizedRelationUpdate[] {
  if (relationInfo.cardinality === "one") {
    // `parsedPayload` is deliberately an unknown carrier, but the to-one update
    // schema has already normalized this branch to its canonical envelope.
    const target = splitToOneUpdateTarget(value as ToOneUpdateEnvelope);
    return [
      {
        target: {
          kind: "correlated",
          ...(target.filter ? { filter: target.filter } : {}),
        },
        data: recordMutationData(
          target.data,
          toOneUpdateSourceData(sourceValue)
        ),
      },
    ];
  }

  const inputs = parseSingleOrArrayRecord(value, relationInfo, "update");
  const sources = parseSourceRecords(sourceValue, relationInfo, "update");
  return inputs.map((input, index) => ({
    target: {
      kind: "unique",
      where: requireRecordField(relationInfo, "update", input, "where"),
    },
    data: recordMutationData(
      requireRecordField(relationInfo, "update", input, "data"),
      sourceRecordField(relationInfo, "update", sources, index, "data")
    ),
  }));
}

function parseNormalizedUpdateMany(
  relationInfo: RelationInfo,
  value: unknown,
  sourceValue: unknown
): NestedUpdateManyInput[] {
  rejectToOneOperation(relationInfo, "updateMany");
  const inputs = parseSingleOrArrayRecord(value, relationInfo, "updateMany");
  const sources = parseSourceRecords(sourceValue, relationInfo, "updateMany");
  return inputs.map(
    (input, index): NestedUpdateManyInput => ({
      data: recordMutationData(
        requireRecordField(relationInfo, "updateMany", input, "data"),
        sourceRecordField(relationInfo, "updateMany", sources, index, "data")
      ),
      ...(input.where === undefined
        ? {}
        : {
            where: requireRecordField(
              relationInfo,
              "updateMany",
              input,
              "where"
            ),
          }),
    })
  );
}

function parseNormalizedDeleteMany(
  relationInfo: RelationInfo,
  value: unknown
): Record<string, unknown>[] {
  rejectToOneOperation(relationInfo, "deleteMany");
  return parseSingleOrArrayRecord(value, relationInfo, "deleteMany");
}

function parseNormalizedUpserts(
  relationInfo: RelationInfo,
  value: unknown,
  sourceValue: unknown
): NormalizedRelationUpsert[] {
  if (relationInfo.cardinality === "one" && Array.isArray(value)) {
    throw new NestedWriteError(
      `Malformed nested 'upsert' operation on relation '${relationInfo.name}': expected a single object envelope for to-one relations.`,
      relationInfo.name,
      { meta: { operation: "upsert" } }
    );
  }

  const inputs = parseSingleOrArrayRecord(value, relationInfo, "upsert");
  const sources = parseSourceRecords(sourceValue, relationInfo, "upsert");
  return inputs.map((input, index) => ({
    target:
      relationInfo.cardinality === "one"
        ? { kind: "correlated" }
        : {
            kind: "unique",
            where: requireRecordField(relationInfo, "upsert", input, "where"),
          },
    create: recordMutationData(
      requireRecordField(relationInfo, "upsert", input, "create"),
      sourceRecordField(relationInfo, "upsert", sources, index, "create")
    ),
    update: recordMutationData(
      requireRecordField(relationInfo, "upsert", input, "update"),
      sourceRecordField(relationInfo, "upsert", sources, index, "update")
    ),
  }));
}

function parseRecordMutationItems(
  parsedValue: unknown,
  sourceValue: unknown,
  relationInfo: RelationInfo,
  operation: string
): RecordMutationData[] {
  return pairRecordMutationItems(
    parseSingleOrArrayRecord(parsedValue, relationInfo, operation),
    parseSourceRecords(sourceValue, relationInfo, operation)
  );
}

function pairRecordMutationItems(
  parsed: readonly Record<string, unknown>[],
  source: readonly Record<string, unknown>[] | undefined
): RecordMutationData[] {
  if (source && source.length !== parsed.length) {
    throw new TypeError(
      `Relation mutation source has ${source.length} record(s) for ${parsed.length} parsed record(s).`
    );
  }
  return parsed.map((value, index) =>
    recordMutationData(value, source?.[index])
  );
}

function recordMutationData(
  parsed: Record<string, unknown>,
  source: Record<string, unknown> | undefined
): RecordMutationData {
  return { parsed, source };
}

function parseSourceRecords(
  value: unknown,
  relationInfo: RelationInfo,
  operation: string
): Record<string, unknown>[] | undefined {
  return value === undefined
    ? undefined
    : parseSingleOrArrayRecord(value, relationInfo, operation);
}

function sourceRecordField(
  relationInfo: RelationInfo,
  operation: string,
  sources: readonly Record<string, unknown>[] | undefined,
  index: number,
  field: string
): Record<string, unknown> | undefined {
  if (!sources) return undefined;
  const source = sources[index];
  if (!source) {
    throw new TypeError(
      `Relation mutation '${operation}' on '${relationInfo.name}' lost source item ${index}.`
    );
  }
  return requireRecordField(relationInfo, operation, source, field);
}

function sourceMutationValue(
  sourcePayload: unknown,
  operation: string
): unknown {
  return isRecord(sourcePayload) ? sourcePayload[operation] : undefined;
}

function sourceMutationEnvelope(
  relationInfo: RelationInfo,
  operation: string,
  sourcePayload: unknown
): Record<string, unknown> | undefined {
  const value = sourceMutationValue(sourcePayload, operation);
  return value === undefined
    ? undefined
    : requireRecordEnvelope(relationInfo, operation, value);
}

function polymorphicSourceProgram(
  operation:
    | "connect"
    | "create"
    | "connectOrCreate"
    | "update"
    | "upsert"
    | "delete",
  sourcePayload: unknown
): Record<string, unknown> | undefined {
  if (!isRecord(sourcePayload)) return undefined;
  const envelope = sourcePayload[operation];
  if (!isRecord(envelope)) return undefined;
  switch (operation) {
    case "connect":
      return { connect: envelope.where };
    case "create":
      return { create: envelope.data };
    case "connectOrCreate":
      return {
        connectOrCreate: {
          where: envelope.where,
          create: envelope.create,
        },
      };
    case "update":
      return {
        update: {
          data: envelope.data,
          ...(envelope.where === undefined ? {} : { where: envelope.where }),
        },
      };
    case "upsert":
      return {
        upsert: { create: envelope.create, update: envelope.update },
      };
    case "delete":
      return { delete: true };
    default: {
      const exhaustive: never = operation;
      throw new TypeError(`Unknown polymorphic mutation: ${exhaustive}`);
    }
  }
}

function parseSingleOrArrayRecord(
  value: unknown,
  relationInfo: RelationInfo,
  operation: string
): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : [value]).map((entry) =>
    requireRecordEnvelope(relationInfo, operation, entry)
  );
}

function requireRecordEnvelope(
  relationInfo: RelationInfo,
  operation: string,
  value: unknown
): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new NestedWriteError(
    `Malformed nested '${operation}' operation on relation '${relationInfo.name}': expected an object envelope.`,
    relationInfo.name,
    { meta: { operation } }
  );
}

function requireRecordField(
  relationInfo: RelationInfo,
  operation: string,
  input: Record<string, unknown>,
  field: string
): Record<string, unknown> {
  const value = input[field];
  if (isRecord(value)) return value;
  throw new NestedWriteError(
    `Malformed nested '${operation}' operation on relation '${relationInfo.name}': expected '${field}' to be an object.`,
    relationInfo.name,
    { meta: { operation, field } }
  );
}

function requireRecordArrayField(
  relationInfo: RelationInfo,
  operation: string,
  input: Record<string, unknown>,
  field: string
): Record<string, unknown>[] {
  const value = input[field];
  if (Array.isArray(value) && value.every(isRecord)) return value;
  throw new NestedWriteError(
    `Malformed nested '${operation}' operation on relation '${relationInfo.name}': expected '${field}' to be an array of objects.`,
    relationInfo.name,
    { meta: { operation, field } }
  );
}

function rejectToOneOperation(
  relationInfo: RelationInfo,
  operation: string
): void {
  if (relationInfo.cardinality !== "one") return;
  throw new NestedWriteError(
    `Nested operation '${operation}' is not supported for to-one relation '${relationInfo.name}'.`,
    relationInfo.name,
    { meta: { operation } }
  );
}
