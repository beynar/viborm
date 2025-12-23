import { inferred } from "../inferred";
import type { VibSchema, InferInput, InferOutput } from "../types";
import { fail, ok, createSchema, validateSchema } from "../helpers";

// =============================================================================
// Pipe Schema
// =============================================================================

/**
 * Transform action interface.
 */
export interface TransformAction<TIn, TOut> {
  readonly type: "transform";
  readonly transform: (value: TIn) => TOut;
}

/**
 * Create a transform action for use with pipe.
 * 
 * @example
 * const upperCase = v.pipe(v.string(), v.transform(s => s.toUpperCase()));
 */
export function transform<TIn, TOut>(
  fn: (value: TIn) => TOut
): TransformAction<TIn, TOut> {
  return {
    type: "transform",
    transform: fn,
  };
}

/**
 * Pipe action types.
 */
export type PipeAction<TIn, TOut> = TransformAction<TIn, TOut>;

/**
 * Pipe schema interface.
 */
export interface PipeSchema<
  TSchema extends VibSchema<any, any>,
  TActions extends readonly PipeAction<any, any>[],
  TInput = InferInput<TSchema>,
  TOutput = TActions extends readonly [...any[], PipeAction<any, infer TLast>]
    ? TLast
    : InferOutput<TSchema>
> extends VibSchema<TInput, TOutput> {
  readonly type: "pipe";
  readonly schema: TSchema;
  readonly actions: TActions;
}

/**
 * Infer the final output type from a chain of actions.
 */
type InferPipeOutput<
  TSchema extends VibSchema<any, any>,
  TActions extends readonly PipeAction<any, any>[]
> = TActions extends readonly []
  ? InferOutput<TSchema>
  : TActions extends readonly [PipeAction<any, infer TOut>]
    ? TOut
    : TActions extends readonly [PipeAction<any, infer TMid>, ...infer TRest]
      ? TRest extends readonly PipeAction<any, any>[]
        ? InferPipeOutput<VibSchema<TMid, TMid>, TRest>
        : TMid
      : InferOutput<TSchema>;

/**
 * Create a pipe schema that chains a base schema with transform actions.
 * 
 * @example
 * const trimmedString = v.pipe(v.string(), v.transform(s => s.trim()));
 * const isoDate = v.pipe(v.date(), v.transform(d => d.toISOString()));
 */
export function pipe<
  TSchema extends VibSchema<any, any>,
  const TActions extends readonly PipeAction<any, any>[]
>(
  schema: TSchema,
  ...actions: TActions
): PipeSchema<TSchema, TActions, InferInput<TSchema>, InferPipeOutput<TSchema, TActions>> {
  const pipeSchema = createSchema<InferInput<TSchema>, InferPipeOutput<TSchema, TActions>>(
    "pipe",
    (value) => {
      const result = validateSchema(schema, value);
      if (result.issues) {
        return result as any;
      }

      let current: unknown = (result as { value: unknown }).value;
      for (const action of actions) {
        if (action.type === "transform") {
          try {
            current = action.transform(current);
          } catch (e) {
            return fail(`Transform failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      return ok(current as InferPipeOutput<TSchema, TActions>);
    }
  ) as PipeSchema<TSchema, TActions, InferInput<TSchema>, InferPipeOutput<TSchema, TActions>>;

  (pipeSchema as any).schema = schema;
  (pipeSchema as any).actions = actions;

  return pipeSchema;
}
