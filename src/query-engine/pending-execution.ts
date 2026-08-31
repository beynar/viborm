import type { AnyDriver } from "@drivers";
import { PendingOperationError } from "@errors";

function captureExecution<T>(run: () => Promise<T>): Promise<T> {
  try {
    return run();
  } catch (error) {
    return Promise.reject(error);
  }
}

/** One deferred operation's mutually exclusive default/transaction execution. */
export class PendingExecution<T> {
  private promise: Promise<T> | null = null;
  private executedWith: AnyDriver | "default" | null = null;
  private reservedForBatch = false;
  private readonly model: string;
  private readonly operation: string;

  constructor(model: string, operation: string) {
    this.model = model;
    this.operation = operation;
  }

  executeDefault(run: () => Promise<T>): Promise<T> {
    if (this.executedWith !== null && this.executedWith !== "default") {
      throw PendingOperationError.alreadyExecutedWithDriver(
        this.model,
        this.operation
      );
    }

    if (!this.promise) {
      this.executedWith = "default";
      this.promise = captureExecution(run);
    }
    return this.promise;
  }

  executeWith(driver: AnyDriver, run: () => Promise<T>): Promise<T> {
    if (this.reservedForBatch) {
      throw PendingOperationError.alreadyExecutedWithDriver(
        this.model,
        this.operation
      );
    }
    if (this.executedWith === "default") {
      throw PendingOperationError.alreadyExecutedDefault(
        this.model,
        this.operation
      );
    }
    if (this.executedWith !== null && this.executedWith !== driver) {
      throw PendingOperationError.differentDriverConflict(
        this.model,
        this.operation
      );
    }

    if (!this.promise) {
      this.executedWith = driver;
      this.promise = captureExecution(run);
    }
    return this.promise;
  }

  reserveWith(driver: AnyDriver): void {
    if (this.executedWith === "default") {
      throw PendingOperationError.alreadyExecutedDefault(
        this.model,
        this.operation
      );
    }
    if (this.executedWith !== null) {
      if (this.executedWith !== driver) {
        throw PendingOperationError.differentDriverConflict(
          this.model,
          this.operation
        );
      }
      throw PendingOperationError.alreadyExecutedWithDriver(
        this.model,
        this.operation
      );
    }
    this.executedWith = driver;
    this.reservedForBatch = true;
  }

  /** Run the core child once after the array coordinator reserved this operation. */
  executeReserved(run: () => Promise<T>): Promise<T> {
    if (!this.promise) this.promise = captureExecution(run);
    return this.promise;
  }
}
