// biome-ignore-all lint/style/useFilenamingConvention: File matches its primary class export.
import type { DatabaseAdapter } from "@adapters";
import type { AnyDriver } from "@drivers";
import { isVibORMError } from "@errors";
import type { Model } from "@schema/model";
import type { AnyRelation } from "@schema/relation";
import type { RelationType } from "@schema/relation/types";
import type { Scalar } from "@schema/scalars";
import {
  type ExpectedResultShape,
  isBatchOperation,
  type Operation,
} from "../types";
import { parseRelationValueDefault } from "./relation-result-parser";
import { parseAggregateResult } from "./result-aggregate-parser";
import {
  isResultRow,
  malformedResult,
  malformedScalarValue,
  type RowValueParsers,
} from "./result-parser-contract";
import { parseResultDefault } from "./result-row-parser";
import { buildExpectedResultShape } from "./result-shape";
import { parseFieldValueDefault } from "./scalar-result-parser";

type FieldParser = (value: unknown, operation: Operation) => unknown;
type RelationParser = (
  value: unknown,
  operation: Operation,
  shape?: ExpectedResultShape
) => unknown;
type ResultParserChain = (
  value: unknown,
  operation: Operation,
  shape?: ExpectedResultShape
) => unknown;

/** Owns provider middleware and identity caches for one result boundary. */
export class ResultParser {
  readonly adapter: DatabaseAdapter;
  readonly model: Model<any>;
  readonly driver: AnyDriver | undefined;
  private readonly fieldChains = new WeakMap<Scalar, FieldParser>();
  private readonly relationChains = new WeakMap<AnyRelation, RelationParser>();
  private resultChain: ResultParserChain | undefined;

  constructor(adapter: DatabaseAdapter, model: Model<any>, driver?: AnyDriver) {
    this.adapter = adapter;
    this.model = model;
    this.driver = driver;
  }

  get providerName(): string {
    return this.driver?.driverName ?? "query-engine";
  }

  parse<T>(
    operation: Operation,
    raw: unknown,
    args: Record<string, unknown>,
    expectedShape?: ExpectedResultShape
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
    return this.getResultChain()(raw, operation, shape) as T;
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

  private createRowValueParsers(): RowValueParsers {
    const parsers: RowValueParsers = {
      parseField: (scalar, value, operation) =>
        this.getFieldChain(scalar)(value, operation),
      parseRelation: (relation, value, operation, shape) =>
        this.getRelationChain(relation, parsers)(value, operation, shape),
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

  private createResultChain(): ResultParserChain {
    const parsers = this.createRowValueParsers();
    const defaultParse = (
      value: unknown,
      operation: Operation,
      shape?: ExpectedResultShape
    ) => parseResultDefault(this, operation, value, shape, parsers);
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
      type: RelationType,
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

    return (value, operation) => {
      if (value === undefined) {
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "the value is absent"
        );
      }
      if (value === null) return defaultParse(value, operation);
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
      return defaultParse(transformed, operation);
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
