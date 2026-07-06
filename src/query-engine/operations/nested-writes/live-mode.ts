import type { AnyDriver } from "@drivers";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { type QueryContext, QueryEngineError } from "../../types";
import type { Effect, Probe, ProbeResult } from "./effects";
import type { WriteSymbol } from "./expr";
import type { AtomicScope, Mode, NestedWriteResult } from "./mode";

/**
 * The interactive-transaction substrate (`canObserveOwnWrites: true`).
 *
 * A read issued mid-operation sees this operation's own uncommitted writes,
 * so branch decisions are made live, produced values are read back as JS
 * literals, and probe-backed guards realize as no-ops (§5.1). The whole
 * operation runs inside one flat `driver.withTransaction` scope (§8.2).
 *
 * The emit/probe realizations land at M3+; at M1 the interpreter delegates
 * every tree to the old engines (empty `MIGRATED`, §11 M1), so no method
 * here is reached. `selectMode` still constructs it to prove capability
 * routing is identical to the old dispatch.
 */
export class LiveMode implements Mode {
  readonly canObserveOwnWrites = true;
  readonly scope: AtomicScope;
  private readonly driver: AnyDriver;

  constructor(driver: AnyDriver) {
    this.driver = driver;
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
      `LiveMode.${method} is not wired yet; driver '${this.driver.driverName}' nested writes still run on the legacy engines until the interpreter milestones land.`
    );
  }
}
