import type { DatabaseAdapter } from "@adapters/database-adapter";
import type { AnyDriver } from "@drivers";
import { QueryEngineError } from "@errors";
import { hydrateSchemaNames, type Schema } from "@schema/hydration";
import { getModelKeyCatalog, type AnyModel } from "@schema/model";
import {
  clearableMembership,
  type ClearableMembership,
} from "@schema/relation/clearability";
import type { ResolvedSlot } from "@schema/validation/relation-resolution";
import { validateClientSchemaOrThrow } from "@schema/validation";
import { createResolvedSchemaRegistry } from "@validation/builder";
import { isRecord } from "@validation/value-guards";
import {
  parseValidated,
  upsertEnvelopeSchema,
} from "../../write-engine/parse-boundary";
import type { Leaf, PreparedProjection } from "./query";
import {
  buildMembershipView,
  buildPhysicalFieldView,
  buildStoredFieldsView,
  freezeMembershipView,
  type Membership,
  type PhysicalField,
} from "./storage";

export type Input = Record<string, unknown>;
export type ReadOperation =
  | "findMany"
  | "findUnique"
  | "findFirst"
  | "count"
  | "exist"
  | "aggregate"
  | "groupBy";
export type Operation =
  | "create"
  | "createMany"
  | "update"
  | "upsert"
  | "updateMany"
  | "delete"
  | "deleteMany"
  | ReadOperation;

const READ_OPERATIONS: ReadonlySet<string> = new Set<ReadOperation>([
  "findMany",
  "findUnique",
  "findFirst",
  "count",
  "exist",
  "aggregate",
  "groupBy",
]);

/** One classification of an admitted operation; a read allocates no write work. */
export function isReadOperation(
  operation: Operation
): operation is ReadOperation {
  return READ_OPERATIONS.has(operation);
}
/**
 * The client's already-resolved schema views. A client that composed them once
 * hands them over by identity; the candidate never re-hydrates or re-validates
 * a schema a caller already resolved (g4/unit03/note.md B-3).
 */
export interface ResolvedSchemaViews {
  readonly index: ReturnType<typeof validateClientSchemaOrThrow>;
  /**
   * Declared as the one member {@link EngineSchema} reads. A client hands over
   * its full resolved registry and an engine hands over the
   * `getModelSchemas`/`validate` pair its `ModelRegistry` carries; both satisfy
   * this, nothing is widened, and no consumer here reads `proxy`.
   */
  readonly registry: Pick<
    ReturnType<typeof createResolvedSchemaRegistry>,
    "getModelSchemas"
  >;
}
export interface EngineConfig {
  schema: Schema;
  driver: AnyDriver;
  resolved?: ResolvedSchemaViews;
}
export interface Arguments extends Input {
  data: Input;
  create?: Input;
  update?: Input;
  where?: Input;
  targetWhere?: Input;
  setWhere?: Input;
  select?: Input;
  include?: Input;
  orderBy?: Input | Input[];
  take?: number;
  skip?: number;
  cursor?: Input;
  distinct?: string[];
  by?: string[];
  having?: Input;
  limit?: number;
  omit?: Input;
  skipDuplicates?: boolean;
  _count?: true | Input;
  _avg?: Input;
  _sum?: Input;
  _min?: Input;
  _max?: Input;
}

/**
 * The two update operators whose result a provider ROUNDS — the ones an exact
 * decimal row key cannot carry portably, and the ones phase 2 made reachable.
 */
const ROUNDING_KEY_UPDATES: readonly string[] = ["multiply", "divide"];

/**
 * Every operation a key update may name, in the shipped engine's own order
 * (`operations/mutation-identity.ts` `assertPortablePrimaryKeyUpdateInput`),
 * because the refusal sentence lists them in it.
 */
const KEY_UPDATE_OPERATIONS = [
  "set",
  "increment",
  "decrement",
  "multiply",
  "divide",
] as const;

/** These casts attach the existing admission schema's dynamic model correlation. */
export function record(value: unknown): Input {
  return value as Input;
}
export function entries(value: unknown): Input[] {
  return Array.isArray(value) ? value : [record(value)];
}

/**
 * What this engine resolves once per (adapter, model) and never again.
 *
 * Both members are a pure function of the schema and the dialect, which is why
 * they may be shared at all (rule 1): a scalar leaf is the field's declared
 * type, nullability and the adapter's own `dateTime` representation; the
 * DEFAULT projection is `scalarFieldNames` minus the model's own `omit`, and an
 * operation-level `omit` never reaches the projection owner — admission
 * desugars it into `select`, which takes the per-operation path. Nothing
 * admitted and nothing a provider answered is stored (rule 5).
 *
 * The two member types are the query owner's, imported for their names only:
 * `import type` adds no runtime edge, so `shared/query.ts` keeps its one
 * runtime import of this file and this file keeps none of it.
 */
export type QueryViews = {
  readonly leaves: WeakMap<AnyModel, Map<string, Leaf>>;
  readonly defaultProjections: WeakMap<AnyModel, PreparedProjection>;
};

const createQueryViews = (): QueryViews => ({
  leaves: new WeakMap(),
  defaultProjections: new WeakMap(),
});

export class EngineSchema {
  readonly index;
  readonly registry;
  private readonly membershipViews = new WeakMap<
    AnyModel,
    Map<string, Map<string | undefined, Membership>>
  >();
  private readonly physicalFields = new WeakMap<
    AnyModel,
    Map<string, PhysicalField>
  >();
  private readonly storedFieldLists = new WeakMap<
    AnyModel,
    readonly string[]
  >();
  private readonly clearabilityViews = new WeakMap<
    ResolvedSlot,
    ClearableMembership
  >();
  constructor(readonly schema: Schema, resolved?: ResolvedSchemaViews) {
    if (resolved) {
      this.index = resolved.index;
      this.registry = resolved.registry;
      return;
    }
    hydrateSchemaNames(schema);
    this.index = validateClientSchemaOrThrow(schema);
    this.registry = createResolvedSchemaRegistry(schema, this.index);
  }
  admit(model: AnyModel, operation: Operation, raw: unknown): Arguments {
    const admitted =
      operation === "upsert"
        ? this.upsert(model, raw)
        : this.admitArguments(model, operation, raw);
    // WHERE the shipped engine states the key's portability contract, mirrored:
    // `update`/`updateMany` assert at admission (`assertPortablePrimaryKeyUpdateInput`
    // from their own validator); an `upsert` asserts on its FOUND arm and only
    // when the update payload names relations, which `Commands` attaches there.
    if (operation === "update" || operation === "updateMany") {
      const refusal = this.keyPortabilityRefusal(model, admitted.data);
      if (refusal) throw refusal;
    }
    return admitted;
  }
  private admitArguments(
    model: AnyModel,
    operation: Operation,
    raw: unknown
  ): Arguments {
    const schema = this.registry.getModelSchemas(model).args[operation];
    const input =
      operation === "update" && isRecord(raw) && isRecord(raw.data)
        ? {
            ...raw,
            data: Object.fromEntries(
              Object.entries(raw.data).sort(([left], [right]) => {
                const isVariant = (name: string) =>
                  model["~"].state.relations[name]?.["~"].state.target.kind ===
                  "variants";
                return Number(isVariant(left)) - Number(isVariant(right));
              })
            ),
          }
        : raw;
    return parseValidated(schema, input, operation, "") as Arguments;
  }
  /**
   * Does this payload name a relation of the model? One spelling, asked by the
   * upsert's create arm below and by the found-arm key-portability gate in
   * `commands.ts`.
   */
  namesRelation(model: AnyModel, data: Input): boolean {
    return model["~"].relationNames.some((name) => data[name] !== undefined);
  }
  /**
   * The row key's PORTABILITY contract for the two operators phase 2 made
   * reachable, as one refusal the caller raises where the shipped engine raises
   * it — never a second walker, never a second sentence.
   *
   * A key's post-update value has to be NAMEABLE: a non-returning readback and
   * every dependent's key transition address the row by it. `multiply` and
   * `divide` carry a provider-chosen rounding on a `number` or `decimal` key
   * that no engine can name portably, and a `divide` by zero has no value at
   * all, so the shipped engine refuses both from its own validator
   * (`assertPortablePrimaryKeyUpdateInput`). Until phase 2 implemented the two
   * operators the candidate answered "not implemented" for every one of these
   * payloads; implementing them is what brought the shapes within reach, so the
   * refusals arrive with them, in the shipped engine's own sentences.
   *
   * WHAT it says is the shipped assertion with exactly ONE adopted divergence,
   * R-D2 (a) (Arnaud, 2026-09-15): an EXACT-DOMAIN arithmetic update of a
   * `decimal` key — `increment` / `decrement` — is supported, because it is
   * exact in coefficient space, and the registered G3 witness
   * `tests/raptor3/g3/review-execution-boundaries.test.ts` pins that capability.
   * `multiply` / `divide` on the same key still carry the provider's rounding,
   * so they stay refused. Everything else is parity: R-D2 (b), a `number` key
   * under any arithmetic, and R-D2 (c), `set` beside another operation, answer
   * the shipped sentences (they used to be divergences, pinned on both engines;
   * the decision reverted them). The shipped non-finite-operand arm is
   * deliberately NOT mirrored — after the rules below it is reachable only for
   * an `int`/`bigint` key, whose validation refuses a non-finite operand, so it
   * would be a guard whose unique coverage cannot be named.
   *
   * WHERE it is raised belongs to each caller, because the shipped engine does
   * not raise it in one place: `admit` raises it for `update`/`updateMany`, and
   * the upsert's found arm carries it (`commands.ts`) exactly when the update
   * payload names relations — the shipped gate, note §R3.1. A wider placement
   * refuses requests the shipped engine performs, including an upsert that
   * CREATES a row the arithmetic never touches.
   */
  keyPortabilityRefusal(model: AnyModel, data: unknown): Error | undefined {
    if (!isRecord(data)) return undefined;
    for (const keyField of this.keys(model)) {
      const update = data[keyField];
      if (!isRecord(update)) continue;
      const named = KEY_UPDATE_OPERATIONS.filter(
        (operation) => update[operation] !== undefined
      );
      if (named.length !== 1)
        return new QueryEngineError(
          `Primary key field '${keyField}' accepts exactly one update operation; received ${named.join(", ") || "none"}.`
        );
      const operation = named[0]!;
      if (operation === "set") continue;
      const scalarType = model["~"].state.scalars[keyField]?.["~"].state.type;
      if (
        scalarType === "number" ||
        (scalarType === "decimal" && ROUNDING_KEY_UPDATES.includes(operation))
      )
        return new QueryEngineError(
          `Arithmetic updates are not portable for ${scalarType} primary key field '${keyField}'. Use an explicit set value.`
        );
      if (update.divide === 0 || update.divide === 0n)
        return new QueryEngineError(
          `Cannot divide primary key field '${keyField}' by zero.`
        );
    }
    return undefined;
  }
  /**
   * The key TRANSITION's own refusal — the shipped engine's THIRD key owner,
   * and a different question from {@link keyPortabilityRefusal}.
   *
   * A child-held relation written beside a key update forces the parent's
   * POST-transition key value to be named at ANALYSIS: the child rows this
   * payload writes reference it, and the compiler builds their FK before any
   * row is located. The shipped engine names it in
   * `RecordUpdateCompilerState.interpretReferencedKeyTransition`
   * (`write-engine/RecordUpdateCompiler.ts:3319` ->
   * `operations/mutation-identity.ts:357`), reached from the `UpsertOperation`
   * CONSTRUCTOR (`:480`) — so for an upsert it runs before either arm is
   * selected, and a payload whose post-value cannot be computed is refused
   * with the transition's own sentence rather than the validator's, before
   * either arm writes anything. Two payloads cannot be computed, and they are
   * the two `getSafeUpdatedScalarValue` refuses (`mutation-identity.ts:298`,
   * `:336`): a key naming anything other than exactly one operation, which is
   * R-D2 (c)'s `set`-beside-an-operator shape and answers `:187`'s sentence,
   * and a `divide` by zero, which has no value at all.
   *
   * Its three structural conditions are the shipped ones, measured
   * (`upsert-key-portability.test.ts`, the third describe):
   *
   * - the relation is CHILD-held and references the key being rewritten. That
   *   fact is NOT re-derived here: the command tree already records it while it
   *   expands the payload (`RelationBody.relation` ->
   *   `RecordCommand.transitions`), and this method reads that list. A
   *   parent-held relation beside the same `divide` builds no transition, and
   *   both engines answer the validator's sentence;
   * - the reference key has exactly ONE member (`RecordUpdateCompiler.ts:3310`
   *   `referencedFields.length === 1`, whose comment is explicit that "a
   *   compound one falls through to the per-member compile-time source rather
   *   than borrowing member zero's answer") — a compound reference key reaches
   *   the validator's sentence on both engines;
   * - the locator's DISCRIMINATOR pins the pre-value as a literal, which is
   *   what makes the transition nameable at analysis. `pinned` is the prepared
   *   selector's `facts.keys` — the `key: true` columns, which are the shipped
   *   `pinnedTargetValues` entries (`write-engine/shared.ts:154-166`) — never
   *   its `facts.equals`, which also collects an extended `where`'s filter half
   *   and its `AND`/`OR`/`NOT` arms.
   *
   * A payload naming exactly one computable operation — `set`, or an
   * arithmetic one the provider can carry — builds its transition and is not
   * this owner's business; the found arm's {@link keyPortabilityRefusal} is
   * what still judges the operator's portability, exactly as shipped.
   */
  keyTransitionRefusal(
    model: AnyModel,
    data: unknown,
    pinned: ReadonlyMap<string, unknown>,
    transitions: readonly Extract<Membership, { kind: "reference" }>[]
  ): Error | undefined {
    if (!isRecord(data)) return undefined;
    for (const keyField of this.keys(model)) {
      if (!pinned.has(keyField)) continue;
      const update = data[keyField];
      if (!isRecord(update)) continue;
      if (
        !transitions.some(
          (edge) =>
            edge.pairs.length === 1 && edge.pairs[0]!.source === keyField
        )
      )
        continue;
      const named = KEY_UPDATE_OPERATIONS.filter(
        (operation) => update[operation] !== undefined
      );
      if (named.length !== 1)
        return new QueryEngineError(
          `Cannot determine the updated primary key for model '${model["~"].names.ts!}' because field '${keyField}' uses an unsupported operation.`
        );
      if (update.divide === 0 || update.divide === 0n)
        return new QueryEngineError("Cannot divide a primary key by zero.");
    }
    return undefined;
  }
  private upsert(model: AnyModel, raw: unknown): Arguments {
    const envelope = parseValidated(upsertEnvelopeSchema, raw, "upsert", "");
    const schemas = this.registry.getModelSchemas(model);
    const createHasRelations = this.namesRelation(model, envelope.create);
    const updateScalars = Object.fromEntries(
      Object.entries(envelope.update).filter(
        ([name]) => !model["~"].relationNames.includes(name)
      )
    );
    const where = parseValidated(
      schemas.core.whereUniqueExtended,
      envelope.where,
      "upsert",
      "where"
    );
    const scalarCreate = createHasRelations
      ? undefined
      : parseValidated(
          schemas.core.scalarCreate,
          envelope.create,
          "upsert",
          "create"
        );
    const update = parseValidated(
      schemas.core.scalarUpdate,
      updateScalars,
      "upsert",
      "update"
    );
    const projection = parseValidated(
      schemas.core.upsertProjection,
      {
        select: envelope.select,
        include: envelope.include,
        omit: envelope.omit,
      },
      "upsert",
      ""
    );
    const conditions: Pick<Arguments, "targetWhere" | "setWhere"> = {
      targetWhere: undefined,
      setWhere: undefined,
    };
    for (const field of ["targetWhere", "setWhere"] as const) {
      const input = envelope[field];
      if (isRecord(input) && Object.keys(input).length)
        conditions[field] = record(
          parseValidated(schemas.core.where, input, "upsert", field)
        );
    }
    const create = createHasRelations
      ? parseValidated(schemas.core.create, envelope.create, "create", "data")
      : scalarCreate;
    const admittedUpdate = this.update(
      model,
      envelope.update,
      false,
      record(update)
    );
    // Operation dispatch supplies the correlation: upsert owns create/update, not data.
    return record({
      ...envelope,
      ...record(projection),
      ...conditions,
      where,
      create,
      update: admittedUpdate,
    }) as Arguments;
  }
  update(
    model: AnyModel,
    source: Input,
    captured: boolean,
    envelope?: Input
  ): Input {
    const schemas = this.registry.getModelSchemas(model);
    if (captured)
      return record(
        parseValidated(schemas.core.update, source, "updateMany", "data")
      );
    const admitted = { ...(envelope ?? source) };
    const names = Object.keys(source).filter((name) =>
      model["~"].relationNames.includes(name)
    );
    const isVariant = (name: string) =>
      model["~"].state.relations[name]!["~"].state.target.kind === "variants";
    // Admission phases are ordinary relations then carriers, retaining raw order within each.
    for (const name of names.sort(
      (a, b) => Number(isVariant(a)) - Number(isVariant(b))
    )) {
      if (source[name] !== undefined) {
        admitted[name] = parseValidated(
          (isVariant(name)
            ? schemas.polymorphic[name]!
            : schemas.relations[name]!
          ).update,
          source[name],
          "update",
          `data.${name}`
        );
      }
    }
    return admitted;
  }
  member(model: AnyModel, relation: string, source: Input): Input {
    const schema =
      this.registry.getModelSchemas(model).relations[relation]!.update;
    const parsed = record(
      parseValidated(
        schema,
        { updateMany: { data: source } },
        "update",
        `data.${relation}`
      )
    );
    return record(entries(parsed.updateMany)[0]!.data);
  }
  keys(model: AnyModel): readonly string[] {
    return getModelKeyCatalog(model).rowKey!.fields;
  }
  identity(model: AnyModel, row: Input): Input {
    return Object.fromEntries(
      this.keys(model).map((field) => [field, row[field]])
    );
  }
  membership(model: AnyModel, name: string, variant?: string): Membership {
    let modelViews = this.membershipViews.get(model);
    if (!modelViews) {
      modelViews = new Map();
      this.membershipViews.set(model, modelViews);
    }
    let slotViews = modelViews.get(name);
    if (!slotViews) {
      slotViews = new Map();
      modelViews.set(name, slotViews);
    }
    let view = slotViews.get(variant);
    if (!view) {
      view = freezeMembershipView(
        buildMembershipView(this, model, name, variant)
      );
      slotViews.set(variant, view);
    }
    return view;
  }
  clearability(resolved: ResolvedSlot): ClearableMembership {
    let view = this.clearabilityViews.get(resolved);
    if (!view) {
      view = clearableMembership(resolved);
      if (view.kind === "columns") Object.freeze(view.fields);
      Object.freeze(view);
      this.clearabilityViews.set(resolved, view);
    }
    return view;
  }
  physicalField(model: AnyModel, field: string): PhysicalField {
    let fields = this.physicalFields.get(model);
    if (!fields) {
      fields = new Map();
      this.physicalFields.set(model, fields);
    }
    let descriptor = fields.get(field);
    if (!descriptor) {
      descriptor = Object.freeze(buildPhysicalFieldView(this, model, field));
      fields.set(field, descriptor);
    }
    return descriptor;
  }
  /**
   * One adapter's {@link QueryViews}, created on its first use.
   *
   * `EngineSchema` already owns the lazy immutable per-model views this engine
   * resolves from the schema alone, but these two are also a fact of the
   * DIALECT — a scalar leaf carries the adapter's own `dateTime`
   * representation — and a `Queries` instance is per-operation for writes, so
   * neither owner alone can hold them. The adapter is the second key and it is
   * held weakly, so a view store lives exactly as long as the adapter it
   * describes. What it may hold is what every view here may hold: facts
   * derived from the schema and the dialect, never an admitted input, an
   * alias, an operation demand or a provider row (rule 5).
   *
   * The accessor names its one fact, like every other view on this class, so
   * the store cannot be reached for a second shape: an anonymous
   * `scope(adapter, create)` would hand a second caller the first caller's
   * object under the second caller's type, and the cast would hide it.
   */
  private readonly queryViewsByAdapter = new WeakMap<
    DatabaseAdapter,
    QueryViews
  >();
  queryViews(adapter: DatabaseAdapter): QueryViews {
    let views = this.queryViewsByAdapter.get(adapter);
    if (views === undefined) {
      views = createQueryViews();
      this.queryViewsByAdapter.set(adapter, views);
    }
    return views;
  }
  storedFields(model: AnyModel): readonly string[] {
    let fields = this.storedFieldLists.get(model);
    if (!fields) {
      fields = Object.freeze(buildStoredFieldsView(this, model));
      this.storedFieldLists.set(model, fields);
    }
    return fields;
  }
  /**
   * The admitted payload's scalar fields, in the model's own scalar order.
   *
   * One pass into one object. The model's scalar order is already memoised by
   * the model itself (`schema/model/model.ts`, `_scalarFieldNames ??=`), so the
   * only per-call cost left was the three intermediates
   * `Object.fromEntries(names.filter(…).map(…))` built — on a normalization
   * every row of every `createMany` crosses (`g4/cutover/perf-diagnosis.md`
   * §4.2). Same keys, same order, same values.
   */
  scalars(model: AnyModel, admitted: Input): Input {
    const values: Input = {};
    for (const field of model["~"].scalarFieldNames) {
      const value = admitted[field];
      if (value !== undefined) values[field] = value;
    }
    return values;
  }
}
