import type { AnyModel } from "@schema/model";
import type { Scalar } from "@schema/scalars/base";
import type { Getter } from "./types";

export type PolymorphicTargetGetters = Readonly<Record<string, Getter>>;

export interface PolymorphicRelationState<
  Targets extends PolymorphicTargetGetters = PolymorphicTargetGetters,
  Values extends Readonly<Record<string, string>> = Readonly<
    Record<string, string>
  >,
> {
  readonly type: "polymorphic";
  readonly targets: Targets;
  readonly values: Values;
  readonly name?: string;
  readonly optional?: true;
}

export interface PolymorphicStorageMember {
  readonly storedType: string;
  readonly targetModel: AnyModel;
  readonly referencedField: string;
}

export interface PolymorphicStorageColumn {
  readonly name: string;
  readonly scalar: Scalar;
  readonly nullable: boolean;
}

export type PolymorphicInverseCardinality = "one" | "many";

export interface PolymorphicStorage {
  readonly relationName: string;
  readonly ownerModel: AnyModel;
  readonly indexName: string;
  readonly typeColumn: PolymorphicStorageColumn;
  readonly idColumn: PolymorphicStorageColumn;
  readonly inverseCardinality: PolymorphicInverseCardinality;
  readonly members: ReadonlyMap<string, PolymorphicStorageMember>;
}

export interface PolymorphicInverseBinding<
  RelationKey extends string = string,
  PublicType extends string = string,
  StoredType extends string = string,
> {
  readonly relationKey: RelationKey;
  readonly publicType: PublicType;
  readonly storedType: StoredType;
}

interface ModelWithPolymorphicRelations {
  readonly "~": {
    readonly state: {
      readonly polymorphicRelations: Readonly<
        Record<string, AnyPolymorphicRelation>
      >;
    };
  };
}

type RelationContainsSource<Relation, SourceModel> =
  Relation extends PolymorphicRelation<infer State>
    ? {
        [PublicType in keyof State["targets"]]: State["targets"][PublicType] extends () => SourceModel
          ? PublicType
          : never;
      }[keyof State["targets"]] extends never
      ? false
      : true
    : false;

type PolymorphicRelationKeys<TargetModel> =
  TargetModel extends ModelWithPolymorphicRelations
    ? Extract<keyof TargetModel["~"]["state"]["polymorphicRelations"], string>
    : never;

type NamedPolymorphicRelationKeys<TargetModel, Name> =
  TargetModel extends ModelWithPolymorphicRelations
    ? {
        [RelationKey in keyof TargetModel["~"]["state"]["polymorphicRelations"]]: TargetModel["~"]["state"]["polymorphicRelations"][RelationKey] extends PolymorphicRelation<
          infer State
        >
          ? State["name"] extends Name
            ? Extract<RelationKey, string>
            : never
          : never;
      }[keyof TargetModel["~"]["state"]["polymorphicRelations"]]
    : never;

type UnionToIntersection<Union> = (
  Union extends unknown
    ? (value: Union) => void
    : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

type IsSingleMember<Union> = [Union] extends [never]
  ? false
  : [Union] extends [UnionToIntersection<Union>]
    ? true
    : false;

type SelectedRelationKey<TargetModel, Name> =
  IsSingleMember<PolymorphicRelationKeys<TargetModel>> extends true
    ? PolymorphicRelationKeys<TargetModel>
    : Name extends string
      ? IsSingleMember<
          NamedPolymorphicRelationKeys<TargetModel, Name>
        > extends true
        ? NamedPolymorphicRelationKeys<TargetModel, Name>
        : never
      : never;

type RelationKeyBinding<TargetModel, SourceModel, RelationKey> =
  TargetModel extends ModelWithPolymorphicRelations
    ? RelationKey extends keyof TargetModel["~"]["state"]["polymorphicRelations"]
      ? RelationContainsSource<
          TargetModel["~"]["state"]["polymorphicRelations"][RelationKey],
          SourceModel
        > extends true
        ? { readonly relationKey: Extract<RelationKey, string> }
        : never
      : never
    : never;

export type GetPolymorphicInverseBinding<TargetModel, SourceModel, Name> =
  RelationKeyBinding<
    TargetModel,
    SourceModel,
    SelectedRelationKey<TargetModel, Name>
  >;

export interface RuntimePolymorphicInverseCandidate
  extends PolymorphicInverseBinding {
  readonly pairingName: string | undefined;
}

export interface ResolvedPolymorphicTargetEntry {
  readonly publicType: string;
  readonly targetGetter: unknown;
  readonly targetModel: unknown;
  readonly storedType: unknown;
}

export function getPolymorphicInverseCandidates(
  targetModel: AnyModel,
  sourceModel: AnyModel
): RuntimePolymorphicInverseCandidate[] {
  const candidates: RuntimePolymorphicInverseCandidate[] = [];
  const relations: Readonly<Record<string, AnyPolymorphicRelation>> =
    targetModel["~"].state.polymorphicRelations;
  for (const [relationKey, relation] of Object.entries(relations)) {
    for (const {
      publicType,
      targetGetter,
      targetModel,
      storedType,
    } of relation["~"].targetEntries()) {
      if (typeof targetGetter !== "function") continue;
      if (targetModel !== sourceModel) continue;
      if (typeof storedType !== "string") continue;
      candidates.push({
        relationKey,
        publicType,
        storedType,
        pairingName: relation["~"].state.name,
      });
    }
  }
  return candidates;
}

type ValuesFor<Targets extends PolymorphicTargetGetters> = {
  readonly [Key in Extract<keyof Targets, string>]: string;
};

type DefaultValuesFor<Targets extends PolymorphicTargetGetters> = {
  readonly [Key in Extract<keyof Targets, string>]: Key;
};

type NoExtraKeys<Given, Allowed> = Record<
  Exclude<keyof Given, keyof Allowed>,
  never
>;

export class PolymorphicRelation<State extends PolymorphicRelationState> {
  private readonly state: State;
  private resolvedTargetEntries:
    | readonly ResolvedPolymorphicTargetEntry[]
    | undefined;

  constructor(state: State) {
    this.state = Object.freeze({
      ...state,
      targets: snapshotRecord(state.targets),
      values: snapshotRecord(state.values),
    });
  }

  name<const Name extends string>(name: Name) {
    return new PolymorphicRelation<State & { readonly name: Name }>({
      ...this.state,
      name,
    });
  }

  optional() {
    return new PolymorphicRelation<State & { readonly optional: true }>({
      ...this.state,
      optional: true,
    });
  }

  private internal:
    | {
        readonly state: State;
        readonly targetEntries: () => readonly ResolvedPolymorphicTargetEntry[];
      }
    | undefined;

  get "~"() {
    return (this.internal ??= {
      state: this.state,
      targetEntries: () =>
        (this.resolvedTargetEntries ??= resolveTargetEntries(this.state)),
    });
  }
}

export type AnyPolymorphicRelation =
  PolymorphicRelation<PolymorphicRelationState>;

export function polymorphic<const Targets extends PolymorphicTargetGetters>(
  targets: Targets,
  options?: undefined
): PolymorphicRelation<{
  readonly type: "polymorphic";
  readonly targets: Targets;
  readonly values: DefaultValuesFor<Targets>;
}>;

export function polymorphic<
  const Targets extends PolymorphicTargetGetters,
  const Values extends ValuesFor<Targets>,
>(
  targets: Targets,
  options: {
    readonly values: Values & NoExtraKeys<Values, ValuesFor<Targets>>;
  }
): PolymorphicRelation<{
  readonly type: "polymorphic";
  readonly targets: Targets;
  readonly values: Values;
}>;

export function polymorphic(
  targets: PolymorphicTargetGetters,
  options?: {
    readonly values: Readonly<Record<string, string>>;
  }
): AnyPolymorphicRelation {
  return new PolymorphicRelation({
    type: "polymorphic",
    targets,
    values: options?.values ?? defaultStoredValues(targets),
  });
}

function defaultStoredValues(
  targets: PolymorphicTargetGetters
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Reflect.ownKeys(targets)
      .filter((key): key is string => typeof key === "string")
      .map((key) => [key, key])
  );
}

function snapshotRecord<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null) return value;
  const copy = Object.create(Object.getPrototypeOf(value));
  Object.defineProperties(copy, Object.getOwnPropertyDescriptors(value));
  return Object.freeze(copy);
}

function resolveTargetEntries(
  state: PolymorphicRelationState
): readonly ResolvedPolymorphicTargetEntry[] {
  if (typeof state.targets !== "object" || state.targets === null) return [];
  const values =
    typeof state.values === "object" && state.values !== null
      ? state.values
      : undefined;
  const entries: ResolvedPolymorphicTargetEntry[] = [];
  for (const publicType of Reflect.ownKeys(state.targets)) {
    if (typeof publicType !== "string") continue;
    const targetGetter = Reflect.get(state.targets, publicType);
    entries.push({
      publicType,
      targetGetter,
      targetModel:
        typeof targetGetter === "function" ? targetGetter() : undefined,
      storedType: values ? Reflect.get(values, publicType) : undefined,
    });
  }
  return Object.freeze(entries);
}

export function isPolymorphicRelation(
  value: unknown
): value is AnyPolymorphicRelation {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return false;
  }
  const internal = Reflect.get(value, "~");
  if (typeof internal !== "object" || internal === null) return false;
  const state = Reflect.get(internal, "state");
  return (
    typeof state === "object" &&
    state !== null &&
    Reflect.get(state, "type") === "polymorphic"
  );
}
