/** The one projection decoder: provider rows and live transports read the same placements. */
import type { DatabaseAdapter } from "@adapters/database-adapter";
import {
  QueryEngineError,
  UnsupportedOperationError,
  ValidationError,
} from "@errors";
import { POLYMORPHIC_COLLECTION_ORPHANS_KEY } from "@query-engine/result-aliases";
import { normalizeBinaryValue } from "@validation/primitives/binary-shapes";
import {
  decodePhysicalDateTime,
  decodeProviderTimestamp,
} from "@validation/primitives/datetime-physical-codec";
import {
  isDateTimeClock,
  isDateTimeInstant,
} from "@validation/primitives/datetime-values";
import { validateGeoPoint } from "@validation/primitives/geo-point-codec";
import { decodePhysicalId } from "@validation/primitives/id-codec";
import {
  carriesRepeatedKey,
  DEFAULT_MAX_OCCURRENCES,
} from "@validation/relations/recurrence-values";
import {
  decodeDecimalList,
  decodeDecimalScalar,
} from "../raptor3/shared/decimal";
import type { Operation } from "../types";
import {
  type CollectionShape,
  type Leaf,
  type ProjectionShape,
  RECURSIVE_CARRIER,
} from "./projection-shape";

type Input = Record<string, unknown>;
type Shape = ProjectionShape;
/** One placement of the projection language, compiled for one decoded batch. */
export type Reader = (value: unknown) => unknown;

/** What one decoder reads beside the shape: the dialect's spellings and its provider continuation. */
export interface DecoderBinding {
  readonly result: Pick<
    DatabaseAdapter["result"],
    | "decimalRepresentation"
    | "decimalListRepresentation"
    | "enumListRepresentation"
  >;
  /** Whether an int64 `_sum` travels as `aggregates.integerSum`'s two parts. */
  readonly integerSum: boolean;
  /** A PHYSICAL scalar slot's provider continuation. */
  readonly fieldReader?: (type: string) => Reader;
}

const freeze = Object.freeze;
const BOOLEAN_LEAF: Leaf = freeze({
  kind: "scalar",
  type: "boolean",
  nullable: false,
});
// Callers below established the row's object shape at the provider boundary.
const record = (value: unknown): Input => value as Input;
/**
 * A membership the parent claims whose row is gone.
 *
 * The statement answers a claimed arm with a document and an unclaimed one
 * with `null`, so an EMPTY document is the claim without the row. The test is
 * the arm's own selected keys — a shape that requests fields and receives none
 * — and never a private carrier column (Arnaud's D-19).
 */
function orphanedArm(carrier: unknown, arm: ProjectionShape): boolean {
  if (arm.kind !== "object" || carrier === null || carrier === undefined)
    return false;
  const document = providerJson(carrier);
  if (typeof document !== "object" || document === null) return false;
  return (
    Object.keys(document).length === 0 && Object.keys(arm.fields).length > 0
  );
}
/**
 * A structured value — a document, a collection, a variant slot, a recursive
 * carrier, or a vector or point scalar — as the provider handed it: a driver
 * that does not parse JSON itself hands back the value's TEXT, which is parsed
 * here once, and any other value is already the parsed structure.
 */
function providerJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
/**
 * The ONE reading of a provider DOCUMENT, whatever carries it: a root row, a
 * relation, `_count` or aggregate carrier, a collection row, a variant slot,
 * its integrity entry and each of its arms, a recursive node row, the
 * recursive carrier and each of its node and edge entries. A document is an
 * object that is not an array, and its members are then read by {@link own}.
 * `null` is answered as itself, because only the placement knows whether its
 * shape permits it; anything else is no document (`undefined`), which the
 * placement refuses in its own registered sentence. The one placement that
 * may be ABSENT is the integrity entry, which a slot without junction
 * memberships does not carry; a present one is refused like any other.
 */
function providerDocument(value: unknown): Input | null | undefined {
  if (value === null) return null;
  return typeof value === "object" && !Array.isArray(value)
    ? record(value)
    : undefined;
}
/**
 * One member of a provider document, read with OWN-key semantics. An omitted
 * field is absent, whatever `Object.prototype` happens to carry under that
 * name.
 */
function own(source: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}
/** The decoder identifies the invalid value; its operation owns public errors. */
export class InvalidScalarResult extends TypeError {
  readonly scalarType: string;
  readonly reason: string;
  constructor(scalarType: string, reason: string) {
    super(`Invalid provider ${scalarType === "int" ? "integer" : scalarType}`);
    this.scalarType = scalarType;
    this.reason = reason;
  }
}

/**
 * A recursive projection decoded more occurrences under one outer row than
 * its budget (`recurse.maxOccurrences`). The decoder knows the slot; as for
 * {@link InvalidScalarResult}, its operation owns the public error.
 */
export class RecursiveOutputOverBudget extends RangeError {
  readonly relation: string;
  readonly limit: number;
  constructor(relation: string, limit: number) {
    super(`Recursive relation '${relation}' exceeds ${limit} occurrences`);
    this.relation = relation;
    this.limit = limit;
  }
  /** The result-size refusal of `operation`, which ran the projection. */
  refusal(operation: Operation, model: string): UnsupportedOperationError {
    return new UnsupportedOperationError(
      `'${operation}' would return more than ${this.limit} occurrences of recursive relation '${this.relation}' under one row, its output budget; raise recurse.maxOccurrences, lower recurse.depth or filter the relation.`,
      {
        meta: {
          model,
          operation,
          relation: this.relation,
          feature: "recursive output budget",
        },
      }
    );
  }
}

/**
 * A row the read returned lacks the gate of a field the caller named (K5,
 * OD-5): raised while decoding, after the statement and before any result.
 * Like {@link InvalidScalarResult}, its operation owns the public error.
 */
export class GatedFieldRefusal extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`The selected field at '${path}' is not readable on a returned row`);
    this.path = path;
  }
  /** The `ValidationError` of `operation`, at the path the caller named. */
  refusal(operation: Operation, model: string): ValidationError {
    return new ValidationError(
      operation,
      [{ path: this.path, message: "is not readable on a returned row" }],
      { meta: { model } }
    );
  }
}

export class ProjectionDecoder {
  readonly #binding: DecoderBinding;
  constructor(binding: DecoderBinding) {
    this.#binding = binding;
  }
  decodeRows(
    shape: ProjectionShape,
    rows: Input[] | unknown[][],
    internal = false,
    columns?: readonly string[]
  ): Input[] {
    // An empty batch — a filter that matched nothing — reads nothing, so it
    // compiles nothing.
    if (rows.length === 0) return [];
    const read = this.compileReader(shape, internal, false, columns);
    return rows.map((row) => record(read(row)));
  }
  private decodeRecursiveCarrier(
    shape: Extract<Shape, { kind: "recursive" }>,
    value: unknown,
    readRow: Reader,
    readIdentity: readonly Reader[]
  ): unknown {
    const carrier = providerDocument(providerJson(value));
    if (!carrier)
      throw new InvalidScalarResult(
        "recursive carrier",
        "the carrier is not an object"
      );
    const root = own(carrier, RECURSIVE_CARRIER.root);
    const rawNodes = own(carrier, RECURSIVE_CARRIER.nodes);
    const rawEdges = own(carrier, RECURSIVE_CARRIER.edges);
    if (
      !(
        Array.isArray(root) &&
        Array.isArray(rawNodes) &&
        Array.isArray(rawEdges)
      )
    )
      throw new InvalidScalarResult(
        "recursive carrier",
        "the carrier's root, nodes or edges member is not an array"
      );

    const identity = (tuple: unknown): string => {
      if (!Array.isArray(tuple) || tuple.length !== shape.identity.length)
        throw new InvalidScalarResult(
          "recursive identity",
          "an identity is not a tuple of the key's width"
        );
      // A counted walk: `entries()` allocated an iterator and a pair per
      // member on every identity — root, node key and both edge endpoints.
      let index = 0;
      for (const read of readIdentity) {
        read(tuple[index]);
        index += 1;
      }
      return JSON.stringify(tuple);
    };
    const rootKey = identity(root);
    const nodes = new Map<string, unknown>();
    for (const rawNode of rawNodes) {
      const node = providerDocument(rawNode);
      if (!node)
        throw new InvalidScalarResult(
          "recursive node",
          "a node entry is not an object"
        );
      const key = identity(own(node, RECURSIVE_CARRIER.key));
      if (nodes.has(key))
        throw new InvalidScalarResult(
          "duplicate recursive node",
          "two nodes carry the same identity"
        );
      nodes.set(key, own(node, RECURSIVE_CARRIER.row));
    }

    type Edge = { readonly child: string; readonly depth?: number };
    const edges = new Map<string, Edge[]>();
    const facts = new Set<string>();
    for (const rawEdge of rawEdges) {
      const edge = providerDocument(rawEdge);
      if (!edge)
        throw new InvalidScalarResult(
          "recursive edge",
          "an edge entry is not an object"
        );
      const parent = identity(own(edge, RECURSIVE_CARRIER.parent));
      const child = identity(own(edge, RECURSIVE_CARRIER.child));
      if (!nodes.has(child))
        throw new InvalidScalarResult(
          "recursive edge endpoint",
          "an edge's child is not a carried node"
        );
      const rawDepth = own(edge, RECURSIVE_CARRIER.depth);
      let depth: number | undefined;
      if (shape.recurrence.depth === false) {
        if (rawDepth !== undefined)
          throw new InvalidScalarResult(
            "exhaustive recursive depth",
            "an exhaustive carrier states an edge depth"
          );
      } else {
        if (
          typeof rawDepth !== "number" ||
          !Number.isSafeInteger(rawDepth) ||
          rawDepth < 1 ||
          rawDepth > shape.recurrence.depth
        )
          throw new InvalidScalarResult(
            "recursive depth",
            "an edge depth is not an integer from 1 to the cutoff"
          );
        depth = rawDepth;
      }
      const fact = JSON.stringify([parent, child, depth ?? null]);
      if (facts.has(fact))
        throw new InvalidScalarResult(
          "duplicate recursive edge",
          "an edge fact is carried twice"
        );
      facts.add(fact);
      const siblings = edges.get(parent);
      const entry = freeze({
        child,
        ...(depth === undefined ? {} : { depth }),
      });
      if (siblings) siblings.push(entry);
      else edges.set(parent, [entry]);
    }

    /**
     * One parent, one answer, taken once over the COMPLETE edge index: the
     * distinct successors it offers, in transported sibling order. Their count
     * is also where singular cardinality is answerable at all, so the parent's
     * endpoint, its cardinality and its successors are decided here — over
     * every transported fact — instead of being rediscovered at each
     * occurrence that happens to unfold this parent.
     */
    const successors = new Map<string, readonly string[]>();
    for (const [parent, entries] of edges) {
      if (parent !== rootKey && !nodes.has(parent))
        throw new InvalidScalarResult(
          "recursive edge endpoint",
          "an edge's parent is neither the root nor a carried node"
        );
      const unique = [...new Set(entries.map((entry) => entry.child))];
      if (!shape.many && unique.length > 1)
        throw new InvalidScalarResult(
          "recursive singular relation",
          "a singular parent has several successors"
        );
      successors.set(parent, unique);
    }
    /**
     * ONE walk over the transported facts, before any of them is unfolded.
     *
     * The root is reached at level 0, and a bounded edge is reachable only one
     * level below its own recorded `__rq_depth` — the only meaning that number
     * has, and the reason the provider transports it. An identity reached by
     * several distinct paths keeps EVERY level it was reached at, so a diamond
     * and a re-entered junction node stay legal; an exhaustive carrier records
     * no level, collapses to the identity alone, and so still terminates on a
     * legal cyclic graph.
     *
     * Three facts fall out of that one walk. A BOUNDED edge no level can
     * consume is a depth attributed to a hop it was not discovered at. A
     * bounded hop below the cutoff whose children at the next level are not
     * the parent's one answer is a hop the provider did not discover: the
     * statement discovers a parent's children at EVERY level it reaches that
     * parent (a filter prunes each hop the same way, and prevention is this
     * decoder's, not the statement's), so unfolding the one answer there would
     * invent an occurrence the carrier never transported. An identity no
     * consumed edge reaches is a node outside this answer. Only a stated depth
     * can be misattributed or missing, so only a bounded carrier is asked the
     * first two questions: on an exhaustive one an unconsumed edge means its
     * parent was never reached, which is the third question's answer.
     */
    const consumed = new Set<Edge>();
    const reached = new Set<string>();
    const levels = new Set<string>();
    const pending: (readonly [string, number])[] = [[rootKey, 0]];
    // `for…of` re-reads the length each step, so the levels pushed below are
    // walked too, exactly as the indexed loop did.
    for (const [parent, level] of pending) {
      const children = new Set<string>();
      for (const entry of edges.get(parent) ?? []) {
        if (entry.depth !== undefined && entry.depth !== level + 1) continue;
        consumed.add(entry);
        reached.add(entry.child);
        children.add(entry.child);
        const at =
          entry.depth === undefined
            ? entry.child
            : `${entry.depth} ${entry.child}`;
        if (levels.has(at)) continue;
        levels.add(at);
        pending.push([entry.child, level + 1]);
      }
      if (
        shape.recurrence.depth !== false &&
        carriesRepeatedKey(shape.recurrence.depth, level) &&
        children.size !== (successors.get(parent)?.length ?? 0)
      )
        throw new InvalidScalarResult(
          "recursive depth",
          "a hop below the cutoff omits some of its parent's children"
        );
    }
    if (shape.recurrence.depth !== false && consumed.size !== facts.size)
      throw new InvalidScalarResult(
        "recursive depth",
        "an edge is not reachable at its recorded depth"
      );
    if (reached.size !== nodes.size)
      throw new InvalidScalarResult(
        "unreachable recursive node",
        "a carried node is not reachable from the root"
      );

    /** A numeric cutoff reached: this occurrence omits the repeated slot. */
    const cutoff = (depth: number) =>
      !carriesRepeatedKey(shape.recurrence.depth, depth);
    /** One slot's successors, collapsed by its cardinality and emptiness. */
    // A singular slot here may be empty: CM002 refuses a required self
    // foreign key.
    const collapse = (rows: Input[]): unknown => {
      if (rows.length > 0) return shape.many ? rows : rows[0]!;
      return shape.many ? [] : null;
    };
    type Frame = {
      readonly key: string;
      readonly depth: number;
      readonly row: Input;
      readonly childKeys: readonly string[];
      readonly childRows: Input[];
      next: number;
    };
    /**
     * ONE active path, seeded by the outer row and kept by enter and leave.
     *
     * Copying the ancestry prefix into every descended occurrence held those
     * identities once per hop and made a chain quadratic in its own depth;
     * the stack already holds them.
     */
    const active = new Set<string>([rootKey]);
    const stack: Frame[] = [];
    /**
     * The one admission EVERY followed edge passes, the first hop included —
     * which is what seeding the path with the root makes possible: a graph
     * edge straight back to the outer row is a revisit like any other, and an
     * FK one is the same refusal at the first hop as at the hundredth.
     */
    let occurrences = 0;
    const budget = shape.recurrence.maxOccurrences ?? DEFAULT_MAX_OCCURRENCES;
    const follow = (from: number, key: string): void => {
      if (active.has(key)) {
        if (shape.recurrence.cycles === "reject")
          throw new UnsupportedOperationError(
            `Recursive relation '${shape.relation}' contains a cycle.`,
            {
              meta: {
                relation: shape.relation,
                feature: "cyclic recursive traversal",
              },
            }
          );
        if (shape.recurrence.cycles === "prevent") return;
      }
      if (++occurrences > budget)
        throw new RecursiveOutputOverBudget(shape.relation, budget);
      active.add(key);
      const decoded = readRow(nodes.get(key));
      if (decoded === null)
        throw new InvalidScalarResult("recursive row", "a node's row is null");
      const depth = from + 1;
      stack.push({
        key,
        depth,
        row: record(decoded),
        childKeys: cutoff(depth) ? [] : (successors.get(key) ?? []),
        childRows: [],
        next: 0,
      });
    };
    const rootRows: Input[] = [];
    for (const child of successors.get(rootKey) ?? []) {
      follow(0, child);
      for (
        let current = stack.at(-1);
        current !== undefined;
        current = stack.at(-1)
      ) {
        if (current.next < current.childKeys.length) {
          follow(current.depth, current.childKeys[current.next++]!);
          continue;
        }
        active.delete(current.key);
        stack.pop();
        if (!cutoff(current.depth))
          current.row[shape.relation] = collapse(current.childRows);
        const parent = stack.at(-1);
        if (parent) parent.childRows.push(current.row);
        else rootRows.push(current.row);
      }
    }
    return collapse(rootRows);
  }
  /**
   * The ONE decoder of the projection language, compiled for one decoded
   * batch — a result window, a RETURNING answer, an internal read — and
   * dropped with it. Every invariant decision of a placement is taken here,
   * once: an object's member list and each member's placement, a variant
   * slot's arms, a collection's and a recursive carrier's row reader, a list
   * leaf's container reader ({@link compileList}), and — for a PHYSICAL
   * scalar slot only — this execution's provider continuation
   * ({@link fieldReader}). The returned reader then does only what depends on
   * the provider's value, through the preselected scalar codec
   * ({@link compileScalar}) and the one carrier validator
   * ({@link decodeRecursiveCarrier}).
   *
   * `carried` is a fact of the PLACEMENT, never of the shape: a to-one
   * relation's shape is its target's shared default projection, read as the
   * root row of one statement and inside a JSON document of another. Only a
   * scalar member of a physical row crosses the provider chain; a JSON window
   * already decoded everything under it.
   *
   * The reader holds a driver's parser, so it lives no longer than the batch
   * it was compiled for and is never stored on the prepared shape, which
   * `EngineSchema` shares across executions and driver bindings.
   */
  private compileReader(
    shape: Shape | Leaf,
    internal: boolean,
    carried: boolean,
    columns?: readonly string[]
  ): Reader {
    if (shape.kind === "scalar") {
      const provider = carried
        ? undefined
        : this.#binding.fieldReader?.(shape.type);
      const list = shape.list ? this.compileList(shape, internal) : undefined;
      return this.compileScalar(shape, internal, provider, list);
    }
    if (shape.kind === "recursive") {
      const readRow = this.compileReader(shape.row, internal, true);
      // An identity is validated as the stored key it is (an INTERNAL read),
      // never published.
      const readIdentity = shape.identity.map((leaf) =>
        this.compileReader(leaf, true, true)
      );
      return (value) =>
        this.decodeRecursiveCarrier(shape, value, readRow, readIdentity);
    }
    if (shape.kind === "variants") {
      const slot = (value: unknown): Input => {
        // The slot is a provider document the statement always builds, read
        // by the one document rule: a NULL or non-object slot is a malformed
        // result, refused at the slot before any arm is asked (Arnaud,
        // 2026-09-25).
        const variants = providerDocument(providerJson(value));
        if (!variants)
          throw new InvalidScalarResult(
            "polymorphic slot",
            "the slot is not an object"
          );
        // The integrity probe first, and before any arm: a membership whose
        // row is gone is a fact about the SLOT, so `only` — which selects what
        // is read — cannot make it unobservable (Arnaud's D-26). One refusal,
        // from the decoder arm that already owns the sentence. Its entry is a
        // document of the slot, read by the same rule: a slot with no
        // junction membership carries none, and a PRESENT entry that is no
        // document is the slot's malformed result — never "no memberships".
        const evidence = own(variants, POLYMORPHIC_COLLECTION_ORPHANS_KEY);
        if (evidence === undefined) return variants;
        const orphans = providerDocument(evidence);
        if (!orphans)
          throw new InvalidScalarResult(
            "polymorphic slot",
            "the integrity entry is not an object"
          );
        for (const [type, count] of Object.entries(orphans))
          if (Number(count) > 0) {
            if (type === "$storage")
              throw new QueryEngineError(
                `Polymorphic relation '${shape.relation}' has an unknown discriminator or incomplete stored pair.`
              );
            throw new QueryEngineError(
              `Polymorphic relation '${shape.relation}' references a missing '${type}' record.`
            );
          }
        return variants;
      };
      // Its arms, compiled once, in `shape.arms` order. A junction-carried
      // slot's arm is a collection, so its reader answers the arm's rows.
      if (shape.many) {
        const arms = Object.keys(shape.arms).map((type) => ({
          type,
          read: this.#compileCollection(shape.arms[type]!, internal),
        }));
        return (value) => {
          const variants = slot(value);
          const values: unknown[] = [];
          for (const { type, read } of arms)
            for (const data of read(own(variants, type)))
              values.push({ type, data });
          return values;
        };
      }
      const arms = Object.keys(shape.arms).map((type) => {
        const arm = shape.arms[type]!;
        return { type, arm, read: this.compileReader(arm, internal, true) };
      });
      return (value) => {
        const variants = slot(value);
        for (const { type, arm, read } of arms) {
          const carrier = own(variants, type);
          if (orphanedArm(carrier, arm))
            throw new QueryEngineError(
              `Polymorphic relation '${shape.relation}' references a missing '${type}' record.`
            );
          const data = read(carrier);
          if (data !== null) return { type, data };
        }
        return null;
      };
    }
    if (shape.kind === "collection")
      return this.#compileCollection(shape, internal);
    // The document's MEMBER LIST is a fact of the PREPARED PROJECTION, stated
    // once by {@link prepareProjection} and frozen on the shape; a row carries
    // only the values for it. It is read here, once per batch — the shape's
    // OWN keys, exactly as {@link own} reads the provider's — and never again
    // per row: materialising it per row as pairs (`Object.entries` read back
    // by `Object.fromEntries`) made this decoder allocate 2.5x the shipped
    // engine's bytes per row (`g4/release/p1/note.md`).
    const fields = Object.keys(shape.fields);
    const readers = fields.map((field) => {
      const nested = shape.fields[field]!;
      return this.compileReader(
        nested,
        internal,
        carried || nested.kind !== "scalar"
      );
    });
    // An internal read is the engine's own: it reads every member it asked
    // for, its gates unread (K5).
    if (shape.gates !== undefined && !internal)
      return this.#compileGatedDocument(
        shape,
        fields,
        readers,
        carried,
        columns
      );
    if (columns) {
      // Native aliases locate cells once; a statement transform may reorder
      // columns. Last occurrence matches the keyed transport's duplicate names.
      const positions = fields.map((field) => columns.lastIndexOf(field));
      return (value) => {
        if (!Array.isArray(value))
          throw new InvalidScalarResult(
            "row",
            "a positional row is not an array"
          );
        const document: Input = {};
        for (let index = 0; index < fields.length; index++) {
          const position = positions[index]!;
          document[fields[index]!] = readers[index]!(
            position < 0 ? undefined : value[position]
          );
        }
        return document;
      };
    }
    return (value) => {
      const source = providerDocument(providerJson(value));
      if (source === null) {
        if (shape.nullable === false)
          throw new InvalidScalarResult(
            "row",
            "a document the statement always builds is null"
          );
        return null;
      }
      if (source === undefined)
        throw new InvalidScalarResult(
          "row",
          "a requested document is not a provider row"
        );
      // OWN-key semantics ({@link own}): a plain member read on a
      // `JSON.parse` result finds `Object.prototype`'s own members, so a
      // field named `toString` the provider OMITTED would inherit a function
      // instead of failing closed. Nested evidence documents also contain
      // user-named predicates, not just schema identifiers. Their `__proto__`
      // member must be an own data property, never the inherited setter.
      const document: Input = {};
      for (let index = 0; index < fields.length; index++) {
        const field = fields[index]!;
        const decoded = readers[index]!(own(source, field));
        if (field === "__proto__")
          Object.defineProperty(document, field, {
            value: decoded,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        else document[field] = decoded;
      }
      return document;
    };
  }
  /**
   * A document with read-gated members (K5), out of line from the plain
   * reader: its gates are read first, once per row, and each gated member is
   * written only where its gate holds; where it does not, a member the caller
   * named fails the read, and any other is left out (the row's shape
   * changes, so the document is always a new object).
   */
  #compileGatedDocument(
    shape: Extract<ProjectionShape, { kind: "object" }>,
    fields: readonly string[],
    readers: readonly Reader[],
    carried: boolean,
    columns?: readonly string[]
  ): Reader {
    const gates = shape.gates!;
    const readGate = this.compileReader(BOOLEAN_LEAF, false, carried);
    const gated = fields.map((field) => shape.gated![field]);
    const gateIndex = gated.map((member) =>
      member === undefined ? -1 : gates.indexOf(member.gate)
    );
    const positions = columns && [
      ...fields.map((field) => columns.lastIndexOf(field)),
      ...gates.map((gate) => columns.lastIndexOf(gate)),
    ];
    const cell = (source: unknown, index: number, key: string): unknown => {
      if (positions === undefined) return own(source as Input, key);
      const position = positions[index]!;
      return position < 0 ? undefined : (source as unknown[])[position];
    };
    return (value) => {
      let source: unknown = value;
      if (positions) {
        if (!Array.isArray(value))
          throw new InvalidScalarResult(
            "row",
            "a positional row is not an array"
          );
      } else {
        source = providerDocument(providerJson(value));
        if (source === null) {
          if (shape.nullable === false)
            throw new InvalidScalarResult(
              "row",
              "a document the statement always builds is null"
            );
          return null;
        }
        if (source === undefined)
          throw new InvalidScalarResult(
            "row",
            "a requested document is not a provider row"
          );
      }
      const held = gates.map((gate, index) =>
        readGate(cell(source, fields.length + index, gate))
      );
      const document: Input = {};
      for (let index = 0; index < fields.length; index++) {
        const field = fields[index]!;
        const gate = gateIndex[index]!;
        if (gate >= 0 && held[gate] !== true) {
          const refused = gated[index]!.refused;
          if (refused !== undefined) throw new GatedFieldRefusal(refused);
          continue;
        }
        document[field] = readers[index]!(cell(source, index, field));
      }
      return document;
    };
  }
  /**
   * A collection's reader, compiled by {@link compileReader} for a to-many
   * relation and for each arm of a junction-carried variant slot: its rows
   * are carried documents, restored to the requested order.
   */
  #compileCollection(
    shape: CollectionShape,
    internal: boolean
  ): (value: unknown) => unknown[] {
    const readRow = this.compileReader(shape.row, internal, true);
    return (value) => {
      const decoded = providerJson(value);
      if (!Array.isArray(decoded))
        throw new InvalidScalarResult(
          "collection",
          "a requested relation is not a provider array"
        );
      const rows = decoded.map(readRow);
      return shape.reversed ? rows.reverse() : rows;
    };
  }
  /**
   * One strict scalar decode per leaf, through the existing codec owners. A
   * value outside the column's declared domain is a malformed provider row,
   * never a value to coerce. `provider` is the physical value's continuation;
   * a CARRIED value — one a JSON document already holds — has none. `list` is
   * a list leaf's compiled container reader, and a list MEMBER's leaf is no
   * list.
   */
  private compileScalar(
    leaf: Leaf,
    internal: boolean,
    provider?: Reader,
    list?: Reader
  ): Reader {
    const readValue = list ?? this.#compileScalarValue(leaf, internal);
    const nullable = leaf.nullable;
    const allowsJsonNull = leaf.type === "json" && leaf.list !== true;
    const read: Reader = (raw) => {
      if (raw === null) {
        if (nullable) return null;
        if (!allowsJsonNull)
          throw new InvalidScalarResult(
            leaf.type,
            leaf.list ? "a required list is null" : "a required scalar is null"
          );
      }
      if (raw === undefined)
        throw new InvalidScalarResult(leaf.type, "the value is absent");
      return readValue(provider === undefined ? raw : provider(raw));
    };
    // A widened sum the statement split in two (`Queries.#splitSum`).
    let join: Reader | undefined;
    if (leaf.widened && leaf.type === "number") join = joinNumberSum;
    else if (leaf.widened && this.#binding.integerSum)
      join = (parts) => joinIntegerSum(parts, leaf.type);
    return join ? (parts) => read(join(parts)) : read;
  }
  /** Bind the declared scalar codec once, preserving its provider-value checks. */
  #compileScalarValue(leaf: Leaf, internal: boolean): Reader {
    const identifier = leaf.id;
    if (identifier !== undefined) {
      return (value) => {
        const decoded = decodePhysicalId(
          value,
          identifier.domain,
          identifier.representation
        );
        if (decoded === undefined)
          throw new InvalidScalarResult(
            leaf.type,
            "the value is not in this column's declared identifier domain"
          );
        return internal && identifier.representation === "text"
          ? value
          : decoded;
      };
    }
    switch (leaf.type) {
      case "string":
        return decodeString;
      case "boolean":
        return decodeBoolean;
      case "int":
        return leaf.widened ? (sum) => decodeInt(sum, true) : decodeInt;
      case "bigint":
        return decodeBigint;
      case "number":
        // A number sum is already decoded by `joinNumberSum`.
        return leaf.widened ? (sum) => sum : decodeNumber;
      case "decimal":
        return (value) => {
          const decoded = decodeDecimalScalar(
            value,
            leaf.decimal!,
            leaf.widened === true,
            internal,
            this.#binding.result
          );
          if (decoded === undefined)
            throw new InvalidScalarResult(
              leaf.type,
              leaf.widened
                ? "the sum is not an exact decimal at this column's scale"
                : "the value is not an exact decimal in this column's declared domain"
            );
          return decoded;
        };
      case "datetime":
        return (value) => {
          if (leaf.dateTime !== undefined && leaf.dateTime !== "text") {
            const decoded = decodePhysicalDateTime(value, leaf.dateTime);
            if (decoded === undefined)
              throw new InvalidScalarResult(
                leaf.type,
                "the value is not this column's declared physical timestamp"
              );
            return decoded;
          }
          if (value instanceof Date) {
            if (isDateTimeInstant(value.getTime()))
              return new Date(value.getTime());
            throw new InvalidScalarResult(
              leaf.type,
              "the Date is outside the public DateTime domain"
            );
          }
          const parsed =
            typeof value === "string"
              ? decodeProviderTimestamp(value)
              : undefined;
          if (!parsed)
            throw new InvalidScalarResult(
              leaf.type,
              "the value is not a valid provider timestamp in the public DateTime domain"
            );
          // A TEXT-stored instant's PHYSICAL value is the spelling itself
          // (`encodePhysicalDateTime(iso, "text")` is the identity), and this
          // column admits more than one spelling of one instant, so an INTERNAL
          // read keeps the bytes the row holds and a public one materializes the
          // `Date` — the same split the decimal arm above takes through
          // `decodeDecimalScalar`. That is what makes a captured identity
          // address its own row: `Queries.scalarValue` binds this string back
          // unchanged, while a `Date` would be re-spelled by the admission
          // boundary and match a row only where the payload's spelling was that
          // one (FC-02B, which repaired N5 §6's residual).
          return internal ? value : parsed;
        };
      case "date":
        return (value) => {
          if (value instanceof Date) {
            const epoch = value.getTime();
            if (
              isDateTimeInstant(epoch) &&
              value.getUTCHours() === 0 &&
              value.getUTCMinutes() === 0 &&
              value.getUTCSeconds() === 0 &&
              value.getUTCMilliseconds() === 0
            )
              return new Date(epoch);
            throw new InvalidScalarResult(
              leaf.type,
              "the Date is invalid or not UTC midnight"
            );
          }
          const match =
            typeof value === "string" ? DATE_TEXT.exec(value) : null;
          const parsed = match
            ? decodeProviderTimestamp(
                `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z${match[4] ? " BC" : ""}`
              )
            : undefined;
          if (!parsed)
            throw new InvalidScalarResult(
              leaf.type,
              "the value is not a valid ISO calendar date"
            );
          return parsed;
        };
      case "time":
        return decodeTime;
      case "enum":
        return (value) => {
          if (
            typeof value === "string" &&
            leaf.enumValues?.includes(value) === true
          )
            return value;
          throw new InvalidScalarResult(
            leaf.type,
            "the value is not a declared enum member"
          );
        };
      case "json":
        return (value) => this.jsonValue(value);
      case "blob":
        return decodeBlob;
      case "vector":
        return (value) => {
          const decoded = providerJson(value);
          if (
            !Array.isArray(decoded) ||
            decoded.some(
              (member) => typeof member !== "number" || !Number.isFinite(member)
            )
          )
            throw new InvalidScalarResult(
              leaf.type,
              "the value is not an array of finite numbers"
            );
          if (leaf.dimension !== undefined && decoded.length !== leaf.dimension)
            throw new InvalidScalarResult(
              leaf.type,
              `the value does not have the configured dimension ${leaf.dimension}`
            );
          return [...decoded];
        };
      case "point":
        return (value) => {
          const decoded = providerJson(value);
          const point = validateGeoPoint(decoded);
          if (point.issues)
            throw new InvalidScalarResult(
              leaf.type,
              point.issues[0]?.message ??
                "the value is not a canonical GeoPoint"
            );
          return point.value;
        };
      default:
        return () => {
          throw new InvalidScalarResult(
            leaf.type,
            "the scalar type is unsupported"
          );
        };
    }
  }
  /**
   * A list leaf's container reader, compiled with its placement by
   * {@link compileReader}: the decimal whole-list codec or one container, then
   * each member through the element's own codec. The member's non-null leaf
   * is derived here, once per list placement of a decoded batch, never per
   * returned list. The reader runs after the NULL and absence checks and the
   * provider continuation, and each member is a carried value.
   */
  protected compileList(leaf: Leaf, internal: boolean): Reader {
    if (leaf.type === "decimal")
      return (value) => {
        const members = decodeDecimalList(
          value,
          leaf.decimal!,
          internal,
          this.#binding.result
        );
        if (members === undefined)
          throw new InvalidScalarResult(
            leaf.type,
            "the value is not an exact decimal list in this column's declared domain"
          );
        return members;
      };
    const member: Leaf = freeze({
      ...leaf,
      list: undefined,
      nullable: false,
    });
    const readMember = this.compileScalar(member, internal);
    const arrayText =
      this.#binding.result.enumListRepresentation === "arrayText";
    return (value) => {
      const items: unknown =
        typeof value !== "string"
          ? value
          : arrayText && value.startsWith("{")
            ? providerArrayMembers(value)
            : JSON.parse(value);
      if (!Array.isArray(items))
        throw new InvalidScalarResult(
          leaf.type,
          "a list scalar did not return an array"
        );
      return items.map((item, index) => {
        if (!Object.hasOwn(items, index))
          throw new InvalidScalarResult(
            leaf.type,
            "a list scalar returned a sparse array"
          );
        return readMember(item);
      });
    };
  }
  /**
   * The JSON value domain, normalized once.
   *
   * A provider's JSON is not JavaScript's: SQLite declares a `json` column
   * with NUMERIC affinity, so the bound text `"42"` comes back as `42n` and a
   * caller who wrote `42` must read `42` — and a non-finite number, a sparse
   * array or an exotic prototype is a malformed provider value rather than
   * something to publish. (The shipped `scalar-structured-parser.ts:144-200`.)
   *
   * A JavaScript value can also contain ITSELF, which provider text never can:
   * a recursive read's node row arrives as an object, not as text this decoder
   * parsed. That is the same fact as every other one here — the value is not
   * in the JSON domain — so this boundary answers it instead of recursing into
   * a `RangeError`. `enclosing` is the containers this value is being
   * normalized INSIDE, entered before a container's members and left after
   * them, so a document that merely REPEATS one object still normalizes it
   * twice and only a container reached from within itself is refused.
   */
  private jsonValue(value: unknown, enclosing?: object[]): unknown {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number") {
      if (Number.isFinite(value)) return value;
      throw new InvalidScalarResult("json", "a JSON number is not finite");
    }
    if (typeof value === "bigint") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
      throw new InvalidScalarResult(
        "json",
        "a JSON integer is outside the finite Number domain"
      );
    }
    if (Array.isArray(value)) {
      const path = this.#enterJsonContainer(value, enclosing);
      const members = new Array<unknown>(value.length);
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index))
          throw new InvalidScalarResult("json", "a JSON array is sparse");
        members[index] = this.jsonValue(value[index], path);
      }
      path.pop();
      return members;
    }
    if (isPlainJsonRecord(value)) {
      const path = this.#enterJsonContainer(value, enclosing);
      const members: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        const member = this.jsonValue(value[key], path);
        // Defined where `Object.prototype` holds the key: assigning
        // `__proto__` would set the prototype, and an inherited property
        // a hardened (frozen) prototype holds would refuse the assignment.
        if (key in Object.prototype)
          Object.defineProperty(members, key, {
            configurable: true,
            enumerable: true,
            value: member,
            writable: true,
          });
        else members[key] = member;
      }
      path.pop();
      return members;
    }
    throw new InvalidScalarResult(
      "json",
      "the value is outside the JSON value domain"
    );
  }
  /**
   * The one entry into a JSON container: the containers already being
   * normalized around it, plus this one. A container that is already open is
   * inside itself, which no JSON document is. The path is a stack, as deep
   * as the document's nesting, so a scan of it is cheaper than a set.
   */
  #enterJsonContainer(
    container: object,
    enclosing: object[] | undefined
  ): object[] {
    const path = enclosing ?? [];
    if (path.includes(container))
      throw new InvalidScalarResult("json", "a JSON value contains itself");
    path.push(container);
    return path;
  }
}

/** A document, not a class instance: the shipped JSON record test. */
function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const INTEGER_TEXT = /^(?:0|-?[1-9]\d*)$/;
const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?: (BC))?$/;
const TIME_TEXT =
  /^(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::?(\d{2}))?)?$/;
const TIME_ZONE_SUFFIX = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
const TRAILING_FRACTION_ZEROS = /\.?0+$/;

function decodeString(value: unknown): unknown {
  if (typeof value === "string") return value;
  throw new InvalidScalarResult("string", "the value is not a string");
}

function decodeBoolean(value: unknown): unknown {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 0n) return false;
  if (value === 1 || value === 1n) return true;
  throw new InvalidScalarResult(
    "boolean",
    "the value is not true, false, zero, or one"
  );
}

/** `sum`: an int `_sum` past 2^53 reads as the nearest double (a lossy sum). */
function decodeInt(value: unknown, sum = false): unknown {
  const parsed =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && INTEGER_TEXT.test(value)
        ? Number(value)
        : value;
  if (typeof parsed !== "number")
    throw new InvalidScalarResult(
      "int",
      "the value is not a canonical integer"
    );
  if (!(sum ? Number.isInteger(parsed) : Number.isSafeInteger(parsed)))
    throw new InvalidScalarResult(
      "int",
      "the integer is outside the safe range"
    );
  return parsed;
}

function decodeBigint(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value))
    return BigInt(value);
  if (typeof value === "string" && INTEGER_TEXT.test(value))
    return BigInt(value);
  throw new InvalidScalarResult(
    "bigint",
    "the value is not a canonical integer"
  );
}

function decodeNumber(value: unknown): number {
  const parsed =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed))
    throw new InvalidScalarResult(
      "number",
      "the value is not a canonical finite number"
    );
  return parsed;
}

/** The divisor `aggregates.numberSum` scales its high part by. */
const NUMBER_SUM_SCALE = 2 ** 64;

/**
 * A number `_sum` from its two `numberSum` parts: `high * 2^64 + low`, which
 * is the summed double, `±Infinity` past the double range. Each part is null
 * when none of its members is present, so both are for an empty window.
 */
function joinNumberSum(value: unknown): number | null {
  const [first, second] = sumParts(value, "number");
  const high = first === null ? null : decodeNumber(first);
  const low = second === null ? null : decodeNumber(second);
  if (high === null) return low;
  return high * NUMBER_SUM_SCALE + (low ?? 0);
}

/** The factor `aggregates.integerSum` splits its high part at. */
const INTEGER_SUM_SCALE = 2n ** 32n;

/**
 * An int64 `_sum` from its two `integerSum` parts, `high * 2^32 + low`, as
 * the integer text the bigint and decimal-coefficient decoders read. Both
 * parts sum the same members, so both are null for an empty window.
 */
function joinIntegerSum(value: unknown, type: string): string | null {
  const [high, low] = sumParts(value, type);
  if (high === null) return null;
  return String(decodeBigint(high) * INTEGER_SUM_SCALE + decodeBigint(low));
}

function sumParts(value: unknown, type: string): [unknown, unknown] {
  if (!Array.isArray(value) || value.length !== 2)
    throw new InvalidScalarResult(type, "the sum is not its two parts");
  return [value[0], value[1]];
}

function decodeTime(value: unknown): string {
  if (typeof value !== "string")
    throw new InvalidScalarResult(
      "time",
      "the value is not a valid provider time"
    );
  const match = TIME_TEXT.exec(value);
  if (
    !(
      match &&
      isDateTimeClock(Number(match[1]), Number(match[2]), Number(match[3]))
    )
  )
    throw new InvalidScalarResult(
      "time",
      "the value is not a valid provider time"
    );
  if (Number(match[4] ?? 0) > 23 || Number(match[5] ?? 0) > 59)
    throw new InvalidScalarResult("time", "the timezone suffix is invalid");
  let time = value.replace(TIME_ZONE_SUFFIX, "");
  if (time.includes(".")) time = time.replace(TRAILING_FRACTION_ZEROS, "");
  const fraction = time.split(".")[1];
  if (fraction && fraction.length > 3)
    throw new InvalidScalarResult(
      "time",
      "the normalized precision exceeds milliseconds"
    );
  return time;
}

/**
 * Every driver's binary spelling, normalized to one fresh Uint8Array by the one
 * binary-shape owner (`validation/primitives/binary-shapes.ts`); the refusal's
 * wording is this boundary's.
 */
function decodeBlob(value: unknown): Uint8Array {
  const { bytes } = normalizeBinaryValue(value);
  if (bytes) return bytes;
  throw new InvalidScalarResult("blob", "the value is not a binary value");
}

/** One dimension of a provider's own array output text: `{a,"b,c",NULL}`. */
function providerArrayMembers(text: string): unknown[] {
  if (!(text.startsWith("{") && text.endsWith("}")))
    throw new InvalidScalarResult(
      "enum",
      "a list scalar did not return an array"
    );
  const body = text.slice(1, -1);
  if (body.length === 0) return [];
  const members: unknown[] = [];
  let index = 0;
  while (index <= body.length) {
    if (body[index] === '"') {
      let member = "";
      index += 1;
      while (index < body.length && body[index] !== '"') {
        member += body[index] === "\\" ? body[++index] : body[index];
        index += 1;
      }
      members.push(member);
      index += 2;
      continue;
    }
    const next = body.indexOf(",", index);
    const end = next === -1 ? body.length : next;
    const member = body.slice(index, end);
    members.push(member === "NULL" ? null : member);
    index = end + 1;
    if (next === -1) break;
  }
  return members;
}
