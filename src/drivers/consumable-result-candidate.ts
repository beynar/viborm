import type { Sql } from "@sql";
import type { AnyDriver, QueryExecutionContext } from "./driver";
import type { QueryResult } from "./types";

type TypedExecuteEntry = (
  this: AnyDriver,
  query: Sql,
  context?: QueryExecutionContext
) => Promise<QueryResult<unknown>>;

type CandidateEligibility = (driver: AnyDriver) => boolean;
type ProducerEligibility = (driver: AnyDriver, client: object) => boolean;

export interface ConsumableResultCandidate {
  readonly driver: AnyDriver;
  readonly executeEntry: TypedExecuteEntry;
  readonly isCandidateEligible: CandidateEligibility;
  readonly isProducerEligible: ProducerEligibility;
}

interface ActiveConsumableProducer {
  readonly candidate: ConsumableResultCandidate;
  readonly client: object;
}

const candidates = new WeakMap<AnyDriver, ConsumableResultCandidate>();
const activeProducers = new WeakMap<AnyDriver, ActiveConsumableProducer>();

export function registerConsumableResultCandidate(
  driver: AnyDriver,
  executeEntry: TypedExecuteEntry,
  isCandidateEligible: CandidateEligibility,
  isProducerEligible: ProducerEligibility
): void {
  candidates.set(driver, {
    driver,
    executeEntry,
    isCandidateEligible,
    isProducerEligible,
  });
}

export function resolveConsumableResultCandidate(
  driver: AnyDriver
): ConsumableResultCandidate | undefined {
  const candidate = candidates.get(driver);
  return candidate?.isCandidateEligible(driver) ? candidate : undefined;
}

export function activateConsumableResultProducer(
  driver: AnyDriver,
  client: object
): void {
  const candidate = candidates.get(driver);
  if (!candidate?.isCandidateEligible(driver)) return;
  activeProducers.set(driver, { candidate, client });
}

export function deactivateConsumableResultProducer(
  driver: AnyDriver,
  client?: object
): void {
  const producer = activeProducers.get(driver);
  if (!producer || (client && producer.client !== client)) return;
  activeProducers.delete(driver);
}

type ResultContinuation<T> = (
  result: QueryResult<unknown>,
  consumableRows: unknown[] | undefined
) => T;

/**
 * Execute through the current typed entry, then keep the ownership proof only
 * on this stack frame until the executor synchronously parses the exact result.
 */
export async function executeConsumableResultCandidate<T>(
  candidate: ConsumableResultCandidate,
  query: Sql,
  context: QueryExecutionContext,
  continueWith: ResultContinuation<T>
): Promise<T> {
  const { driver } = candidate;
  const executeEntry: TypedExecuteEntry = driver._execute;
  const producerBefore = activeProducers.get(driver);
  const wasEligible =
    candidates.get(driver) === candidate &&
    executeEntry === candidate.executeEntry &&
    (producerBefore
      ? producerBefore.candidate === candidate &&
        candidate.isProducerEligible(driver, producerBefore.client)
      : candidate.isCandidateEligible(driver));

  const result = await executeEntry.call(driver, query, context);
  const producer = activeProducers.get(driver);
  const consumableRows =
    wasEligible &&
    candidates.get(driver) === candidate &&
    producer !== undefined &&
    (!producerBefore || producerBefore === producer) &&
    producer.candidate === candidate &&
    driver._execute === executeEntry &&
    executeEntry === candidate.executeEntry &&
    candidate.isProducerEligible(driver, producer.client)
      ? result.rows
      : undefined;

  return continueWith(result, consumableRows);
}
