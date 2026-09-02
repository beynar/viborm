// biome-ignore-all lint/style/useFilenamingConvention: File matches its primary class export.
import type { DatabaseAdapter } from "@adapters";
import type { AnyDriver } from "@drivers";
import { isVibORMError } from "@errors";
import type { Model } from "@schema/model";
import {
  type AnyRelation,
  type PolymorphicStorageColumn,
  slotMayBeEmpty,
} from "@schema/relation";
import type { Scalar } from "@schema/scalars";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import { numericDateTimeForm } from "@validation/primitives/datetime-physical-codec";
import { toDecimal } from "@validation/primitives/decimal-codec";
import { isString } from "@validation/value-guards";
import { dateTimeNativeTypeOf } from "../builders/datetime-field";
import {
  type ExpectedPolymorphicResultShape,
  type ExpectedResultShape,
  isBatchOperation,
  type Operation,
  type ScopeSource,
} from "../types";
import {
  decimalColumnFor,
  decodeDecimalValue,
  materializeDecimalValue,
} from "./decimal-result-decode";
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
  parseResultDefault,
  type RowKeyCapture,
} from "./result-row-parser";
import { buildExpectedResultShape } from "./result-shape";
import {
  parseFieldValueDefault,
  parseWidenedSumDefault,
} from "./scalar-result-parser";

type FieldParser = (
  value: unknown,
  operation: Operation,
  captureRowKey?: (value: unknown) => void,
  materializePublic?: boolean
) => unknown;
type RelationParser = (
  value: unknown,
  operation: Operation,
  shape: ExpectedResultShape
) => unknown;
type PolymorphicParser = (
  ownerModel: Model<any>,
  relationName: string,
  value: unknown,
  operation: Operation,
  shape: ExpectedPolymorphicResultShape
) => unknown;
type ResultParserChain = (
  value: unknown,
  operation: Operation,
  shape?: ExpectedResultShape
) => unknown;
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
   * `buildExpectedResultShape` creates each nested shape for one projection of
   * one model in one operation. Shape identity therefore owns the compiled row
   * program; a second model/operation bucket would only recheck its provenance.
   */
  private readonly nestedRowParsers = new WeakMap<
    ExpectedResultShape,
    CompiledRowParser
  >();
  private resultChain: ResultParserChain | undefined;
  private captureResultChain: ResultParserChain | undefined;

  /**
   * The widened-SUM chains, kept apart from {@link fieldChains} because a
   * decimal sum is decoded in a different domain from the column it sums —
   * scale-preserving, precision-widened. One classification
   * ({@link classifyAggregateLeaf}) decides which of the two a leaf takes. The
   * cache itself does not exist until a widened SUM is parsed.
   */
  private widenedSumChains: WeakMap<Scalar, FieldParser> | undefined;

  /** The one resolved topology index this parse boundary reads emptiness from. */
  readonly relations: ResolvedRelationIndex;

  constructor(source: ScopeSource, model: Model<any>, driver?: AnyDriver) {
    this.adapter = source.adapter;
    this.relations = source.relations;
    this.model = model;
    this.driver = driver;
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
   * Parse one root row set once, retaining the named fields in the private
   * representation that ADDRESSES SQL beside the public rows.
   *
   * The two are not the same value for every scalar. A decimal's public leaf is
   * a fresh `Decimal`, an object whose equality, ordering and text are all
   * application-observable; its identity is the codec's canonical private
   * string. A caller that indexed rows by the public value would compare two
   * equal decimals with `Object.is` and never match them, and would re-spell
   * them into a later statement through a rendering an application's
   * `Decimal.set(...)` can move. So this parses ONCE and keeps both.
   */
  parseRowsWithRowKeys<T>(
    operation: Operation,
    raw: unknown,
    args: Record<string, unknown>,
    fields: readonly string[],
    expectedShape?: ExpectedResultShape
  ): readonly [T, readonly Readonly<Record<string, unknown>>[]] {
    const rows: Record<string, unknown>[] = [];
    const rowKeys: RowKeyCapture = {
      fields: new Set(fields),
      rows,
    };
    const parsed = this.parseWithChain<T>(
      operation,
      raw,
      args,
      expectedShape,
      this.createResultChain(rowKeys)
    );
    return [parsed, rows];
  }

  /**
   * Parse one planning row set directly into its private scalar representation.
   *
   * This uses the ordinary result and compiled-row boundaries, including driver
   * and adapter middleware and complete shape validation. Only the last field
   * step differs: exact decimals stop at canonical text instead of constructing
   * a public `Decimal` that the planning consumer would immediately discard.
   */
  parseCapturedRows(
    operation: Operation,
    raw: unknown,
    args: Record<string, unknown>,
    expectedShape?: ExpectedResultShape
  ): readonly Record<string, unknown>[] {
    return this.parseWithChain<readonly Record<string, unknown>[]>(
      operation,
      raw,
      args,
      expectedShape,
      this.getCaptureResultChain()
    );
  }

  /**
   * Project one captured provider row set and decode every value that will
   * re-enter SQL into its private scalar representation.
   *
   * Planning probes can expose private relation-storage columns beside public
   * model fields. The ordinary result shape does not know those private names,
   * so the projection must remove them before the compiled public row parser
   * runs. That projection still belongs inside this boundary: every raw row and
   * every required source property is validated across the complete set before
   * any value is read, and hostile property inspection is translated into the
   * same malformed-result error model as the rest of this parser.
   */
  parseCapturedProjection(
    operation: Operation,
    raw: unknown,
    args: Record<string, unknown>,
    fieldSources: Readonly<Record<string, string>>,
    internalColumns: readonly PolymorphicStorageColumn[] = []
  ): readonly Record<string, unknown>[] {
    let selectedRows: Record<string, unknown>[];
    let internalRows: Record<string, unknown>[];
    try {
      if (!Array.isArray(raw)) {
        return malformedResult(
          this,
          operation,
          "a captured result must return a row array"
        );
      }

      const requiredFields = [
        ...new Set([
          ...Object.values(fieldSources),
          ...internalColumns.map((column) => column.name),
        ]),
      ];
      const rows: Record<string, unknown>[] = [];
      for (const candidate of raw) {
        if (!isResultRow(candidate)) {
          return malformedResult(
            this,
            operation,
            "every returned row must be a non-null object"
          );
        }
        rows.push(candidate);
      }
      const sourceRows: Record<string, unknown>[] = [];
      for (const row of rows) {
        const sourceRow: Record<string, unknown> = {};
        for (const field of requiredFields) {
          const descriptor = Object.getOwnPropertyDescriptor(row, field);
          if (!descriptor?.enumerable) {
            return malformedResult(
              this,
              operation,
              "a returned row does not match the requested result columns"
            );
          }
          if (!("value" in descriptor)) {
            return malformedResult(
              this,
              operation,
              "a captured result column must be a data property"
            );
          }
          sourceRow[field] = descriptor.value;
        }
        sourceRows.push(sourceRow);
      }

      selectedRows = [];
      internalRows = [];
      for (const sourceRow of sourceRows) {
        const selected: Record<string, unknown> = {};
        for (const [field, source] of Object.entries(fieldSources)) {
          selected[field] = sourceRow[source];
        }
        selectedRows.push(selected);

        const internal: Record<string, unknown> = {};
        for (const column of internalColumns) {
          internal[column.name] = sourceRow[column.name];
        }
        internalRows.push(internal);
      }
    } catch (error) {
      if (isVibORMError(error)) throw error;
      return malformedResult(
        this,
        operation,
        "captured provider row inspection failed"
      );
    }

    const capturedRows = this.parseCapturedRows(operation, selectedRows, args);
    return capturedRows.map((row, index) => {
      const rawInternal = internalRows[index];
      if (!rawInternal) {
        return malformedResult(
          this,
          operation,
          "a captured result lost its private-column row"
        );
      }
      const decodedInternal: Record<string, unknown> = {};
      for (const column of internalColumns) {
        const value = rawInternal[column.name];
        decodedInternal[column.name] =
          value === null && column.nullable
            ? null
            : this.parseCapturedField(column.scalar, value, operation);
      }
      return { ...decodedInternal, ...row };
    });
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

  private getCaptureResultChain(): ResultParserChain {
    this.captureResultChain ??= this.createResultChain(
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );
    return this.captureResultChain;
  }

  private getFieldChain(scalar: Scalar): FieldParser {
    const existing = this.fieldChains.get(scalar);
    if (existing) return existing;
    const chain = this.createFieldChain(scalar, false);
    this.fieldChains.set(scalar, chain);
    return chain;
  }

  /** Decode one explicit scalar and return its private captured representation. */
  parseCapturedField(
    scalar: Scalar,
    value: unknown,
    operation: Operation
  ): unknown {
    return this.getFieldChain(scalar)(value, operation, undefined, false);
  }

  private getWidenedSumChain(scalar: Scalar): FieldParser {
    const chains = (this.widenedSumChains ??= new WeakMap());
    const existing = chains.get(scalar);
    if (existing) return existing;
    const chain = this.createFieldChain(scalar, true);
    chains.set(scalar, chain);
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
    shape: ExpectedResultShape,
    parsers: RowValueParsers
  ): CompiledRowParser {
    const cached = this.nestedRowParsers.get(shape);
    if (cached) return cached;

    const keys = Object.keys(row);
    const parse = createRowParser(this, operation, keys, model, shape, parsers);
    this.nestedRowParsers.set(shape, parse);
    return parse;
  }

  private createRowValueParsers(captureOnly = false): RowValueParsers {
    const parsers: RowValueParsers = {
      getRowParser: (model, row, operation, shape) =>
        this.getNestedRowParser(model, row, operation, shape, parsers),
      parseField: captureOnly
        ? (scalar, value, operation) =>
            this.getFieldChain(scalar)(value, operation, undefined, false)
        : (scalar, value, operation, captureRowKey) =>
            this.getFieldChain(scalar)(value, operation, captureRowKey),
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
          parsers.parseField,
          (scalar, value, aggregateOperation) =>
            this.getWidenedSumChain(scalar)(
              value,
              aggregateOperation,
              undefined,
              !captureOnly
            )
        ),
    };
    return parsers;
  }

  private createResultChain(
    rowKeys?: RowKeyCapture,
    consumableRows?: unknown[],
    compiledRoot?: CompiledRowParser,
    compiledOperation?: Operation,
    captureOnly = false
  ): ResultParserChain {
    let parsers = compiledRoot
      ? undefined
      : this.createRowValueParsers(captureOnly);
    const defaultParse: ResultParserChain = compiledRoot
      ? (value, operation, shape) => {
          const activeCompiled =
            operation === compiledOperation ? compiledRoot : undefined;
          if (!activeCompiled) {
            parsers ??= this.createRowValueParsers(captureOnly);
          }
          return parseResultDefault(
            this,
            operation,
            value,
            shape,
            parsers,
            rowKeys,
            activeCompiled && value === consumableRows
              ? consumableRows
              : undefined,
            activeCompiled
          );
        }
      : (value, operation, shape) =>
          parseResultDefault(this, operation, value, shape, parsers, rowKeys);
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
      shape: ExpectedResultShape
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
      shape: ExpectedPolymorphicResultShape
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

  /**
   * Compile one field's decode.
   *
   * `widenedSum` selects the OTHER decimal domain: a sum keeps the column's
   * scale but outgrows its precision, so it is decoded against the scale alone.
   * Every other leaf — including `_avg`, `_min` and `_max`, which the database
   * already answered inside the field's domain — takes the field decode.
   */
  private createFieldChain(scalar: Scalar, widenedSum: boolean): FieldParser {
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
    const decimalColumn =
      widenedSum || scalarType === "decimal"
        ? decimalColumnFor(scalar, this.adapter)
        : undefined;
    // The one seam for a datetime column whose physical value is a NUMBER,
    // asked of the ADAPTER because the storage form is a dialect fact — and
    // asked once per compiled chain, never per row. A TEXT-declared field and
    // one on a dialect with a real temporal type both answer `undefined` and
    // keep the provider-timestamp path unchanged.
    const dateTimeForm = numericDateTimeForm(
      this.adapter.result.dateTimeRepresentation?.(dateTimeNativeTypeOf(scalar))
    );
    const parseDecimalScalar: FieldParser | undefined =
      !widenedSum &&
      scalarType === "decimal" &&
      !isList &&
      decimalColumn !== undefined
        ? (value, operation, captureRowKey, materializePublic = true) => {
            if (value === undefined) {
              return malformedScalarValue(
                provider,
                operation,
                scalarType,
                "the value is absent"
              );
            }
            if (value === null) {
              if (!isNullable) {
                return malformedScalarValue(
                  provider,
                  operation,
                  scalarType,
                  "a required scalar is null"
                );
              }
              captureRowKey?.(null);
              return null;
            }
            if (materializePublic && captureRowKey === undefined) {
              const materialized = materializeDecimalValue(
                value,
                decimalColumn
              );
              if (materialized !== undefined) return materialized;
            } else {
              const canonical = decodeDecimalValue(value, decimalColumn);
              if (canonical !== undefined) {
                captureRowKey?.(canonical);
                return materializePublic ? toDecimal(canonical) : canonical;
              }
            }
            return malformedScalarValue(
              provider,
              operation,
              scalarType,
              "the value is not an exact decimal in this column's declared domain"
            );
          }
        : undefined;

    // This existing proof means every scalar crosses the adapter unchanged and
    // no driver field middleware exists. Compile the ordinary decimal directly
    // to its descriptor-aware codec instead of paying two passthrough
    // continuations and the generic scalar switch for every returned cell.
    if (parseDecimalScalar && this.nativeScalarPassthrough) {
      return parseDecimalScalar;
    }

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

    if (!widenedSum && scalarType !== "decimal") {
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
          operation,
          undefined,
          dateTimeForm,
          this.adapter.result.enumListRepresentation === "arrayText"
        );
      return (value, operation, captureRowKey) => {
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
          captureRowKey?.(parsed);
          return parsed;
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
        captureRowKey?.(parsed);
        return parsed;
      };
    }

    if (parseDecimalScalar) {
      return (value, operation, captureRowKey, materializePublic) => {
        if (value === undefined || value === null) {
          return parseDecimalScalar(
            value,
            operation,
            captureRowKey,
            materializePublic
          );
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
        return parseDecimalScalar(
          transformed,
          operation,
          captureRowKey,
          materializePublic
        );
      };
    }

    const defaultParse: (
      value: unknown,
      operation: Operation,
      materializeDecimal?: boolean
    ) => unknown = widenedSum
      ? (value: unknown, operation: Operation, materializeDecimal = false) =>
          parseWidenedSumDefault(
            value,
            decimalColumn,
            scalarType,
            provider,
            operation,
            materializeDecimal
          )
      : (value: unknown, operation: Operation) =>
          parseFieldValueDefault(
            value,
            scalarType,
            isList,
            isNullable,
            enumValues,
            vectorDimension,
            jsonSchema,
            provider,
            operation,
            decimalColumn
          );

    // An uncaptured scalar asks the codec to validate and construct its one
    // public Decimal directly. Capture, list, and private-result paths retain
    // canonical text and materialize only after the row container is chosen.
    //
    // The order below is the whole boundary rule: the row-key capture takes the
    // canonical private string, the caller takes the Decimal. A capture of the
    // public value would put an object whose equality is reference identity
    // into the write engine's row index.
    return (value, operation, captureRowKey, materializePublic = true) => {
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
        captureRowKey?.(parsed);
        return materializePublic ? buildDecimalValue(parsed) : parsed;
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
      if (materializePublic && captureRowKey === undefined && !isList) {
        return defaultParse(transformed, operation, true);
      }
      const parsed = defaultParse(transformed, operation);
      captureRowKey?.(parsed);
      return materializePublic ? buildDecimalValue(parsed) : parsed;
    };
  }
}

/**
 * Construct the public Decimal family of one decoded decimal leaf.
 *
 * The decode answers with canonical text, `null` for a nullable column, or an
 * array of canonical members for a list — nothing else survives it — so the
 * recursion has exactly those three arms.
 */
function buildDecimalValue(parsed: unknown): unknown {
  if (isString(parsed)) return toDecimal(parsed);
  if (Array.isArray(parsed)) return parsed.map(buildDecimalValue);
  return parsed;
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
