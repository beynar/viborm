import { Field } from "@schema/fields";
import { Model, ExtractFields, ModelState } from "@schema/model";
import type {
  InferResult,
  BatchPayload,
  CountResultType,
  AggregateResultType,
  GroupByResultType,
  FieldRecord,
  Simplify,
} from "@schema/model/types";
import { InferOutput } from "../validation";
import { AnyRelation } from "@schema/relation";

export type Schema = Record<string, Model<any>>;

export type Operations =
  | "findFirst"
  | "findMany"
  | "findUnique"
  | "create"
  | "createMany"
  | "update"
  | "updateMany"
  | "delete"
  | "deleteMany"
  | "findUniqueOrThrow"
  | "findFirstOrThrow"
  | "count"
  | "aggregate"
  | "groupBy"
  | "upsert"
  | "exist";

/**
 * Operation payload type - passes Model directly to args types
 * Each args type extracts what it needs internally
 */
export type OperationPayload<
  O extends Operations,
  M extends Model<any>
> = O extends "findMany"
  ? M["~"]["schemas"]["args"]["findMany"][" vibInferred"]["0"]
  : O extends "findUnique"
  ? M["~"]["schemas"]["args"]["findUnique"][" vibInferred"]["0"]
  : O extends "findFirst"
  ? M["~"]["schemas"]["args"]["findFirst"][" vibInferred"]["0"]
  : O extends "create"
  ? M["~"]["schemas"]["args"]["create"][" vibInferred"]["0"]
  : O extends "update"
  ? M["~"]["schemas"]["args"]["update"][" vibInferred"]["0"]
  : O extends "delete"
  ? M["~"]["schemas"]["args"]["delete"][" vibInferred"]["0"]
  : O extends "deleteMany"
  ? M["~"]["schemas"]["args"]["deleteMany"][" vibInferred"]["0"]
  : O extends "upsert"
  ? M["~"]["schemas"]["args"]["upsert"][" vibInferred"]["0"]
  : O extends "findUniqueOrThrow"
  ? M["~"]["schemas"]["args"]["findUnique"][" vibInferred"]["0"]
  : O extends "findFirstOrThrow"
  ? M["~"]["schemas"]["args"]["findFirst"][" vibInferred"]["0"]
  : O extends "count"
  ? M["~"]["schemas"]["args"]["count"][" vibInferred"]["0"]
  : O extends "aggregate"
  ? M["~"]["schemas"]["args"]["aggregate"][" vibInferred"]["0"]
  : O extends "groupBy"
  ? M["~"]["schemas"]["args"]["groupBy"][" vibInferred"]["0"]
  : O extends "createMany"
  ? M["~"]["schemas"]["args"]["createMany"][" vibInferred"]["0"]
  : O extends "updateMany"
  ? M["~"]["schemas"]["args"]["updateMany"][" vibInferred"]["0"]
  : O extends "exist"
  ? M["~"]["schemas"]["where"][" vibInferred"]["0"]
  : never;

/**
 * Operation result type - infers result shape based on select/include args
 * This provides full type safety for ORM operation results
 */
export type OperationResult<
  O extends Operations,
  M extends Model<any>,
  Args
> = M extends Model<infer S>
  ? O extends "findFirst" | "findUnique"
    ? InferResult2<
        S,
        Args extends { select: infer Selection extends Record<any, any> }
          ? Selection
          : undefined
      > | null
    : O extends "findFirstOrThrow" | "findUniqueOrThrow"
    ? InferResult<ExtractFields<M>, Args>
    : O extends "findMany"
    ? InferResult<ExtractFields<M>, Args>[]
    : O extends "create" | "update" | "delete" | "upsert"
    ? InferResult<ExtractFields<M>, Args>
    : O extends "createMany" | "updateMany" | "deleteMany"
    ? BatchPayload
    : O extends "count"
    ? CountResultType<Args>
    : O extends "exist"
    ? boolean
    : O extends "aggregate"
    ? AggregateResultType<ExtractFields<M>, Args>
    : O extends "groupBy"
    ? GroupByResultType<ExtractFields<M>, Args>[]
    : never
  : never;

/**
 * Client type - provides fully typed access to all model operations
 * Each operation returns a Promise with the properly inferred result type
 */
export type Client<S extends Schema> = {
  [K in keyof S]: {
    [O in Operations]: <P extends OperationPayload<O, S[K]>>(
      args: P
    ) => Promise<OperationResult<O, S[K], P>>;
  };
};

type InferResult2<
  S extends ModelState,
  Selection extends Record<any, any> | undefined
> = Simplify<{
  [K in keyof Selection]: K extends keyof S["fields"]
    ? Selection[K] extends true
      ? S["fields"][K] extends Field
        ? S["fields"][K]["~"]["schemas"]["base"][" vibInferred"]["1"]
        : S["fields"][K] extends AnyRelation
        ? InferRelationOutput<S["fields"][K]>
        : never
      : Selection[K] extends object
      ? S["fields"][K] extends AnyRelation
        ? Selection[K] extends {
            select: infer Selection2 extends Record<any, any>;
          }
          ? InferResult2<GetTargetModelState<S["fields"][K]>, Selection2>
          : InferRelationOutput<S["fields"][K]>
        : never
      : never
    : never;
}>;

type GetTargetModelState<R extends AnyRelation> =
  R["~"]["state"]["getter"] extends () => infer T
    ? T extends Model<infer S>
      ? S extends ModelState
        ? S
        : never
      : never
    : never;

type InferRelationOutput<R extends AnyRelation> = InferModelOutput<
  GetTargetModelState<R>
>;

type InferModelOutput<S extends ModelState> = Simplify<{
  [K in Exclude<
    keyof S["scalars"],
    S["omit"][number]
  >]: S["scalars"][K]["~"]["schemas"]["base"][" vibInferred"]["1"];
}>;
