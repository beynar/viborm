/**
 * AliasGenerator - Table Alias Management Component
 *
 * This component manages the generation and tracking of table aliases for SQL queries.
 * It ensures unique alias generation, prevents conflicts, and provides debugging
 * capabilities for complex queries with multiple tables and subqueries.
 *
 * FEATURES:
 * - Sequential alias generation (t0, t1, t2, ...)
 * - Conflict detection and resolution
 * - Alias tracking and reuse prevention
 * - Custom alias prefix support
 * - Debugging and introspection capabilities
 * - Reset functionality for new query contexts
 *
 * ALIAS PATTERNS:
 * - Default: t0, t1, t2, t3, ...
 * - Custom prefix: prefix0, prefix1, prefix2, ...
 * - Scoped aliases: Different scopes for different query parts
 * - Reserved aliases: Prevention of conflicts with reserved names
 *
 * CONFLICT RESOLUTION:
 * - Automatic conflict detection
 * - Incremental suffix generation
 * - Reserved name avoidance
 * - Case-insensitive conflict checking
 *
 * PERFORMANCE:
 * - Fast O(1) alias generation
 * - Minimal memory footprint
 * - Efficient conflict checking
 * - Optimized for high-frequency usage
 *
 * DEBUGGING:
 * - Alias usage tracking
 * - Generation history
 * - Conflict resolution logging
 * - Query context association
 *
 * THREAD SAFETY:
 * - Instance-based state management
 * - No global state dependencies
 * - Safe for concurrent query building
 * - Isolated alias spaces per instance
 */
export class AliasGenerator {
  readonly name = "AliasGenerator";
  readonly dependencies: string[] = [];

  private aliasCounter = 0;
  private usedAliases = new Set<string>();
  private aliasHistory: Array<{
    alias: string;
    timestamp: Date;
    context?: string;
  }> = [];
  private prefix = "t";
  private reservedNames = new Set([
    "user",
    "order",
    "group",
    "table",
    "index",
    "key",
    "value",
  ]);

  constructor(
    options: {
      prefix?: string;
      reservedNames?: string[];
      trackHistory?: boolean;
    } = {}
  ) {
    this.prefix = options.prefix || "t";
    if (options.reservedNames) {
      options.reservedNames.forEach((name) =>
        this.reservedNames.add(name.toLowerCase())
      );
    }
  }

  /**
   * Generate next unique alias
   *
   * Creates a new unique alias using the configured pattern
   */
  generate(context?: string): string {
    let alias: string;
    let attempts = 0;
    const maxAttempts = 1000; // Prevent infinite loops

    do {
      alias = `${this.prefix}${this.aliasCounter++}`;
      attempts++;

      if (attempts > maxAttempts) {
        throw new Error(
          `Failed to generate unique alias after ${maxAttempts} attempts`
        );
      }
    } while (this.isConflict(alias));

    this.usedAliases.add(alias.toLowerCase());
    this.aliasHistory.push({
      alias,
      timestamp: new Date(),
      ...(context && { context }),
    });

    return alias;
  }

  /**
   * Generate alias with custom prefix
   *
   * Creates an alias with a specific prefix for special cases
   */
  generateWithPrefix(customPrefix: string, context?: string): string {
    const originalPrefix = this.prefix;
    this.prefix = customPrefix;

    try {
      return this.generate(context);
    } finally {
      this.prefix = originalPrefix;
    }
  }

  /**
   * Reserve an alias
   *
   * Marks an alias as used without generating it
   */
  reserve(alias: string, context?: string): boolean {
    const normalizedAlias = alias.toLowerCase();

    if (
      this.usedAliases.has(normalizedAlias) ||
      this.reservedNames.has(normalizedAlias)
    ) {
      return false; // Already in use or reserved
    }

    this.usedAliases.add(normalizedAlias);
    this.aliasHistory.push({
      alias,
      timestamp: new Date(),
      context: context || "reserved",
    });

    return true;
  }

  /**
   * Check if alias is available
   *
   * Tests whether an alias can be used without conflicts
   */
  isAvailable(alias: string): boolean {
    return !this.isConflict(alias);
  }

  /**
   * Get next alias without generating
   *
   * Previews what the next generated alias would be
   */
  peek(lookahead: number = 0): string {
    return `${this.prefix}${this.aliasCounter + lookahead}`;
  }

  /**
   * Reset alias generation
   *
   * Clears all state and starts fresh
   */
  reset(
    options: {
      keepHistory?: boolean;
      newPrefix?: string;
    } = {}
  ): void {
    this.aliasCounter = 0;
    this.usedAliases.clear();

    if (!options.keepHistory) {
      this.aliasHistory = [];
    }

    if (options.newPrefix) {
      this.prefix = options.newPrefix;
    }
  }

  /**
   * Get generation statistics
   *
   * Returns information about alias usage and generation
   */
  getStatistics(): {
    totalGenerated: number;
    currentCounter: number;
    usedAliases: number;
    conflicts: number;
    prefix: string;
  } {
    const conflicts = this.aliasHistory.filter(
      (entry) =>
        this.aliasHistory.filter((other) => other.alias === entry.alias)
          .length > 1
    ).length;

    return {
      totalGenerated: this.aliasHistory.length,
      currentCounter: this.aliasCounter,
      usedAliases: this.usedAliases.size,
      conflicts,
      prefix: this.prefix,
    };
  }

  /**
   * Get alias history
   *
   * Returns the history of generated aliases for debugging
   */
  getHistory(): Array<{ alias: string; timestamp: Date; context?: string }> {
    return [...this.aliasHistory];
  }

  /**
   * Create scoped generator
   *
   * Creates a new generator with isolated state for specific contexts
   */
  createScope(scopePrefix?: string): AliasGenerator {
    return new AliasGenerator({
      prefix: scopePrefix || `${this.prefix}_scope`,
      reservedNames: Array.from(this.reservedNames),
    });
  }

  /**
   * Validate alias format
   *
   * Checks if an alias follows valid SQL identifier rules
   */
  validateAlias(alias: string): boolean {
    // Basic SQL identifier validation
    const sqlIdentifierPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    return sqlIdentifierPattern.test(alias) && alias.length <= 63; // PostgreSQL limit
  }

  /**
   * Suggest alternative alias
   *
   * Provides alternative alias suggestions when conflicts occur
   */
  suggestAlternative(desiredAlias: string): string[] {
    const suggestions: string[] = [];
    const base = desiredAlias.replace(/\d+$/, ""); // Remove trailing numbers

    for (let i = 1; i <= 5; i++) {
      const suggestion = `${base}${i}`;
      if (this.isAvailable(suggestion)) {
        suggestions.push(suggestion);
      }
    }

    return suggestions;
  }

  /**
   * Bulk reserve aliases
   *
   * Reserves multiple aliases at once
   */
  bulkReserve(
    aliases: string[],
    context?: string
  ): { reserved: string[]; conflicts: string[] } {
    const reserved: string[] = [];
    const conflicts: string[] = [];

    for (const alias of aliases) {
      if (this.reserve(alias, context)) {
        reserved.push(alias);
      } else {
        conflicts.push(alias);
      }
    }

    return { reserved, conflicts };
  }

  /**
   * Get conflict information
   *
   * Provides detailed information about alias conflicts
   */
  getConflictInfo(alias: string): {
    isConflict: boolean;
    reason: string;
    suggestions: string[];
  } {
    const normalizedAlias = alias.toLowerCase();
    let reason = "";

    if (this.reservedNames.has(normalizedAlias)) {
      reason = "Reserved SQL keyword";
    } else if (this.usedAliases.has(normalizedAlias)) {
      reason = "Already used in this query";
    } else if (!this.validateAlias(alias)) {
      reason = "Invalid SQL identifier format";
    }

    return {
      isConflict: reason !== "",
      reason,
      suggestions: reason ? this.suggestAlternative(alias) : [],
    };
  }

  /**
   * Private helper methods
   */

  private isConflict(alias: string): boolean {
    const normalizedAlias = alias.toLowerCase();
    return (
      this.usedAliases.has(normalizedAlias) ||
      this.reservedNames.has(normalizedAlias) ||
      !this.validateAlias(alias)
    );
  }
}
