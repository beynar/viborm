import { GroupByArgs } from "./find-args";
import { AggregateArgs } from "./find-args";
import { CountArgs } from "./find-args";
import { FindFirstArgs } from "./find-args";
import {
  DeleteManyArgs,
  UpdateArgs,
  UpsertArgs,
  CreateManyArgs,
  UpdateManyArgs,
} from "./mutation-args";
import { DeleteArgs } from "./mutation-args";
import { FindManyArgs } from "./find-args";
import { Model } from "../../../schema";
import { FindUniqueArgs } from "./find-args";
import { CreateArgs } from "./mutation-args";
import {
  AggregateResult,
  CountResult,
  FindFirstResult,
  FindManyResult,
  GroupByResult,
} from "../results/find-result";
import { FindUniqueResult } from "../results/find-result";
import {
  DeleteManyResult,
  UpsertResult,
  CreateManyResult,
  UpdateManyResult,
} from "../results/mutation-result";
import { DeleteResult } from "../results/mutation-result";
import { CreateResult, UpdateResult } from "../results";

export type Operation =
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
  | "upsert";

export type OperationPayload<
  O extends Operation,
  M extends Model<any>
> = O extends "findMany"
  ? FindManyArgs<M>
  : O extends "findUnique"
  ? FindUniqueArgs<M>
  : O extends "findFirst"
  ? FindFirstArgs<M>
  : O extends "create"
  ? CreateArgs<M>
  : O extends "update"
  ? UpdateArgs<M>
  : O extends "delete"
  ? DeleteArgs<M>
  : O extends "deleteMany"
  ? DeleteManyArgs<M>
  : O extends "upsert"
  ? UpsertArgs<M>
  : O extends "findUniqueOrThrow"
  ? FindUniqueArgs<M>
  : O extends "findFirstOrThrow"
  ? FindFirstArgs<M>
  : O extends "count"
  ? CountArgs<M>
  : O extends "aggregate"
  ? AggregateArgs<M>
  : O extends "groupBy"
  ? GroupByArgs<M>
  : O extends "createMany"
  ? CreateManyArgs<M>
  : O extends "updateMany"
  ? UpdateManyArgs<M>
  : never;

export type OperationResult<
  O extends Operation,
  M extends Model<any>,
  I
> = O extends "findMany"
  ? I extends FindManyArgs<M>
    ? FindManyResult<M, I>
    : never
  : O extends "findUnique"
  ? I extends FindUniqueArgs<M>
    ? FindUniqueResult<M, I>
    : never
  : O extends "findFirst"
  ? I extends FindFirstArgs<M>
    ? FindFirstResult<M, I>
    : never
  : O extends "create"
  ? I extends CreateArgs<M>
    ? CreateResult<M, I>
    : never
  : O extends "update"
  ? I extends UpdateArgs<M>
    ? UpdateResult<M, I>
    : never
  : O extends "delete"
  ? I extends DeleteArgs<M>
    ? DeleteResult<M, I>
    : never
  : O extends "deleteMany"
  ? I extends DeleteManyArgs<M>
    ? DeleteManyResult<M, I>
    : never
  : O extends "upsert"
  ? I extends UpsertArgs<M>
    ? UpsertResult<M, I>
    : never
  : O extends "findUniqueOrThrow"
  ? I extends FindUniqueArgs<M>
    ? FindUniqueResult<M, I>
    : never
  : O extends "findFirstOrThrow"
  ? I extends FindFirstArgs<M>
    ? FindFirstResult<M, I>
    : never
  : O extends "count"
  ? I extends CountArgs<M>
    ? CountResult<M, I>
    : never
  : O extends "aggregate"
  ? I extends AggregateArgs<M>
    ? AggregateResult<M, I>
    : never
  : O extends "groupBy"
  ? I extends GroupByArgs<M>
    ? GroupByResult<M, I>
    : never
  : O extends "createMany"
  ? I extends CreateManyArgs<M>
    ? CreateManyResult<M, I>
    : never
  : O extends "updateMany"
  ? I extends UpdateManyArgs<M>
    ? UpdateManyResult<M, I>
    : never
  : never;
