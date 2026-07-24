import type { QueryExecutionContext } from "@drivers";

/** Extend a request lifetime until background cache work settles. */
export type WaitUntilFn = (promise: Promise<unknown>) => void;

/** Cache entry with freshness metadata for stale-while-revalidate. */
export interface CacheEntry<T = unknown> {
  value: T;
  createdAt: number;
  ttl: number;
}

/** Storage options for a cache write. */
export interface CacheSetOptions {
  /** Time to live in milliseconds. */
  ttl: number;
  /** Storage TTL including the stale window, when SWR is enabled. */
  swrTtl?: number;
}

/** Parsed options for one cached ORM execution. */
export interface CacheExecutionOptions {
  /** Freshness duration in milliseconds. */
  ttlMs: number;
  /** Storage TTL including the stale window, or false to disable SWR. */
  swr: number | false;
  /** Bypass cache reads and force a fresh fetch. */
  bypass: boolean;
  /** Custom cache key override. */
  key?: string;
  /** Scheduler for background work in serverless runtimes. */
  waitUntil?: WaitUntilFn;
  /** Database attributes attached to the operation span. */
  dbAttributes?: Record<string, string>;
  /** Immutable attribution for the originating ORM operation. */
  executionContext?: QueryExecutionContext;
}
