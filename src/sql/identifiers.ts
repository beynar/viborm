/**
 * Identifier text primitives.
 *
 * Quoting one name for a dialect, and composing a namespace-qualified object
 * name, are string concerns with no `Sql` involvement: runtime adapters wrap the
 * result in `Sql`, migration drivers splice it into DDL text. Both pass their
 * own quoter — the two differ in escape semantics and null handling — so what is
 * shared here is the composition rule alone, and it has one owner.
 */

/** Quote a single identifier for the dialect: `"name"` or `` `name` ``. */
export type IdentifierQuoter = (name: string) => string;

/** Build an identifier quoter that doubles embedded quote characters to prevent SQL injection. */
export const createIdentifierQuoter =
  (quoteChar: '"' | "`"): IdentifierQuoter =>
  (name: string): string => {
    const escaped =
      name.indexOf(quoteChar) === -1
        ? name
        : name.replaceAll(quoteChar, quoteChar + quoteChar);
    return quoteChar + escaped + quoteChar;
  };

/**
 * The one qualification rule. A present namespace contributes a quoted prefix;
 * an absent one contributes nothing, which is what unbound MySQL and every
 * SQLite adapter mean.
 */
const qualifiedPrefix = (
  quoteIdentifier: IdentifierQuoter,
  namespace: string
): string => `${quoteIdentifier(namespace)}.`;

/**
 * Compose one namespace-qualified object name. The namespace must already be
 * normalized: this primitive validates nothing, holds nothing, and returns text
 * for exactly one object.
 */
export const renderQualifiedIdentifier = (
  quoteIdentifier: IdentifierQuoter,
  namespace: string | undefined,
  object: string
): string =>
  namespace === undefined
    ? quoteIdentifier(object)
    : qualifiedPrefix(quoteIdentifier, namespace) + quoteIdentifier(object);

/**
 * Bind one namespace so its prefix is quoted once per adapter rather than once
 * per rendered statement. The returned function renders exactly what
 * `renderQualifiedIdentifier` would for the same namespace.
 */
export const createQualifiedIdentifierRenderer = (
  quoteIdentifier: IdentifierQuoter,
  namespace: string | undefined
): IdentifierQuoter => {
  if (namespace === undefined) {
    return quoteIdentifier;
  }
  const prefix = qualifiedPrefix(quoteIdentifier, namespace);
  return (object: string): string => prefix + quoteIdentifier(object);
};
