import { Field, s, ScalarFieldType } from "@schema";
import { filterValidators } from "./filter-validators";
import { array, lazy, nullable, ZodMiniType } from "zod/v4-mini";
import {
  wrapArray,
  wrapAutoGenerate,
  wrapDefault,
  wrapNullable,
  wrapOptional,
  Zod,
} from "./utils";
import { IsFieldArray, IsFieldNullable, IsFieldOptional } from "@types";

type WrapNullable<F extends Field, T> = IsFieldNullable<F> extends true
  ? T | null
  : T;

type WrapArray<F extends Field, T> = IsFieldArray<F> extends true ? T[] : T;

type WrapOptional<F extends Field, T> = IsFieldOptional<F> extends true
  ? T | undefined
  : T;

type CreateValidator<F extends Field> = WrapOptional<
  F,
  WrapNullable<F, WrapArray<F, F["~baseValidator"]["_zod"]["input"]>>
>;

export const getCreateValidator = <F extends Field>(field: F) => {
  const baseValidator = field["~baseValidator"];
  return lazy(() =>
    wrapOptional(
      wrapNullable(
        wrapArray(
          wrapDefault(wrapAutoGenerate(baseValidator, field), field),
          field
        ),
        field
      ),
      field
    )
  ) as ZodMiniType<CreateValidator<F>, CreateValidator<F>>;
};
