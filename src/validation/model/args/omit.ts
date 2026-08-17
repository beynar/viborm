/**
 * `omit` — the inverse of `select`.
 *
 * `omit: { passwordHash: true }` returns every projectable scalar EXCEPT the
 * named ones. It composes with `include` (relations ride alongside the reduced
 * scalar set) and with `select`: `select` names the candidate fields, then
 * `omit` subtracts selected scalars flagged `true`.
 *
 * DESUGARING. `omit` never reaches the query engine. This wrapper rewrites it
 * into the explicit `select` it denotes, immediately after the payload
 * validates, so exactly one projection vocabulary exists downstream — the same
 * trick the relation `include` nodes have always used
 * (`buildSelectionFromState`, `src/validation/relations/select-include.ts`).
 * The engine's default-projection branch is therefore untouched, and so is
 * `include`: the resulting args carry a scalar-only `select` NEXT TO the
 * original `include`, which is the exact shape the V2 write operations already
 * hand the read builder (`defaultSelect` + `parsedInclude` in
 * `CreateOperation` / `DeleteOperation`).
 *
 * EMPTY PROJECTIONS FAIL CLOSED. An `omit` that removes every default scalar,
 * or every truthy field of an explicit `select`, denotes `select: {}`. Answering
 * it with the default projection would return fields the caller asked to hide,
 * so it is refused here at the parse boundary.
 */

import type { AnyModel } from "@schema/model";
import type {
  ObjectOptions,
  ObjectSchema,
} from "@validation/primitives/object";
import { isRecord } from "@validation/value-guards";
import v, { type V } from "../../primitives/v";
import type { CoreSchemas } from "../core";
import {
  type ProjectableScalarKeys,
  projectableScalarNames,
} from "../core/projection";
import type { ScalarSchemas } from "../index";

const omitFlagSchema = v.boolean({ optional: true });

/**
 * Keyed on {@link ProjectableScalarKeys}: a model-level `.omit()`-ed scalar has
 * no entry, so `omit: { passwordHash: false }` cannot re-include it (it is an
 * "Unknown key" failure). Client-level `omit` is a default and IS overridable —
 * but it is merged into this same value before validation runs, so `false` here
 * always means "keep it", never "re-open the schema".
 */
export type OmitSchema<M extends AnyModel> = V.Object<
  V.FromKeys<ProjectableScalarKeys<M>[], typeof omitFlagSchema>["entries"],
  { optional: true }
>;

export const getOmitSchema = <M extends AnyModel>(model: M): OmitSchema<M> =>
  v.object(
    v.fromKeys<ProjectableScalarKeys<M>[], typeof omitFlagSchema>(
      projectableScalarNames(model) as ProjectableScalarKeys<M>[],
      omitFlagSchema
    ).entries,
    { optional: true }
  ) as OmitSchema<M>;

// ---------------------------------------------------------------------------
// Desugaring wrapper
// ---------------------------------------------------------------------------

const issue = (message: string) => ({ issues: [{ message }] });

const modelLabel = (model: AnyModel): string =>
  model["~"].names.ts ?? model["~"].state.tableName ?? "model";

/**
 * The projection an `omit` denotes: every projectable scalar the value did not
 * flag `true`. `undefined` means "nothing left", which the caller refuses.
 */
export const buildOmitSelection = (
  model: AnyModel,
  omitValue: Record<string, unknown>
): Record<string, true> | undefined => {
  const selection: Record<string, true> = {};
  for (const field of projectableScalarNames(model)) {
    if (omitValue[field] === true) continue;
    selection[field] = true;
  }
  return Object.keys(selection).length > 0 ? selection : undefined;
};

export const emptyOmitProjectionMessage = (
  model: AnyModel,
  operation: string
): string =>
  `'omit' on '${operation}' excluded every readable field of model '${modelLabel(model)}'. At least one field must remain in the result: drop a field from 'omit', or use 'select' to name what you want.`;

export const emptySelectedOmitProjectionMessage = (
  model: AnyModel,
  operation: string
): string =>
  `'omit' on '${operation}' excluded every selected field of model '${modelLabel(model)}'. At least one field must remain in the result: remove a field from 'omit' or add another field to 'select'.`;

const hasProjectedValue = (selection: Record<string, unknown>): boolean => {
  for (const field in selection) {
    const selected = selection[field];
    if (selected !== false && selected !== undefined) return true;
  }
  return false;
};

/** Subtract local omit flags from an already-validated explicit selection. */
const subtractOmitFromSelection = (
  selection: Record<string, unknown>,
  omitValue: Record<string, unknown>
): Record<string, unknown> => {
  const reduced: Record<string, unknown> = {};
  for (const field of Object.keys(selection)) {
    if (omitValue[field] === true) continue;
    reduced[field] = selection[field];
  }
  return reduced;
};

/**
 * Desugar `omit` into the one downstream projection vocabulary. With an
 * explicit `select`, subtract from that validated selection. Without one,
 * build the default scalar complement. Applied outside the other projection
 * guards so the rewrite happens after those guards validate the raw payload.
 */
export const withOmitProjection = <
  TEntries,
  TOpts extends ObjectOptions | undefined,
>(
  schema: ObjectSchema<TEntries, TOpts>,
  model: AnyModel,
  operation: string
): ObjectSchema<TEntries, TOpts> => {
  const standard = schema["~standard"];

  const validate: typeof standard.validate = (value) => {
    const hasOmit = isRecord(value) && value.omit !== undefined;
    const result = standard.validate(value) as Exclude<
      ReturnType<typeof standard.validate>,
      PromiseLike<unknown>
    >;
    if (!hasOmit || result.issues) return result;

    const validated = result.value as Record<string, unknown>;
    const omitValue = validated.omit as Record<string, unknown>;
    const explicitSelection = isRecord(validated.select)
      ? validated.select
      : undefined;
    const selection = explicitSelection
      ? subtractOmitFromSelection(explicitSelection, omitValue)
      : buildOmitSelection(model, omitValue);
    if (!selection) return issue(emptyOmitProjectionMessage(model, operation));
    if (
      explicitSelection &&
      hasProjectedValue(explicitSelection) &&
      !hasProjectedValue(selection)
    ) {
      return issue(emptySelectedOmitProjectionMessage(model, operation));
    }

    // The rewrite drops a key the schema declares and adds one it also declares,
    // so the OUTPUT type is unchanged in kind but not provably so to the checker
    // (`TEntries` is opaque here). Widening through `unknown` keeps the assertion
    // to the one place that performs the substitution.
    const { omit: _omit, ...rest } = validated;
    const rewritten: unknown = { ...rest, select: selection };
    return { value: rewritten as typeof result.value };
  };

  return {
    ...schema,
    parse: validate,
    "~standard": {
      version: standard.version,
      vendor: standard.vendor,
      validate,
      get types() {
        return standard.types;
      },
      get jsonSchema() {
        return standard.jsonSchema;
      },
    },
  };
};

// ---------------------------------------------------------------------------
// Upsert's projection
// ---------------------------------------------------------------------------

/**
 * `upsert` is the one write with NO whole-args parse — its create/update arms
 * are delegated to sub-operations that must receive the RAW payload, and the
 * untaken arm must not be validated at all (see `UpsertOperation`). Its
 * projection therefore gets its own small schema, so `omit` still desugars
 * through the ONE wrapper above instead of growing a second implementation
 * inside the engine.
 */
export type UpsertProjectionSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    select: CoreSchemas<M, F>["select"];
    include: CoreSchemas<M, F>["include"];
    omit: OmitSchema<M>;
  },
  { optional: true }
>;

export const getUpsertProjectionSchema = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  model: M,
  core: CoreSchemas<M, F>
): UpsertProjectionSchema<M, F> =>
  withOmitProjection(
    v.object(
      {
        select: v.lazyRef(() => core.select),
        include: v.lazyRef(() => core.include),
        omit: v.lazyRef(() => core.omit),
      },
      { optional: true }
    ),
    model,
    "upsert"
  );
