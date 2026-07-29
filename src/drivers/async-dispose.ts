/**
 * The platform's async-disposal protocol — as much of it as the runtime and the
 * consumer's type declarations actually provide.
 *
 * `Symbol.asyncDispose` (explicit resource management, TypeScript 5.2+) can be
 * missing in two independent ways, and each one is handled here so that no
 * caller has to think about it:
 *
 * 1. **The runtime symbol** is absent on engines that predate the proposal.
 *    {@link ASYNC_DISPOSE} resolves it once; every definition site guards on it
 *    rather than writing a bare `[Symbol.asyncDispose]` computed key, which
 *    would otherwise install a method under the string key `"undefined"`.
 *
 * 2. **The type declaration** is absent from a consumer's `lib` / `@types`.
 *    That is why the disposal member is carried by {@link AsyncDisposeMember}
 *    instead of being written literally: a consumer who never writes
 *    `await using` must not be forced to widen `lib` just to compile the
 *    published `.d.mts`. See `docs/architecture/typed-kernel-without-effect-plan.md`
 *    (Phase T6) and the consumer-floor probe in
 *    `scripts/consumer-type-floor.mjs` for the measured floor.
 */

/**
 * The runtime's async-disposal key, or `undefined` on engines that predate
 * explicit resource management.
 */
export const ASYNC_DISPOSE: typeof Symbol.asyncDispose | undefined =
  typeof Symbol.asyncDispose === "symbol" ? Symbol.asyncDispose : undefined;

/**
 * `Symbol.asyncDispose`'s type where the ambient declarations define it, and
 * `never` where they do not.
 *
 * `never` is the load-bearing half: it turns {@link AsyncDisposeMember} into the
 * empty object, so the member simply is not there for a consumer whose `lib`
 * and `@types` never declared the symbol in the first place.
 */
export type AsyncDisposeKey = SymbolConstructor extends {
  readonly asyncDispose: infer Key extends symbol;
}
  ? Key
  : never;

/**
 * `{ [Symbol.asyncDispose](): Promise<void> }` where the symbol is typed, and
 * `{}` where it is not — the graceful-degradation carrier for every viborm type
 * that participates in `await using`.
 */
export type AsyncDisposeMember = {
  [Key in AsyncDisposeKey]: () => Promise<void>;
};
