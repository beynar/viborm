import {
  type DriverIdentity,
  readDriverIdentity,
} from "@drivers/driver-identity";
import { sourceOf, type Unit } from "../unit-source";

/**
 * The dialect, name and SQL namespace of the driver doing a unit's work;
 * `undefined` for a unit with no driver (a cache step), or when a custom
 * adapter's `namespace` getter throws.
 */
export function driver(unit: Unit): DriverIdentity | undefined {
  const source = sourceOf(unit)?.driver;
  return source === undefined ? undefined : readDriverIdentity(source);
}
