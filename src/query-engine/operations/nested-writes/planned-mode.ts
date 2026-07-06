import type { AnyDriver } from "@drivers";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import {
  type BatchPreparationContext,
  type QueryContext,
  QueryEngineError,
} from "../../types";
import type { Effect, Probe, ProbeResult } from "./effects";
import type { WriteSymbol } from "./expr";
import type { AtomicScope, Mode, NestedWriteResult } from "./mode";

/**
 * The batch-only substrate (`canObserveOwnWrites: false`) for D1 / Neon-HTTP.
 *
 * A read cannot see this operation's own uncommitted writes, so branch
 * decisions are made at plan time against committed state, produced values
 * are deferred through the scratch table (`batchRefs.store`/`read`), and
 * probe-backed premises are pinned by SQL assertions inside the atomic unit
 * (§8.3). The `PlanState` is shared across the operations of one
 * `$transaction([...])` via `BatchPreparationContext.nestedWriteState`, so
 * value-ref namespaces and setup/cleanup stay monotonic (map-oracle §B.2/§B.3).
 *
 * The emit/probe realizations land at M3+; at M1 the interpreter delegates
 * every tree to the old engines (empty `MIGRATED`, §11 M1), so no method
 * here is reached. `selectMode` still constructs it to prove capability
 * routing is identical to the old dispatch.
 */
export class PlannedMode implements Mode {
  readonly canObserveOwnWrites = false;
  readonly scope: AtomicScope;
  private readonly driver: AnyDriver;
  private readonly shared: BatchPreparationContext | undefined;

  constructor(driver: AnyDriver, shared?: BatchPreparationContext) {
    this.driver = driver;
    this.shared = shared;
    this.scope = {
      run: <T>(
        _body: (
          emit: (effect: Effect) => Promise<void>,
          mode: Mode
        ) => Promise<NestedWriteResult>
      ): Promise<T> => {
        throw this.notImplemented("scope.run");
      },
    };
  }

  /** True iff this planned scope shares its PlanState across the operations
   *  of one `$transaction([...])` (map-oracle §B.2/§B.3). */
  get isShared(): boolean {
    return this.shared !== undefined;
  }

  resolveSymbol(
    _ctx: QueryContext,
    _model: Model<any>,
    _field: string,
    _sym: WriteSymbol
  ): Sql {
    throw this.notImplemented("resolveSymbol");
  }

  isResolved(_sym: WriteSymbol): boolean {
    throw this.notImplemented("isResolved");
  }

  probe(_ctx: QueryContext, _p: Probe): Promise<ProbeResult> {
    throw this.notImplemented("probe");
  }

  private notImplemented(method: string): QueryEngineError {
    return new QueryEngineError(
      `PlannedMode.${method} is not wired yet; driver '${this.driver.driverName}' nested writes still run on the legacy engines until the interpreter milestones land.`
    );
  }
}
