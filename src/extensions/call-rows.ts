/**
 * What the parts that read rows, kept rows, data and order share: the models
 * and fields a declaration may name, the controls it may name, and the call
 * facts bound again once every part of a definition has joined.
 */
import type { AnyModel } from "@schema/model";
import { isRecord } from "@validation/value-guards";
import type { Application } from "./chain";
import type { CallRowsBinding, ResolvedExtensionChain } from "./chain-state";
import { extensionError, readOwn, readOwnKeys } from "./definition";

/**
 * Each model `member` of the definition names, checked against the schema
 * it is applied to, then handed to `entry`: a model a declaration names
 * could otherwise bind to nothing, silently.
 */
export function eachModel(
  { definition, schema }: Application,
  member: "rows" | "data" | "deletion",
  entry: (
    model: AnyModel,
    name: string,
    declared: Record<string, unknown>,
    declaration: Record<string, unknown>
  ) => void
): void {
  const extension = definition.name;
  const declaration: unknown = definition[member];
  if (declaration === undefined) return;
  if (!isRecord(declaration))
    extensionError(
      `Extension "${extension}" ${member} must be an object.`,
      extension
    );
  const models = readOwn(declaration, "models", extension);
  if (!isRecord(models))
    extensionError(
      `Extension "${extension}" ${member}.models must be an object.`,
      extension
    );
  for (const name of readOwnKeys(models, extension)) {
    if (typeof name !== "string" || !Object.hasOwn(schema, name))
      extensionError(
        `Extension "${extension}" ${member} names unknown model "${String(name)}".`,
        extension
      );
    const declared = readOwn(models, name, extension);
    if (!isRecord(declared))
      extensionError(
        `Extension "${extension}" ${member}.${name} must be an object.`,
        extension
      );
    entry(schema[name]!, name, declared, declaration);
  }
}

/** The fields `input` names at `place`, each one of `model`'s scalars. */
export function checkFields(
  extension: string,
  place: string,
  model: AnyModel,
  input: unknown
): void {
  if (input === undefined) return;
  if (!isRecord(input))
    extensionError(
      `Extension "${extension}" ${place} fields must be an object.`,
      extension
    );
  for (const key of readOwnKeys(input, extension))
    if (
      typeof key !== "string" ||
      !Object.hasOwn(model["~"].state.scalars, key)
    )
      extensionError(
        `Extension "${extension}" ${place} names unknown field "${String(key)}".`,
        extension
      );
}

/**
 * Refuses a control among `names` that no extension of the chain declares,
 * the definition's own included (they are placed before any part joins).
 * `undefined` is the call's instant, which every call has.
 */
export function refuseUndeclared(
  { definition, next }: Application,
  names: Iterable<string | undefined>
): void {
  for (const control of names)
    if (control !== undefined && next.controls?.names.has(control) !== true)
      extensionError(
        `Extension "${definition.name}" references undeclared control "${control}".`,
        definition.name
      );
}

/**
 * The chain's call facts bound again where the definition changed what they
 * read, once whichever part asks: by the chain's own binder where one of its
 * parts filters, keeps or judges rows, else by `plain`. A definition that
 * declares only controls changes nothing they bind: a filter names only
 * controls its own or an earlier extension declares.
 */
export function rebind(
  { chain, next }: Application,
  plain: (chain: ResolvedExtensionChain) => CallRowsBinding
): void {
  if (
    next.callRows !== chain?.callRows ||
    (next.rows === chain?.rows &&
      next.kept === chain?.kept &&
      next.stamps === chain?.stamps &&
      next.order === chain?.order)
  )
    return;
  next.callRows = (next.bindRows ?? plain)(next);
}
