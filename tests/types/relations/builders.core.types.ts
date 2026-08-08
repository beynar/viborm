import { type ReferentialAction, s } from "@src/schema";

const target = s.model({ id: s.string().id() });
const base = s.manyToMany(() => target);
const configured = base
  .through("source_targets")
  .A("source_id")
  .B("target_id")
  .onDelete("cascade")
  .onUpdate("restrict")
  .name("targets");

const _type: "manyToMany" = configured["~"].state.type;
const _through: string = configured["~"].state.through;
const _sourceColumn: string = configured["~"].state.A;
const _targetColumn: string = configured["~"].state.B;
const _deleteAction: ReferentialAction = configured["~"].state.onDelete;
const _updateAction: ReferentialAction = configured["~"].state.onUpdate;
const _name: "targets" = configured["~"].state.name;

// @ts-expect-error - the unmodified relation state has no junction table
base["~"].state.through;

// @ts-expect-error - one-to-many does not own foreign-key fields
s.oneToMany(() => target).fields("targetId");

// @ts-expect-error - many-to-many optionality is represented by the junction
s.manyToMany(() => target).optional();

// @ts-expect-error - referential actions are a closed public union
configured.onDelete("remove");
