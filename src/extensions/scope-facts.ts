/**
 * The internal member a method factory's scope answers: the facts of the
 * chain the method is called through, which a factory applied earlier in
 * that chain cannot read off the client it was given. Only official
 * extensions that write outside the engine (`viborm/ordering`) read it. Its
 * own module, so reading it imports nothing else.
 */
export const SCOPE_CHAIN_FACTS = Symbol("viborm.scopeChainFacts");
export interface ScopeChainFacts {
  /** Whether a `rows` member of the call's chain names the model. */
  readonly rowsName: (model: string) => boolean;
  /** The official cache's `$invalidate`, where the call's chain carries it. */
  readonly invalidate: ((...keys: string[]) => Promise<void>) | undefined;
}
