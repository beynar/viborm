/**
 * Transaction Helper
 *
 * Provides utilities for handling transactions across drivers with
 * different capabilities (transactional vs non-transactional).
 */

import type { Driver } from "@drivers";

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
  driver: Driver,
  fn: (tx: Driver) => Promise<T>
): Promise<T> {
  if (driver.adapter.capabilities.supportsTransactions) {
    return driver.transaction(fn);
  }
  // No transaction support - execute directly (no atomicity)
  return fn(driver);
}
