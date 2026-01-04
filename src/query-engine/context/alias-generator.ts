/**
 * Alias Generator
 *
 * Generates sequential table aliases: t0, t1, t2...
 * Used to create unique aliases for tables and subqueries.
 */

export class AliasGenerator {
  private counter = 0;

  /**
   * Get the next alias (t0, t1, t2, ...)
   */
  next(): string {
    return `t${this.counter++}`;
  }

  /**
   * Get the root alias (always t0)
   */
  root(): string {
    return "t0";
  }

  /**
   * Get the current alias without incrementing
   */
  current(): string {
    return `t${Math.max(0, this.counter - 1)}`;
  }

  /**
   * Reset the generator (useful for testing)
   */
  reset(): void {
    this.counter = 0;
  }

  /**
   * Create a child generator that continues from current state
   * Useful for nested subqueries that need their own alias space
   */
  fork(): AliasGenerator {
    const child = new AliasGenerator();
    child.counter = this.counter;
    return child;
  }
}

/**
 * Create a new alias generator
 */
export const createAliasGenerator = (): AliasGenerator => new AliasGenerator();
