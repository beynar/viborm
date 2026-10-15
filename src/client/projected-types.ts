/**
 * The types of a declared projection key and of read-gated fields (K5, plan
 * §11.2 F8): decided once per `$extends`, from what the definition's
 * `rows.verbs` declares, never by a branch on the extension state inside the
 * client or its delegates.
 *
 * - A model whose verbs declare `evidence` gains its row operations again as
 *   extra overloads (the model slot), whose arguments admit the key in every
 *   `select` and `include` the call spells and whose result carries it there.
 *   The ordinary overload is tried first: a call that names no key keeps its
 *   exact types. The existing key guards read the call with the key taken out.
 * - A read-gated field is a field the client may omit: it joins the client's
 *   default omit as `boolean`, so the omit machinery makes it optional in a
 *   default row and present where a `select` names it, at every depth.
 *
 * The overloads see the chain as it is at this `$extends`: a control an
 * extension applied later declares is not among their arguments.
 */

import type { PendingOperation } from "@query-engine/pending-operation";
import type { Model } from "@schema/model";
import type { Prettify } from "@validation";
import type { VibORMConfig } from "./client";
import type {
  GetTargetModel,
  ModelResultSurface,
  NodeInclude,
  NodeSelect,
  SameModelResultSurface,
} from "./result-types";
import type { ClientSchema } from "./schema-links";
import type {
  ContextualOperationResult,
  NoExtraOperationKeys,
  OperationPayload,
  PlacedOperationControls,
  WithControlArgs,
} from "./types";

/** One model's declared projection key, matched by its result surface. */
export interface ProjectionEntry<
  Surface,
  Names extends string,
  Ordered extends boolean,
> {
  readonly surface: Surface;
  readonly names: Names;
  readonly ordered: Ordered;
}

/** The row operations a projection key reaches. */
type ProjectedOperation =
  | "findMany"
  | "findFirst"
  | "findUnique"
  | "findFirstOrThrow"
  | "findUniqueOrThrow"
  | "create"
  | "update"
  | "upsert"
  | "delete";

type VerbsOf<Definition> = Definition extends {
  readonly rows: { readonly verbs: infer Verbs };
}
  ? Verbs
  : never;

type DeclaredEvidence<Entry> = Entry extends {
  readonly evidence: {
    readonly as: infer Key extends string;
    readonly names: readonly (infer Names extends string)[];
  };
}
  ? {
      readonly key: Key;
      readonly names: Names;
      readonly ordered: Entry extends {
        readonly evidence: { readonly ordered: true };
      }
        ? true
        : false;
    }
  : never;

type EvidenceModels<C extends VibORMConfig, Verbs> = {
  [M in Extract<keyof Verbs, keyof ClientSchema<C>>]: [
    DeclaredEvidence<Verbs[M]>,
  ] extends [never]
    ? never
    : M;
}[Extract<keyof Verbs, keyof ClientSchema<C>>];

/** The key a definition declares (one spelling per chain step). */
type KeyOf<Verbs> = {
  [M in keyof Verbs]: DeclaredEvidence<Verbs[M]>["key"];
}[keyof Verbs];

type EntriesOf<C extends VibORMConfig, Verbs> = {
  [M in EvidenceModels<C, Verbs>]: ProjectionEntry<
    ModelResultSurface<ClientSchema<C>[M]>,
    DeclaredEvidence<Verbs[M]>["names"],
    DeclaredEvidence<Verbs[M]>["ordered"]
  >;
}[EvidenceModels<C, Verbs>];

/** The entry of `M`, by its result surface; `never` where it declares none. */
type EntryFor<M extends Model<any>, Entries> = Entries extends ProjectionEntry<
  infer Surface,
  string,
  boolean
>
  ? true extends SameModelResultSurface<ModelResultSurface<M>, Surface>
    ? Entries
    : never
  : never;

type KeyValue<Entry> =
  Entry extends ProjectionEntry<unknown, infer Names, boolean>
    ? boolean | readonly Names[]
    : never;

type RelationsOf<M extends Model<any>> = M["~"]["state"]["relations"];

/** A node's relation entry, admitting the key below it at the target's own. */
type ProjectedRelation<
  Value,
  M extends Model<any>,
  Field,
  Entries,
  Key extends string,
> = Field extends keyof RelationsOf<M>
  ? Value extends object
    ? ProjectedArgs<Value, GetTargetModel<RelationsOf<M>[Field]>, Entries, Key>
    : Value
  : Value;

type ProjectedNode<
  Node,
  M extends Model<any>,
  Entries,
  Key extends string,
> = Node extends object
  ? {
      [Field in keyof Node]: ProjectedRelation<
        Node[Field],
        M,
        Field,
        Entries,
        Key
      >;
    } & { readonly [K in Key]?: KeyValue<EntryFor<M, Entries>> }
  : Node;

/** A payload whose every `select` and `include` admits the key at its model's names. */
type ProjectedArgs<
  Payload,
  M extends Model<any>,
  Entries,
  Key extends string,
> = Payload extends object
  ? {
      [Field in keyof Payload]: Field extends "select" | "include"
        ? ProjectedNode<Payload[Field], M, Entries, Key>
        : Payload[Field];
    }
  : Payload;

/** The call with the key taken out of every node it spelled. */
export type WithoutKey<Arg, Key extends string> = Arg extends object
  ? {
      [Field in keyof Arg]: Field extends "select" | "include"
        ? WithoutKeyNode<Arg[Field], Key>
        : Arg[Field];
    }
  : Arg;

type WithoutKeyNode<Node, Key extends string> = Node extends object
  ? {
      [Field in Exclude<keyof Node, Key>]: Node[Field] extends object
        ? WithoutKey<Node[Field], Key>
        : Node[Field];
    }
  : Node;

/** The merged projection a node spelled. */
type Spelled<Node> = (NodeSelect<Node> extends object
  ? NodeSelect<Node>
  : unknown) &
  (NodeInclude<Node> extends object ? NodeInclude<Node> : unknown);

/** What the key reads for `Entry` where the node asked for `Asked`. */
type KeyResult<Entry, Asked> =
  Entry extends ProjectionEntry<unknown, infer Names, infer Ordered>
    ? Asked extends readonly (infer Some extends string)[]
      ? Ordered extends true
        ? Some | null
        : { readonly [Name in Some]: boolean }
      : Ordered extends true
        ? Names | null
        : { readonly [Name in Names]: boolean }
    : never;

type KeyMember<
  Node,
  M extends Model<any>,
  Entries,
  Key extends string,
> = Key extends keyof Spelled<Node>
  ? Spelled<Node>[Key] extends false | undefined
    ? unknown
    : {
        readonly [K in Key]: KeyResult<
          EntryFor<M, Entries>,
          Spelled<Node>[Key]
        >;
      }
  : unknown;

type SpelledRelations<Node, M extends Model<any>> = Extract<
  keyof Spelled<Node>,
  keyof RelationsOf<M>
>;

type OverlayRow<
  Row,
  Node,
  M extends Model<any>,
  Entries,
  Key extends string,
> = Prettify<
  {
    [Field in keyof Row]: Field extends SpelledRelations<Node, M>
      ? Spelled<Node>[Field] extends object
        ? Overlay<
            Row[Field],
            Spelled<Node>[Field],
            GetTargetModel<RelationsOf<M>[Field]>,
            Entries,
            Key
          >
        : Row[Field]
      : Row[Field];
  } & KeyMember<Node, M, Entries, Key>
>;

/** A result with the key's member added wherever the call spelled it. */
type Overlay<
  Result,
  Node,
  M extends Model<any>,
  Entries,
  Key extends string,
> = Result extends readonly (infer Row)[]
  ? OverlayRow<Row, Node, M, Entries, Key>[]
  : Result extends object
    ? OverlayRow<Result, Node, M, Entries, Key>
    : Result;

type ProjectedMethod<
  O extends ProjectedOperation,
  C extends VibORMConfig,
  ModelName extends keyof ClientSchema<C>,
  ClientDefaults,
  Controls,
  Entries,
  Key extends string,
  M extends Model<any> = ClientSchema<C>[ModelName],
  Payload = OperationPayload<O, M>,
  Placed = PlacedOperationControls<Controls, ModelName, O>,
> = <Arg extends ProjectedArgs<Exclude<Payload, undefined>, M, Entries, Key>>(
  args: Arg &
    WithControlArgs<
      NoExtraOperationKeys<
        O,
        WithoutKey<Arg, Key>,
        Exclude<Payload, undefined>,
        M,
        Placed
      >,
      Placed
    >
) => PendingOperation<
  Overlay<
    ContextualOperationResult<
      C,
      ModelName,
      O,
      WithoutKey<Arg, Key>,
      ClientDefaults
    >,
    Arg,
    M,
    Entries,
    Key
  >
>;

/**
 * The projected overloads a definition adds, per model declaring a key, for
 * a client whose config is `C`, whose results read under `ClientDefaults`
 * and whose calls take `Controls`.
 */
export type ProjectedModelOperations<
  C extends VibORMConfig,
  ClientDefaults,
  Controls,
  Definition,
  Verbs = VerbsOf<Definition>,
> = {
  readonly [ModelName in EvidenceModels<C, Verbs>]: {
    readonly [O in ProjectedOperation]: ProjectedMethod<
      O,
      C,
      ModelName,
      ClientDefaults,
      Controls,
      EntriesOf<C, Verbs>,
      KeyOf<Verbs>
    >;
  };
};

/**
 * Whether a definition's verbs declare a projection key. A definition with no
 * `rows.verbs` is answered by its shape alone, before any model is read.
 */
export type DeclaresEvidence<
  C extends VibORMConfig,
  Definition,
> = Definition extends {
  readonly rows: { readonly verbs: infer Verbs extends object };
}
  ? [EvidenceModels<C, Verbs>] extends [never]
    ? false
    : true
  : false;

/** Per model, the fields a definition's verbs read-gate, each `boolean`. */
type GatedOmit<Verbs> = {
  [M in keyof Verbs as Verbs[M] extends { readonly reads: object }
    ? M
    : never]: Verbs[M] extends { readonly reads: infer Reads }
    ? { readonly [Field in keyof Reads]: boolean }
    : never;
};

type ConfigOmit<C> = C extends { readonly omit: infer Omit } ? Omit : undefined;

type MergedOmit<Given, Gated> = [Given] extends [undefined]
  ? Gated
  : {
      readonly [M in keyof Given | keyof Gated]: (M extends keyof Given
        ? Given[M]
        : unknown) &
        (M extends keyof Gated ? Gated[M] : unknown);
    };

/**
 * The config a definition's read-gated fields leave: `C` itself where it
 * gates none, else `C` with each gated field a `boolean` default omit, beside
 * what the client already omits.
 */
export type GatedConfig<
  C extends VibORMConfig,
  Definition,
> = Definition extends {
  readonly rows: { readonly verbs: infer Verbs extends object };
}
  ? [keyof GatedOmit<Verbs>] extends [never]
    ? C
    : Omit<C, "omit"> & {
        readonly omit: MergedOmit<ConfigOmit<C>, GatedOmit<Verbs>>;
      }
  : C;
