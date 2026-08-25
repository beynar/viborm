// biome-ignore-all lint/style/useFilenamingConvention: File matches its primary class export.
import type { DatabaseAdapter } from "@adapters";
import type { AnyDriver } from "@drivers";
import { isVibORMError } from "@errors";
import type { Model } from "@schema/model";
import { type AnyRelation, slotMayBeEmpty } from "@schema/relation";
import type { Scalar } from "@schema/scalars";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import {
  type ExpectedPolymorphicResultShape,
  type ExpectedResultShape,
  isBatchOperation,
  type Operation,
  type ScopeSource,
} from "../types";
import { parsePolymorphicValueDefault } from "./polymorphic-result-parser";
import { parseRelationValueDefault } from "./relation-result-parser";
import { parseAggregateResult } from "./result-aggregate-parser";
import {
  isResultRow,
  malformedResult,
  malformedScalarValue,
  type RowValueParsers,
} from "./result-parser-contract";
import {
  type CompiledRowParser,
  createRowParser,
  type ExactFieldCapture,
  parseResultDefault,
} from "./result-row-parser";
import { buildExpectedResultShape } from "./result-shape";
import { parseFieldValueDefault } from "./scalar-result-parser";

type FieldParser = (
  value: unknown,
  operation: Operation,
  captureExact?: (value: unknown) => void
) => unknown;
type RelationParser = (
  value: unknown,
  operation: Operation,
  shape?: ExpectedResultShape
) => unknown;
type PolymorphicParser = (
  ownerModel: Model<any>,
  relationName: string,
  value: unknown,
  operation: Operation,
  shape?: ExpectedPolymorphicResultShape
) => unknown;
type ResultParserChain = (
  value: unknown,
  operation: Operation,
  shape?: ExpectedResultShape
) => unknown;
interface CachedRowParser {
  readonly model: Model<any>;
  readonly operation: Operation;
  readonly parser: CompiledRowParser;
}

type PrepareResultRowsFriend = (
  parser: ResultParser,
  operation: Operation,
  shape: ExpectedResultShape
) => CompiledRowParser | undefined;

type ParsePreparedResultFriend = <T>(
  parser: ResultParser,
  operation: Operation,
  raw: unknown,
  args: Record<string, unknown>,
  shape: ExpectedResultShape,
  compiled: CompiledRowParser,
  consumableRows?: unknown[]
) => T;

let prepareResultRowsFriend: PrepareResultRowsFriend;
let parsePreparedResultFriend: ParsePreparedResultFriend;

/**
 * Look one contextual slot up in a per-source-model chain cache, creating the
 * model's own slot map on first use. Shared by both chain caches so the two
 * cannot key themselves differently.
 */
function cachedSlotChain<Chain>(
  cache: WeakMap<Model<any>, Map<string, Chain>>,
  source: Model<any>,
  field: string
): {
  readonly slots: Map<string, Chain>;
  readonly existing: Chain | undefined;
} {
  let slots = cache.get(source);
  if (!slots) {
    slots = new Map<string, Chain>();
    cache.set(source, slots);
  }
  return { slots, existing: slots.get(field) };
}

/** Owns provider middleware and identity caches for one result boundary. */
export class ResultParser {
  readonly adapter: DatabaseAdapter;
  readonly model: Model<any>;
  readonly driver: AnyDriver | undefined;
  private readonly fieldChains = new WeakMap<Scalar, FieldParser>();
  /**
   * Keyed by the CONTEXTUAL SLOT, `(source model, field)` — never by the
   * relation object alone.
   *
   * `.extends()` reuses one immutable terminal under more than one model, and a
   * parser chain depends on facts of the EDGE (which end stores the membership,
   * whether the slot may be empty, which member a variant carrier selected) —
   * not on the declaration. Keying by the shared instance would hand the second
   * source model the first one's parser.
   */
  private readonly relationChains = new WeakMap<
    Model<any>,
    Map<string, RelationParser>
  >();
  private readonly polymorphicChains = new WeakMap<
    Model<any>,
    Map<string, PolymorphicParser>
  >();
  /**
   * Keyed by the requested SHAPE, then narrowed by `(model, operation)` in the
   * small array below. One compiled callable lazily exposes the consumable
   * invocation only when a parser-owned carrier asks for it.
   *
   * This one is sound as it stands and is deliberately left alone: a shape
   * describes the exact columns ONE compiled read asked for, so it is already a
   * contextual identity, and the linear scan disambiguates the two facts a
   * shape does not carry. The list stays short because shapes are built per
   * compiled operation rather than memoized per model.
   */
  private readonly nestedRowParsers = new WeakMap<
    ExpectedResultShape,
    CachedRowParser[]
  >();
  private resultChain: ResultParserChain | undefined;

  /**
   * TRANSITIONAL. `"number"` re-applies the legacy lossy decode to
   * decimal fields after the exact parse. See {@link QueryEngine.decimalDecode}.
   */
  readonly decimalDecode: "string" | "number";

  /** The one resolved topology index this parse boundary reads emptiness from. */
  readonly relations: ResolvedRelationIndex;

  constructor(
    source: ScopeSource,
    model: Model<any>,
    driver?: AnyDriver,
    decimalDecode: "string" | "number" = "string"
  ) {
    this.adapter = source.adapter;
    this.relations = source.relations;
    this.model = model;
    this.driver = driver;
    this.decimalDecode = decimalDecode;
  }

  static {
    prepareResultRowsFriend = (parser, operation, shape) =>
      shape.carrier === "rows"
        ? createRowParser(
            parser,
            operation,
            shape.rawKeys,
            parser.model,
            shape,
            parser.createRowValueParsers()
          )
        : undefined;
    parsePreparedResultFriend = <T>(
      parser: ResultParser,
      operation: Operation,
      raw: unknown,
      args: Record<string, unknown>,
      shape: ExpectedResultShape,
      compiled: CompiledRowParser,
      consumableRows?: unknown[]
    ): T =>
      parser.parseWithChain<T>(
        operation,
        raw,
        args,
        shape,
        parser.createResultChain(undefined, consumableRows, compiled, operation)
      );
  }

  get providerName(): string {
    return this.driver?.driverName ?? "query-engine";
  }

  /**
   * True when the provider returns native scalar values through a passthrough
   * middleware chain — the adapter declares {@link AdapterResultParser.nativeScalarPassthrough}
   * AND no driver-level field middleware intercepts. Only then is the row
   * parser's identity fast path byte-identical to the full typed parse.
   */
  get nativeScalarPassthrough(): boolean {
    return (
      this.adapter.result.nativeScalarPassthrough === true &&
      !this.driver?.result?.parseField
    );
  }

  parse<T>(
    operation: Operation,
    raw: unknown,
    args: Record<string, unknown>,
    expectedShape?: ExpectedResultShape
  ): T {
    return this.parseWithChain<T>(
      operation,
      raw,
      args,
      expectedShape,
      this.getResultChain()
    );
  }

  /**
   * Parse one root row set once while retaining selected scalar values before
   * the temporary `decimalDecode: "number"` presentation conversion.
   */
  parseRowsWithExactFields<T>(
    operation: Operation,
    raw: unknown,
    args: Record<string, unknown>,
    fields: readonly string[],
    expectedShape?: ExpectedResultShape
  ): readonly [T, readonly Readonly<Record<string, unknown>>[]] {
    const rows: Record<string, unknown>[] = [];
    const exactFields: ExactFieldCapture = {
      fields: new Set(fields),
      rows,
    };
    const parsed = this.parseWithChain<T>(
      operation,
      raw,
      args,
      expectedShape,
      this.createResultChain(exactFields)
    );
    return [parsed, rows];
  }

  private parseWithChain<T>(
    operation: Operation,
    raw: unknown,
    args: Record<string, unknown>,
    expectedShape: ExpectedResultShape | undefined,
    chain: ResultParserChain
  ): T {
    if (raw === null || raw === undefined) {
      return malformedResult(this, operation, "the statement result is absent");
    }
    if (isBatchOperation(operation)) {
      if (!isResultRow(raw)) {
        return malformedResult(
          this,
          operation,
          "a batch mutation must return a result object"
        );
      }
    } else if (!Array.isArray(raw)) {
      return malformedResult(
        this,
        operation,
        "a non-batch operation must return a row array"
      );
    }

    const shape =
      expectedShape ??
      buildExpectedResultShape(this.model, operation, args, this.relations);
    return chain(raw, operation, shape) as T;
  }

  private getResultChain(): ResultParserChain {
    this.resultChain ??= this.createResultChain();
    return this.resultChain;
  }

  private getFieldChain(scalar: Scalar): FieldParser {
    const existing = this.fieldChains.get(scalar);
    if (existing) return existing;
    const chain = this.createFieldChain(scalar);
    this.fieldChains.set(scalar, chain);
    return chain;
  }

  private getRelationChain(
    source: Model<any>,
    field: string,
    relation: AnyRelation,
    parsers: RowValueParsers
  ): RelationParser {
    const chain = cachedSlotChain(this.relationChains, source, field);
    if (chain.existing) return chain.existing;
    // Emptiness is a fact of the RESOLVED EDGE (§8.4), asked once per contextual
    // slot and baked into this slot's chain — the same identity the chain is
    // keyed by, so `.extends()` cannot share one answer across two source models.
    const resolved = this.relations.get(source)?.get(field);
    const created = this.createRelationChain(
      relation,
      resolved !== undefined && slotMayBeEmpty(resolved),
      parsers
    );
    chain.slots.set(field, created);
    return created;
  }

  private getPolymorphicChain(
    source: Model<any>,
    field: string,
    relation: AnyRelation,
    parsers: RowValueParsers
  ): PolymorphicParser {
    const chain = cachedSlotChain(this.polymorphicChains, source, field);
    if (chain.existing) return chain.existing;
    const created = this.createPolymorphicChain(relation, parsers);
    chain.slots.set(field, created);
    return created;
  }

  private getNestedRowParser(
    model: Model<any>,
    row: Record<string, unknown>,
    operation: Operation,
    shape: ExpectedResultShape | undefined,
    parsers: RowValueParsers,
    knownKeys?: readonly string[]
  ): CompiledRowParser {
    if (!shape) {
      const keys = knownKeys ?? Object.keys(row);
      return createRowParser(this, operation, keys, model, shape, parsers);
    }

    const cached = this.nestedRowParsers.get(shape);
    if (cached) {
      for (const rowParser of cached) {
        if (rowParser.model === model && rowParser.operation === operation) {
          return rowParser.parser;
        }
      }
    }

    const keys = knownKeys ?? Object.keys(row);
    const parse = createRowParser(this, operation, keys, model, shape, parsers);
    const rowParser: CachedRowParser = { model, operation, parser: parse };
    if (cached) cached.push(rowParser);
    else this.nestedRowParsers.set(shape, [rowParser]);
    return parse;
  }

  private createRowValueParsers(): RowValueParsers {
    const parsers: RowValueParsers = {
      getRowParser: (model, row, operation, shape, keys) =>
        this.getNestedRowParser(model, row, operation, shape, parsers, keys),
      parseField: (scalar, value, operation, captureExact) =>
        this.getFieldChain(scalar)(value, operation, captureExact),
      parseRelation: (source, field, relation, value, operation, shape) =>
        this.getRelationChain(
          source,
          field,
          relation,
          parsers
        )(value, operation, shape),
      parsePolymorphic: (source, field, relation, value, operation, shape) =>
        this.getPolymorphicChain(source, field, relation, parsers)(
          source,
          field,
          value,
          operation,
          shape
        ),
      parseAggregate: (operation, key, raw, scalars, expected) =>
        parseAggregateResult(
          this,
          operation,
          key,
          raw,
          scalars,
          expected,
          parsers.parseField
        ),
    };
    return parsers;
  }

  private createResultChain(
    exactFields?: ExactFieldCapture,
    consumableRows?: unknown[],
    compiledRoot?: CompiledRowParser,
    compiledOperation?: Operation
  ): ResultParserChain {
    let parsers = compiledRoot ? undefined : this.createRowValueParsers();
    const defaultParse: ResultParserChain = compiledRoot
      ? (value, operation, shape) => {
          const activeCompiled =
            operation === compiledOperation ? compiledRoot : undefined;
          if (!activeCompiled) parsers ??= this.createRowValueParsers();
          return parseResultDefault(
            this,
            operation,
            value,
            shape,
            parsers,
            exactFields,
            activeCompiled && value === consumableRows
              ? consumableRows
              : undefined,
            activeCompiled
          );
        }
      : (value, operation, shape) =>
          parseResultDefault(
            this,
            operation,
            value,
            shape,
            parsers,
            exactFields
          );
    const adapterParse = (
      value: unknown,
      operation: Operation,
      shape?: ExpectedResultShape
    ) =>
      this.adapter.result.parseResult(value, operation, (transformed) =>
        defaultParse(transformed ?? value, operation, shape)
      );

    const driverParseResult = this.driver?.result?.parseResult;
    if (!driverParseResult) return adapterParse;
    return (value, operation, shape) =>
      driverParseResult(value, operation, (transformed, nextOperation) =>
        adapterParse(transformed, nextOperation, shape)
      );
  }

  private createRelationChain(
    relation: AnyRelation,
    mayBeEmpty: boolean,
    parsers: RowValueParsers
  ): RelationParser {
    const adapterParse = (
      value: unknown,
      operation: Operation,
      shape?: ExpectedResultShape
    ) =>
      this.adapter.result.parseRelation(value, (transformed) =>
        parseRelationValueDefault(
          this,
          relation,
          mayBeEmpty,
          transformed ?? value,
          operation,
          shape,
          parsers
        )
      );
    const requireValue = (value: unknown, operation: Operation): void => {
      if (value === undefined) {
        malformedResult(
          this,
          operation,
          "an included relation value is absent"
        );
      }
    };

    const driverParseRelation = this.driver?.result?.parseRelation;
    if (!driverParseRelation) {
      return (value, operation, shape) => {
        requireValue(value, operation);
        return adapterParse(value, operation, shape);
      };
    }
    return (value, operation, shape) => {
      requireValue(value, operation);
      return driverParseRelation(value, (transformed) =>
        adapterParse(transformed ?? value, operation, shape)
      );
    };
  }

  private createPolymorphicChain(
    relation: AnyRelation,
    parsers: RowValueParsers
  ): PolymorphicParser {
    const adapterParse = (
      ownerModel: Model<any>,
      relationName: string,
      value: unknown,
      operation: Operation,
      shape?: ExpectedPolymorphicResultShape
    ) =>
      this.adapter.result.parseRelation(value, (transformed) =>
        parsePolymorphicValueDefault(
          this,
          ownerModel,
          relationName,
          relation,
          transformed ?? value,
          operation,
          shape,
          parsers
        )
      );
    const driverParseRelation = this.driver?.result?.parseRelation;
    if (!driverParseRelation) return adapterParse;
    return (ownerModel, relationName, value, operation, shape) =>
      driverParseRelation(value, (transformed) =>
        adapterParse(
          ownerModel,
          relationName,
          transformed ?? value,
          operation,
          shape
        )
      );
  }

  private createFieldChain(scalar: Scalar): FieldParser {
    const provider = this.providerName;
    const state = scalar["~"].state;
    const scalarType = state.type;
    const isList = state.array === true;
    const isNullable = state.nullable === true;
    const vectorDimension =
      scalarType === "vector" ? state.dimension : undefined;
    const jsonSchema = scalarType === "json" ? state.schema : undefined;
    const enumValues =
      "enumValues" in scalar ? new Set<string>(scalar.enumValues) : undefined;
    const defaultParse = (value: unknown, operation: Operation) =>
      parseFieldValueDefault(
        value,
        scalarType,
        isList,
        isNullable,
        enumValues,
        vectorDimension,
        jsonSchema,
        provider,
        operation
      );
    let adapterInput: unknown;
    const continueAdapter = (transformed?: unknown) =>
      transformed === undefined ? adapterInput : transformed;
    const adapterDecode = (value: unknown, type: string) => {
      const previousInput = adapterInput;
      adapterInput = value;
      try {
        return this.adapter.result.parseField(value, type, continueAdapter);
      } finally {
        // One ResultParser can be entered recursively by synchronous custom
        // middleware. Restore its outer `next()` fallback before returning.
        adapterInput = previousInput;
      }
    };
    const driverParseField = this.driver?.result?.parseField;

    // TRANSITIONAL: the legacy `decimal: "number"` hatch. It runs AFTER
    // the exact parse, so the lossy step is one clearly-marked conversion at the
    // very edge rather than a second decode path threaded through the parser.
    // It is a re-lossification of a value we already have exactly — which is
    // precisely why it is temporary.
    const legacyNumberDecimal =
      scalarType === "decimal" && this.decimalDecode === "number";
    const applyLegacy = (parsed: unknown): unknown => {
      if (!legacyNumberDecimal || parsed === null) return parsed;
      if (isList && Array.isArray(parsed)) return parsed.map(Number);
      return typeof parsed === "string" ? Number(parsed) : parsed;
    };

    return (value, operation, captureExact) => {
      if (value === undefined) {
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "the value is absent"
        );
      }
      if (value === null) {
        const parsed = defaultParse(value, operation);
        captureExact?.(parsed);
        return applyLegacy(parsed);
      }
      let transformed: unknown;
      try {
        transformed = driverParseField
          ? driverParseField(value, scalarType, adapterDecode)
          : adapterDecode(value, scalarType);
      } catch (error) {
        if (isVibORMError(error)) throw error;
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "provider scalar decoding failed"
        );
      }
      const parsed = defaultParse(transformed, operation);
      captureExact?.(parsed);
      return applyLegacy(parsed);
    };
  }
}

/** Advanced result parsing entry backed by one explicit parser owner. */
export function parseResult<T>(
  parser: ResultParser,
  operation: Operation,
  raw: unknown,
  args: Record<string, unknown>,
  expectedShape?: ExpectedResultShape
): T {
  return parser.parse<T>(operation, raw, args, expectedShape);
}

/** Compile the root row program before an eligible direct read executes. */
export function prepareResultRows(
  parser: ResultParser,
  operation: Operation,
  shape: ExpectedResultShape
): CompiledRowParser | undefined {
  return prepareResultRowsFriend(parser, operation, shape);
}

/** Internal executor-only friend; deliberately absent from package exports. */
export function parsePreparedResult<T>(
  parser: ResultParser,
  operation: Operation,
  raw: unknown,
  args: Record<string, unknown>,
  shape: ExpectedResultShape,
  compiled: CompiledRowParser,
  consumableRows?: unknown[]
): T {
  return parsePreparedResultFriend<T>(
    parser,
    operation,
    raw,
    args,
    shape,
    compiled,
    consumableRows
  );
}

export { parseMutationCount } from "./result-count-parser";
