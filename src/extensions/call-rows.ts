/**
 * What the parts that read rules, kept rows and defaults share: the
 * arguments a declaration may name, and the call facts bound again once
 * every part of a definition has joined.
 */
import type { Application } from "./chain";
import type { CallRowsBinding, ResolvedExtensionChain } from "./chain-state";
import { extensionError } from "./definition";

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
