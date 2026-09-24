// Fixture (a) — identifier generators only.
// Imports the BUILT package entry by relative path so the measurement reflects
// shipped bytes, not source. `s.string().id()` is ULID-backed today.
import { s } from "../../dist/schema.mjs";

const uuid = s.string().uuid();
const ulid = s.string().ulid();
const nano = s.string().nanoid();
const cuid = s.string().cuid();
const auto = s.string().id();

export const generated = [
  uuid["~"].state.default(),
  ulid["~"].state.default(),
  nano["~"].state.default(),
  cuid["~"].state.default(),
  auto["~"].state.default(),
];
