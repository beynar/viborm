/**
 * What the parts that read rules, kept rows and defaults share: the
 * arguments a declaration may name, and the call facts bound again once
 * every part of an extension has joined.
 */
import type { Application } from "./chain";
import { extensionError } from "./chain";
import type { CallRowsBinding, ResolvedExtensionChain } from "./chain-state";

/**
 * Refuses an argument among `names` that no extension of the chain declares,
 * the extension's own included (they are declared before any part joins).
 * `undefined` is the call's instant, which every call has.
 */
export function refuseUndeclared(
  { name: extension, next }: Application,
  names: Iterable<string | undefined>
): void {
  for (const name of names)
    if (name !== undefined && next.controls?.names.has(name) !== true)
      extensionError(
        `Extension "${extension}" references undeclared argument "${name}".`,
        extension
      );
}

/**
 * The chain's call facts bound again where the extension changed what they
 * read, once whichever part asks: by the chain's own binder where one of its
 * parts filters, keeps or judges rows, else by `plain`. An extension that
 * declares only arguments changes nothing they bind: a filter names only
 * arguments its own or an earlier extension declares.
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
