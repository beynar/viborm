/**
 * A call's row domain as prepared meaning, and the call's scope built from
 * it: what an extension's `rows`, `verbs`, `confine`, `evidence` and `reads`
 * declarations answer where the engine asks which rows a call may take, what
 * a row it writes must hold, and what a read may carry. The engine names
 * these questions and knows no declaration: this module is loaded with the
 * extensions that declare one.
 */

import { ForbiddenError, UnsupportedOperationError } from "@errors";
import {
  BOOLEAN_LEAF,
  type DeclaredEvidence,
  type FieldGate,
  freeze,
  type Leaf,
  NO_LAYERS,
  NO_RELATIONS,
  type PreparedPredicate,
  type PreparedProjection,
  type PreparedProjectionField,
  type PreparedSelector,
  type ProjectedFacts,
  type Queries,
  type Shape,
} from "@query-engine/raptor3/shared/query";
import type {
  CallRows,
  CallScope,
  LazyRelations,
  ModelVerbs,
  RowDomain,
  RowJudgement,
  RowPurpose,
} from "@query-engine/raptor3/shared/row-scope";
import {
  type Arguments,
  type EngineSchema,
  type Input,
  memo,
} from "@query-engine/raptor3/shared/schema";
import type { Membership } from "@query-engine/raptor3/shared/storage";
import type { Operation, PreparedGuardFailure } from "@query-engine/types";
import type { AnyModel } from "@schema/model";
import {
  evidence,
  gatedDocument,
  gateHolds,
  gating,
  guarded,
  refuseGatedRows,
} from "./gates";
import { layerOf } from "./layers";
import { producedSource, producedWhere } from "./produced";
import { admitProjected } from "./projected";
import { readsAny } from "./reads";

/** Equal gates shared, so a projection carries one member per distinct gate. */
function sharedGate(gate: FieldGate, known: FieldGate[]): FieldGate {
  const same = known.find(
    (other) =>
      other.length === gate.length &&
      other.every(
        ([layer, , input], index) =>
          layer === gate[index]![0] && input === gate[index]![2]
      )
  );
  if (same) return same;
  known.push(gate);
  return gate;
}

/**
 * One row domain as prepared meaning: per purpose and model, the conjunction
 * of the model's inputs, each a {@link PreparedPredicate} `layer` node,
 * prepared at most once for every `Queries` of one engine view (its reads and
 * its write contexts share it) and for every call: a value a call supplies is
 * a parameter. A layer's node holds its verb predicates beside its purpose's
 * (R2), each input prepared once whatever purposes and verbs reuse it.
 * Prepared meaning holds no alias, adapter or driver, so the view's own
 * `Queries` prepares it.
 */
export class PreparedDomain {
  readonly rows: RowDomain;
  /** The domain absent controls select: what a layer's traversals read (R5). */
  readonly defaults: PreparedDomain;
  readonly #queries: Queries;
  readonly #prepared = {
    root: new Map<string, PreparedSelector | null>(),
    related: new Map<string, PreparedSelector | null>(),
  };
  readonly #inputs = new Map<Input, PreparedSelector>();
  readonly #layered = new Map<string, Map<Input, PreparedSelector>>();
  readonly #projected = new Map<string, ProjectedFacts | null>();
  /** Whether a model's verbs declare a projection key or a gated field. */
  readonly projects: boolean;
  /**
   * The default projections of the models this domain projects facts for:
   * theirs differ from the view's shared ones, which carry no gate.
   */
  readonly defaultProjections = new WeakMap<AnyModel, PreparedProjection>();
  #view: Queries | undefined;
  constructor(rows: RowDomain, queries: Queries, defaults?: PreparedDomain) {
    this.rows = rows;
    this.#queries = queries;
    this.defaults = defaults ?? this;
    this.projects =
      rows.projects ??
      [...(rows.verbs?.values() ?? [])].some((layers) =>
        layers.some((verbs) => verbs?.evidence || verbs?.reads.size)
      );
  }
  /**
   * A call's arguments admitted with the projection keys this domain
   * declares kept beside the schema's.
   */
  /**
   * What an upsert says when it located no row and its create is refused
   * for the key it named: where no row of the model may be updated at all,
   * the row it located exists, and the update is what is not permitted.
   */
  located(model: AnyModel): ((cause: Error) => Error) | undefined {
    const name = model["~"].names.ts!;
    const never = this.rows.verbs?.get(name)?.some((layer) => {
      const members = layer?.update.OR;
      return (
        Array.isArray(members) &&
        members.length === 0 &&
        Object.keys(layer!.update).length === 1
      );
    });
    return never
      ? (cause) =>
          new ForbiddenError(name, "update", {
            reason: "the row this upsert locates exists",
            cause,
          })
      : undefined;
  }
  /** The row a write would leave, judged in the statement that writes it. */
  readonly producedSource = producedSource;
  readonly producedWhere = producedWhere;
  /** What a rule hides, and what it reports, of a row read. */
  readonly gateHolds = gateHolds;
  readonly evidence = evidence;
  readonly gatedDocument = gatedDocument;
  readonly gating = gating;
  readonly guarded = guarded;
  refuseGatedRows(model: AnyModel): void {
    refuseGatedRows(this.projected(model), model["~"].names.ts!);
  }
  admit(
    schema: EngineSchema,
    model: AnyModel,
    operation: Operation,
    raw: unknown,
    admit: (raw: unknown) => Arguments
  ): Arguments {
    return admitProjected(this, schema, model, operation, raw, admit);
  }
  /** `input`, one of `model`'s predicates in `layer`, as that layer's node. */
  layered(model: AnyModel, layer: number, input: Input): PreparedSelector {
    const name = model["~"].names.ts!;
    const inputs = memo(this.#layered, `${name} ${layer}`, () => new Map());
    return memo(inputs, input, () => {
      const part = this.#queries.prepareSelector(model, input);
      return part.predicate === undefined
        ? part
        : freeze({ ...part, predicate: layerOf(layer, name, part.predicate) });
    });
  }
  /** `model`'s projection keys and read-gated fields; `undefined` for none. */
  projected(model: AnyModel): ProjectedFacts | undefined {
    return this.projects ? this.#projectedFacts(model) : undefined;
  }
  #projectedFacts(model: AnyModel): ProjectedFacts | undefined {
    const name = model["~"].names.ts!;
    const facts = memo(this.#projected, name, () => {
      const keys = new Map<string, DeclaredEvidence>();
      const gates = new Map<string, FieldGate>();
      for (const [layer, verbs] of (
        this.rows.verbs?.get(name) ?? []
      ).entries()) {
        if (verbs === undefined) continue;
        const { evidence, read } = verbs;
        if (evidence)
          keys.set(
            evidence.as,
            freeze({
              layer,
              read,
              names: evidence.names,
              ordered: evidence.ordered,
            })
          );
        for (const [field, input] of verbs.reads)
          gates.set(field, [
            ...(gates.get(field) ?? []),
            freeze([layer, read, input] as const),
          ]);
      }
      const known: FieldGate[] = [];
      for (const [field, gate] of gates)
        gates.set(field, sharedGate(freeze(gate), known));
      return keys.size === 0 && gates.size === 0
        ? null
        : freeze({ keys, gates });
    });
    return facts ?? undefined;
  }
  /**
   * The read view under this domain for `call`: one for every call, whose
   * lifetime is the domain's, unless the call carries the values its
   * parameters read.
   */
  reads(call: CallScope): Queries {
    return call.rows.values === undefined
      ? (this.#view ??= this.#queries.under(this))
      : this.#queries.under(this, call);
  }
  /**
   * `model`'s predicate for `purpose` without the `excluded` layers, and,
   * under a `judgement`, each layer's predicates of its verb: `delete`'s, or
   * one per field an update writes (that field's own, else `update`'s), or
   * `update`'s when it writes none (R3). `undefined` where it states none.
   */
  selector(
    model: AnyModel,
    purpose: RowPurpose,
    excluded = NO_LAYERS,
    judgement?: RowJudgement
  ): PreparedSelector | undefined {
    const name = model["~"].names.ts!;
    const verbs = this.rows.verbs?.get(name);
    const judged = verbs && judgement;
    // The plain key allocates nothing: a read takes it at every lookup.
    const key = judged
      ? `${name} ${excluded} ${judged.verb}${judged.marks ? "+" : ""} ${[...judged.writes].sort()}`
      : excluded.length === 0
        ? name
        : `${name} ${excluded}`;
    let prepared = this.#prepared[purpose].get(key);
    if (prepared === undefined)
      prepared = this.#prepareSelector(model, purpose, excluded, judged, key);
    return prepared ?? undefined;
  }
  /**
   * What an `excluded` layer states its own whole-table sets of `model` hold
   * (`rows.confine`): inside its own predicates a layer reads nothing of
   * itself, but a set the statement computes over a whole table (a shared
   * body, a reaching set) still holds only what it bounds. `undefined` where
   * none states one.
   */
  bound(
    model: AnyModel,
    excluded: readonly number[]
  ): PreparedSelector | undefined {
    const name = model["~"].names.ts!;
    const inputs = this.rows.confine?.get(name);
    if (inputs === undefined) return undefined;
    // Every excluded layer's: each only narrows, and one left out would let
    // another's widen what it bounds.
    return (
      memo(this.#bounds, `${name} ${excluded}`, () => {
        const parts: PreparedSelector[] = [];
        for (const layer of excluded) {
          const input = inputs[layer];
          if (input === undefined) continue;
          const part = memo(this.#inputs, input, () =>
            this.#queries.prepareSelector(model, input)
          );
          parts.push(
            part.predicate === undefined
              ? part
              : freeze({
                  ...part,
                  predicate: layerOf(layer, name, part.predicate),
                })
          );
        }
        if (parts.length === 0) return null;
        return parts.length === 1
          ? parts[0]!
          : this.#queries.andSelectors(model, parts);
      }) ?? undefined
    );
  }
  readonly #bounds = new Map<string, PreparedSelector | null>();
  /** {@link selector}'s answer, prepared once per key. */
  #prepareSelector(
    model: AnyModel,
    purpose: RowPurpose,
    excluded: readonly number[],
    judged: RowJudgement | undefined,
    key: string
  ): PreparedSelector | null {
    const name = model["~"].names.ts!;
    const inputs = this.rows[purpose].get(name);
    const verbs = this.rows.verbs?.get(name);
    const queries = this.#queries;
    const prepared = memo(this.#prepared[purpose], key, () => {
      if (inputs === undefined && verbs === undefined) return null;
      const parts: PreparedSelector[] = [];
      const layers = Math.max(inputs?.length ?? 0, verbs?.length ?? 0);
      for (let layer = 0; layer < layers; layer++) {
        if (excluded.includes(layer)) continue;
        const own = verbs?.[layer];
        const wheres = [
          ...(own ? [own.read] : []),
          ...(inputs?.[layer] === undefined ? [] : [inputs[layer]!]),
          ...(own && judged ? verbInputs(own, judged) : []),
        ].map((where) =>
          memo(this.#inputs, where, () => queries.prepareSelector(model, where))
        );
        if (wheres.length === 0) continue;
        const part =
          wheres.length === 1
            ? wheres[0]!
            : queries.andSelectors(model, wheres);
        parts.push(
          part.predicate === undefined
            ? part
            : freeze({
                ...part,
                predicate: layerOf(layer, name, part.predicate),
              })
        );
      }
      if (parts.length === 0) return null;
      return parts.length === 1
        ? parts[0]!
        : queries.andSelectors(model, parts);
    });
    return prepared;
  }
  /**
   * A declared projection key (K5): `true` reports every declared name, a
   * list the names it gives, in declared order. Admission refused any other
   * value. With `ordered`, the last name that holds, `null` where `read` does
   * not; else one boolean per name.
   */
  projectEvidence(
    evidence: DeclaredEvidence,
    name: string,
    selection: unknown,
    fields: Record<string, Shape | Leaf>,
    prepared: PreparedProjectionField[]
  ): void {
    const names =
      selection === true
        ? evidence.names
        : evidence.names.filter(([held]) =>
            (selection as readonly string[]).includes(held)
          );
    fields[name] = evidence.ordered
      ? freeze({
          kind: "scalar",
          type: "enum",
          nullable: true,
          enumValues: new Set(names.map(([held]) => held)),
        })
      : freeze({
          kind: "object",
          nullable: false,
          fields: freeze(
            Object.fromEntries(names.map(([held]) => [held, BOOLEAN_LEAF]))
          ),
        });
    prepared.push(freeze({ kind: "evidence", name, evidence, names }));
  }
  /** Whether a call's `purpose` domain of `model` can leave a row out. */
  #hidesRows(queries: Queries, model: AnyModel, purpose: RowPurpose): boolean {
    const holds = (predicate: PreparedPredicate): boolean => {
      if (predicate.kind === "layer") {
        const resolved = predicate.resolve(queries);
        return resolved === undefined || holds(resolved);
      }
      if (predicate.kind === "and") return predicate.predicates.every(holds);
      return predicate.kind === "always" && predicate.value;
    };
    const domain = queries.domainOf(model, purpose);
    return domain?.predicate !== undefined && !holds(domain.predicate);
  }
  /**
   * Whether a call's extensions judge writes to a junction model: its rows,
   * its verbs. A link is written with neither read nor judged, so a `$through`
   * write through it is refused where a direct write would have been judged.
   */
  restrictsLinkWrite(queries: Queries, model: AnyModel): boolean {
    return (
      this.#hidesRows(queries, model, "root") ||
      this.#hidesRows(queries, model, "related") ||
      this.rows.verbs
        ?.get(model["~"].names.ts!)
        ?.some((verbs) => verbs !== undefined) === true
    );
  }
  /**
   * What a direct read of the junction model would hide stays hidden from a
   * `$through` that reads it, or that tests it, which is the same disclosure one
   * row at a time. Not honoured in the statement: a target row the hop reached
   * has no faithful answer for a link its reader may not see, so the call is
   * refused before any statement.
   */
  refuseHiddenLinkRow(
    queries: Queries,
    edge: Membership,
    fields: readonly string[],
    use: "read" | "filter"
  ): void {
    const model = (edge as Extract<Membership, { kind: "junction" }>).declared!
      .model;
    const name = model["~"].names.ts;
    if (
      this.#hidesRows(queries, model, "root") ||
      this.#hidesRows(queries, model, "related")
    )
      throw new UnsupportedOperationError(
        `Cannot ${use} $through of relation '${edge.name}': this client restricts which '${name}' rows a call may read. Read the links through the '${name}' delegate.`
      );
    const gates = queries.domain?.projected(model)?.gates;
    const gated = gates && fields.find((field) => gates.has(field));
    if (gated !== undefined)
      throw new UnsupportedOperationError(
        `Cannot ${use} $through.${gated} of relation '${edge.name}': this client gates that field of '${name}'. Read it through the '${name}' delegate.`
      );
  }
  /**
   * What a write of `operation` says when the row it would leave is refused:
   * `nested`, the verb and the relation it is written through.
   */
  refusal(
    operation: string,
    model: AnyModel,
    judgement?: RowJudgement,
    nested?: readonly [verb: string, relation: string]
  ): PreparedGuardFailure {
    if (nested)
      return {
        kind: "nestedWrite",
        relation: nested[1],
        message: `Cannot ${nested[0]} relation '${nested[1]}': the record it writes is not permitted.`,
        raceable: false,
      };
    const forbidden: PreparedGuardFailure = {
      kind: "forbidden",
      message: `${operation} produced a row that is not permitted.`,
      raceable: false,
    };
    const layers = judgement && this.rows.verbs?.get(model["~"].names.ts!);
    if (!(judgement && layers)) return forbidden;
    const moved = judgement.writes.filter((field) =>
      layers.some((layer) => layer?.moves.has(field) === true)
    );
    if (moved.length === 0) return forbidden;
    const relations = model["~"].state.relations;
    const through = judgement.writes.filter(
      (field) =>
        Object.hasOwn(relations, field) &&
        relations[field]!["~"].state.foreignKey?.fields.some((key) =>
          moved.includes(key)
        ) === true
    );
    return {
      ...forbidden,
      reason: `the row it would leave, judged again because it writes ${moved.join(", ")}${through.length > 0 ? ` (through ${through.join(", ")})` : ""}, is refused`,
    };
  }
  readonly #produced = new Map<string, PreparedSelector | null>();
  /**
   * What the row a write of `model` produces is judged at, as a value,
   * against the rows as they stand before the write (R4): a created row
   * (no `judgement`) at each layer's `place`; an updated one at the
   * predicates that judged its old row, `read` and its verb's (WITH CHECK),
   * and its written fields' `moves`. A write that states its candidates'
   * judgement in its own statement names the fields it `assigned`: where it
   * assigns none of what judged its old row, that judgement is the old
   * row's and is not stated twice. `undefined` where no layer judges it: no
   * verbs, no `place` for a create, a delete, an update nothing judges.
   */
  produced(
    model: AnyModel,
    judgement?: RowJudgement,
    assigned?: readonly string[]
  ): PreparedSelector | undefined {
    if (judgement?.verb === "delete") return undefined;
    const name = model["~"].names.ts!;
    const verbs = this.rows.verbs?.get(name);
    if (verbs === undefined) return undefined;
    const queries = this.#queries;
    const changed = assigned && new Set(assigned);
    const keys = queries.schema.keys(model);
    const prepare = (where: Input) =>
      memo(this.#inputs, where, () => queries.prepareSelector(model, where));
    const prepared = memo(
      this.#produced,
      judgement
        ? `update ${name} ${[...judgement.writes].sort()} ${assigned ? [...assigned].sort() : "*"}`
        : `create ${name}`,
      () => {
        const parts: PreparedSelector[] = [];
        for (const [layer, own] of verbs.entries()) {
          if (own === undefined) continue;
          // What judged the old row judges the new one, unless the write
          // assigns nothing it reads: then the new row's answer is the old
          // row's, which the statement's own candidates already state.
          const checked = judgement
            ? [own.read, ...verbInputs(own, judgement)]
            : [];
          const unchanged =
            changed !== undefined &&
            checked.every(
              (where) =>
                prepare(where).predicate === undefined ||
                !readsAny(prepare(where).predicate!, changed, keys)
            );
          const wheres = judgement
            ? [
                ...(unchanged ? [] : checked),
                ...judgement.writes.flatMap((field) => {
                  const move = own.moves.get(field);
                  return move === undefined ? [] : [move];
                }),
              ]
            : own.place === undefined
              ? []
              : [own.place];
          if (wheres.length === 0) continue;
          const selectors = [...new Set(wheres)].map(prepare);
          const part =
            selectors.length === 1
              ? selectors[0]!
              : queries.andSelectors(model, selectors);
          if (part.predicate !== undefined)
            parts.push(
              freeze({
                ...part,
                predicate: layerOf(layer, name, part.predicate),
              })
            );
        }
        if (parts.length === 0) return null;
        return parts.length === 1
          ? parts[0]!
          : queries.andSelectors(model, parts);
      }
    );
    return prepared ?? undefined;
  }
  /**
   * The self relations whose links an update judged at `judgement` must
   * keep acyclic (R4): each layer's `acyclic` relations of `model` whose key
   * fields it writes.
   */
  cycles(model: AnyModel, judgement: RowJudgement): readonly string[] {
    if (judgement.verb === "delete") return NO_RELATIONS;
    const verbs = this.rows.verbs?.get(model["~"].names.ts!);
    if (verbs === undefined) return NO_RELATIONS;
    const relations = new Set<string>();
    const written = (relation: string) => {
      const edge = this.#queries.schema.membership(model, relation);
      return (
        judgement.writes.includes(relation) ||
        (edge.kind === "reference" &&
          edge.pairs.some((pair) => judgement.writes.includes(pair.source)))
      );
    };
    for (const own of verbs) {
      const acyclic = own?.acyclic;
      if (acyclic === undefined) continue;
      const named = Array.isArray(acyclic)
        ? acyclic
        : (acyclic as LazyRelations).candidates.some(written)
          ? (acyclic as LazyRelations).resolve()
          : NO_RELATIONS;
      for (const relation of named)
        if (written(relation)) relations.add(relation);
    }
    return relations.size === 0 ? NO_RELATIONS : [...relations];
  }
}
/** The verb predicates one layer's `judgement` takes, each once. */
function verbInputs(verbs: ModelVerbs, judgement: RowJudgement): Input[] {
  if (judgement.verb === "delete") return [verbs.delete];
  if (judgement.writes.length === 0) return [verbs.update];
  return [
    ...new Set([
      ...judgement.writes.map(
        (field) => verbs.writes.get(field) ?? verbs.update
      ),
      ...(judgement.marks ? [verbs.delete] : []),
    ]),
  ];
}

/**
 * Each row domain a call selects, prepared once per query owner. A prepared
 * domain derives only from the domain, that owner (its adapter and result
 * parser) and its defaults, so clients sharing the owner share it too. The
 * domain alone keys it: a chain's binding builds each domain with its one
 * default domain.
 */
const preparedDomains = new WeakMap<
  Queries,
  WeakMap<RowDomain, PreparedDomain>
>();

function preparedDomain(
  queries: Queries,
  rows: RowDomain,
  defaults?: PreparedDomain
): PreparedDomain {
  const byDomain = memo(preparedDomains, queries, () => new WeakMap());
  return memo(
    byDomain,
    rows,
    () => new PreparedDomain(rows, queries, defaults)
  );
}

/** One call's row facts as the engine reads them: its domains prepared for `queries`. Stated on every {@link CallRows}. */
export function prepareCall(
  this: CallRows,
  queries: Queries,
  instant: () => Date
): CallScope {
  const defaults = preparedDomain(queries, this.defaults);
  return {
    rows: this,
    domain: preparedDomain(queries, this.domain, defaults),
    defaults,
    instant,
  };
}
