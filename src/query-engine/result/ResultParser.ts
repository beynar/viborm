// biome-ignore-all lint/style/useFilenamingConvention: File matches its primary class export.
import type { DatabaseAdapter } from "@adapters";
import type { RelationResultKind } from "@adapters/adapter-result-parser";
import type { AnyDriver } from "@drivers";
import { isVibORMError } from "@errors";
import type { Model } from "@schema/model";
import type { AnyPolymorphicRelation, AnyRelation } from "@schema/relation";
import type { Scalar } from "@schema/scalars";
import {
  type ExpectedPolymorphicResultShape,
  type ExpectedResultShape,
  isBatchOperation,
  type Operation,
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
type RowParser = ReturnType<typeof createRowParser>;

interface CachedRowParser {
  readonly model: Model<any>;
  readonly operation: Operation;
  readonly parse: RowParser;
}

/** Owns provider middleware and identity caches for one result boundary. */
export class ResultParser {
  readonly adapter: DatabaseAdapter;
  readonly model: Model<any>;
  readonly driver: AnyDriver | undefined;
  private readonly fieldChains = new WeakMap<Scalar, FieldParser>();
  private readonly relationChains = new WeakMap<AnyRelation, RelationParser>();
  private readonly polymorphicChains = new WeakMap<
    AnyPolymorphicRelation,
    PolymorphicParser
  >();
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

  constructor(
    adapter: DatabaseAdapter,
    model: Model<any>,
    driver?: AnyDriver,
    decimalDecode: "string" | "number" = "string"
  ) {
    this.adapter = adapter;
    this.model = model;
    this.driver = driver;
    this.decimalDecode = decimalDecode;
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
      expectedShape ?? buildExpectedResultShape(this.model, operation, args);
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
    relation: AnyRelation,
    parsers: RowValueParsers
  ): RelationParser {
    const existing = this.relationChains.get(relation);
    if (existing) return existing;
    const chain = this.createRelationChain(relation, parsers);
    this.relationChains.set(relation, chain);
    return chain;
  }

  private getPolymorphicChain(
    relation: AnyPolymorphicRelation,
    parsers: RowValueParsers
  ): PolymorphicParser {
    const existing = this.polymorphicChains.get(relation);
    if (existing) return existing;
    const chain = this.createPolymorphicChain(relation, parsers);
    this.polymorphicChains.set(relation, chain);
    return chain;
  }

  private getNestedRowParser(
    model: Model<any>,
    row: Record<string, unknown>,
    operation: Operation,
    shape: ExpectedResultShape | undefined,
    parsers: RowValueParsers,
    knownKeys?: readonly string[]
  ): RowParser {
    if (!shape) {
      const keys = knownKeys ?? Object.keys(row);
      return createRowParser(this, operation, keys, model, shape, parsers);
    }

    const cached = this.nestedRowParsers.get(shape);
    if (cached) {
      for (const rowParser of cached) {
        if (rowParser.model === model && rowParser.operation === operation) {
          return rowParser.parse;
        }
      }
    }

    const keys = knownKeys ?? Object.keys(row);
    const parse = createRowParser(this, operation, keys, model, shape, parsers);
    const rowParser: CachedRowParser = { model, operation, parse };
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
      parseRelation: (relation, value, operation, shape) =>
        this.getRelationChain(relation, parsers)(value, operation, shape),
      parsePolymorphic: (
        model,
        relationName,
        relation,
        value,
        operation,
        shape
      ) =>
        this.getPolymorphicChain(relation, parsers)(
          model,
          relationName,
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
    exactFields?: ExactFieldCapture
  ): ResultParserChain {
    const parsers = this.createRowValueParsers();
    const defaultParse = (
      value: unknown,
      operation: Operation,
      shape?: ExpectedResultShape
    ) =>
      parseResultDefault(this, operation, value, shape, parsers, exactFields);
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
    parsers: RowValueParsers
  ): RelationParser {
    const relationType = relation["~"].state.type;
    const adapterParse = (
      value: unknown,
      type: RelationResultKind,
      operation: Operation,
      shape?: ExpectedResultShape
    ) =>
      this.adapter.result.parseRelation(value, type, (transformed) =>
        parseRelationValueDefault(
          this,
          relation,
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
        return adapterParse(value, relationType, operation, shape);
      };
    }
    return (value, operation, shape) => {
      requireValue(value, operation);
      return driverParseRelation(value, relationType, (transformed) =>
        adapterParse(transformed ?? value, relationType, operation, shape)
      );
    };
  }

  private createPolymorphicChain(
    relation: AnyPolymorphicRelation,
    parsers: RowValueParsers
  ): PolymorphicParser {
    const adapterParse = (
      ownerModel: Model<any>,
      relationName: string,
      value: unknown,
      operation: Operation,
      shape?: ExpectedPolymorphicResultShape
    ) =>
      this.adapter.result.parseRelation(value, "polymorphic", (transformed) =>
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
      driverParseRelation(value, "polymorphic", (transformed) =>
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
    const adapterDecode = (value: unknown, type: string) =>
      this.adapter.result.parseField(value, type, (transformed) =>
        transformed === undefined ? value : transformed
      );
    const driverParseField = this.driver?.result?.parseField;
    const middlewareDecode = driverParseField
      ? (value: unknown) =>
          driverParseField(value, scalarType, (transformed, transformedType) =>
            adapterDecode(transformed, transformedType)
          )
      : (value: unknown) => adapterDecode(value, scalarType);

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
        transformed = middlewareDecode(value);
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

export { parseMutationCount } from "./result-count-parser";
