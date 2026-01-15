/**
 * Transaction Helper
 *
 * Provides utilities for handling transactions across drivers with
 * different capabilities (transactional vs non-transactional).
 */

import type { AnyDriver } from "@drivers";

/**
 * Execute operations with transaction if supported, otherwise sequentially.
 *
 * When the driver supports transactions, operations are wrapped in a transaction
 * and will be rolled back if any operation fails.
 *
 * When transactions aren't supported (e.g., Cloudflare D1), operations execute
 * sequentially without atomicity guarantees - if one fails, previous operations
 * are NOT rolled back.
 *
 * @param driver - Database driver
 * @param fn - Function containing operations to execute
 * @returns Result of the function
 */
export async function withTransactionIfSupported<T>(
  driver: AnyDriver,
  fn: (tx: AnyDriver) => Promise<T>
): Promise<T> {
  // Default to true if not specified
  if (driver.supportsTransactions !== false) {
    return driver._transaction(fn);
  }
  // No transaction support - execute directly (no atomicity)
  return fn(driver);
}
