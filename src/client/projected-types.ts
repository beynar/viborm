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
import type { Cardinality } from "@schema/relation/static-membership";
import type { Prettify } from "@validation";
import type { VibORMConfig } from "./client";
import type { NodeInclude, NodeSelect } from "./result-types";
import type { ClientRelationLinks, ClientSchema } from "./schema-links";
import type {
  CacheableOperations,
  ContextualOperationResult,
  NoExtraOperationKeys,
  OperationPayload,
  PlacedOperationControls,
  WithControlArgs,
} from "./types";

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

/** Projection facts stay keyed by the schema name, including at relation targets. */
type ProjectionModels<C extends VibORMConfig, Verbs> = {
  [M in keyof ClientSchema<C>]: {
    readonly model: ClientSchema<C>[M];
    readonly evidence: M extends keyof Verbs
      ? [DeclaredEvidence<Verbs[M]>] extends [never]
        ? undefined
        : DeclaredEvidence<Verbs[M]>
      : undefined;
    readonly relations: M extends keyof ClientRelationLinks<C>
      ? ClientRelationLinks<C>[M]
      : never;
  };
};

type ProjectionModelsConstraint = Readonly<
  Record<
    PropertyKey,
    {
      readonly model: Model<any>;
      readonly evidence: unknown;
      readonly relations: unknown;
    }
  >
>;

/** Indistinguishable target types may link to several keys: only shared names are safe. */
type CommonNames<Entry> = (
  Entry extends { readonly names: infer Names extends string }
    ? (name: Names) => void
    : never
) extends (name: infer Names extends string) => void
  ? Names
  : never;

type KeyValue<Entry> = [Entry] extends [never]
  ? never
  : undefined extends Entry
    ? never
    : boolean | readonly CommonNames<Entry>[];

type RelationsOf<
  Models extends ProjectionModelsConstraint,
  Name extends keyof Models,
> = Models[Name]["model"]["~"]["state"]["relations"];

/** A variant's link keeps its target's own evidence names. */
type VariantName<
  Models extends ProjectionModelsConstraint,
  Links,
  Variant,
> = Variant extends keyof Links ? Extract<Links[Variant], keyof Models> : never;

type ProjectedArms<
  Arms,
  Models extends ProjectionModelsConstraint,
  Links,
  Key extends string,
> = Arms extends object
  ? {
      [Variant in keyof Arms]: ProjectedArgs<
        Arms[Variant],
        Models,
        VariantName<Models, Links, Variant>,
        Key
      >;
    }
  : Arms;

/** A node's relation entry, admitting the key below it at the target's own. */
type ProjectedRelation<
  Value,
  Models extends ProjectionModelsConstraint,
  Name extends keyof Models,
  Field,
  Key extends string,
> = Field extends keyof RelationsOf<Models, Name>
  ? Value extends object
    ? Field extends keyof Models[Name]["relations"]
      ? Models[Name]["relations"][Field] extends infer Links
        ? [Links] extends [PropertyKey]
          ? ProjectedArgs<Value, Models, Extract<Links, keyof Models>, Key>
          : Cardinality<RelationsOf<Models, Name>[Field]> extends "many"
            ? {
                [P in keyof Value]: P extends "variants"
                  ? ProjectedArms<Value[P], Models, Links, Key>
                  : Value[P];
              }
            : ProjectedArms<Value, Models, Links, Key>
        : never
      : Value
    : Value
  : Value;

type ProjectedNode<
  Node,
  Models extends ProjectionModelsConstraint,
  Name extends keyof Models,
  Key extends string,
> = Node extends object
  ? {
      [Field in keyof Node]: ProjectedRelation<
        Node[Field],
        Models,
        Name,
        Field,
        Key
      >;
    } & { readonly [K in Key]?: KeyValue<Models[Name]["evidence"]> }
  : Node;

/** A payload whose every `select` and `include` admits the key at its model's names. */
type ProjectedArgs<
  Payload,
  Models extends ProjectionModelsConstraint,
  Name extends keyof Models,
  Key extends string,
> = Payload extends object
  ? {
      [Field in keyof Payload]: Field extends "select" | "include"
        ? ProjectedNode<Payload[Field], Models, Name, Key>
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
type KeyResult<Entry, Asked> = Entry extends {
  readonly names: infer Names extends string;
  readonly ordered: infer Ordered extends boolean;
}
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
  Models extends ProjectionModelsConstraint,
  Name extends keyof Models,
  Key extends string,
> = Key extends keyof Spelled<Node>
  ? Spelled<Node>[Key] extends false | undefined
    ? unknown
    : {
        readonly [K in Key]: KeyResult<
          Models[Name]["evidence"],
          Spelled<Node>[Key]
        >;
      }
  : unknown;

type SpelledRelations<
  Node,
  Models extends ProjectionModelsConstraint,
  Name extends keyof Models,
> = Extract<keyof Spelled<Node>, keyof RelationsOf<Models, Name>>;

/** Preserve a variant carrier and overlay its selected target document. */
type OverlayVariant<
  Result,
  Node,
  Models extends ProjectionModelsConstraint,
  Links,
  Key extends string,
> = Result extends readonly unknown[]
  ? {
      [Index in keyof Result]: OverlayVariant<
        Result[Index],
        Node extends { readonly variants?: infer Arms } ? Arms : undefined,
        Models,
        Links,
        Key
      >;
    }
  : Result extends { readonly type: infer Variant; readonly data: unknown }
    ? {
        [P in keyof Result]: P extends "data"
          ? Variant extends keyof Node
            ? Overlay<
                Result[P],
                Node[Variant],
                Models,
                VariantName<Models, Links, Variant>,
                Key
              >
            : Result[P]
          : Result[P];
      }
    : Result;

type OverlayRelation<
  Result,
  Node,
  Models extends ProjectionModelsConstraint,
  Name extends keyof Models,
  Field,
  Key extends string,
> = Field extends keyof Models[Name]["relations"]
  ? Models[Name]["relations"][Field] extends infer Links
    ? [Links] extends [PropertyKey]
      ? Overlay<Result, Node, Models, Extract<Links, keyof Models>, Key>
      : OverlayVariant<Result, Node, Models, Links, Key>
    : never
  : Result;

type OverlayRow<
  Row,
  Node,
  Models extends ProjectionModelsConstraint,
  Name extends keyof Models,
  Key extends string,
> = Prettify<
  {
    [Field in keyof Row]: Field extends SpelledRelations<Node, Models, Name>
      ? Spelled<Node>[Field] extends object
        ? OverlayRelation<
            Row[Field],
            Spelled<Node>[Field],
            Models,
            Name,
            Field,
            Key
          >
        : Row[Field]
      : Row[Field];
  } & KeyMember<Node, Models, Name, Key>
>;

/** A result with the key's member added wherever the call spelled it. */
type Overlay<
  Result,
  Node,
  Models extends ProjectionModelsConstraint,
  Name extends keyof Models,
  Key extends string,
> = Result extends readonly (infer Row)[]
  ? OverlayRow<Row, Node, Models, Name, Key>[]
  : Result extends object
    ? OverlayRow<Result, Node, Models, Name, Key>
    : Result;

type ProjectedMethod<
  O extends ProjectedOperation,
  C extends VibORMConfig,
  ModelName extends keyof ClientSchema<C>,
  ClientDefaults,
  Controls,
  Models extends ProjectionModelsConstraint,
  Key extends string,
  Pending extends boolean = true,
  M extends Model<any> = ClientSchema<C>[ModelName],
  Payload = OperationPayload<O, M>,
  Placed = PlacedOperationControls<Controls, ModelName, O>,
> = <
  Arg extends ProjectedArgs<
    Exclude<Payload, undefined>,
    Models,
    ModelName,
    Key
  >,
>(
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
) => ProjectedCarrier<
  Overlay<
    ContextualOperationResult<
      C,
      ModelName,
      O,
      WithoutKey<Arg, Key>,
      ClientDefaults
    >,
    Arg,
    Models,
    ModelName,
    Key
  >,
  Pending
>;

type ProjectedCarrier<Result, Pending extends boolean> = Pending extends true
  ? PendingOperation<Result>
  : Promise<Result>;

/** Type-only projection facts retained when a cached view changes the carrier. */
declare const projectedModelState: unique symbol;

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
    readonly [projectedModelState]?: {
      readonly [Key in KeyOf<Verbs>]: ProjectionModels<C, Verbs>;
    };
  } & {
    readonly [O in ProjectedOperation]: ProjectedMethod<
      O,
      C,
      ModelName,
      ClientDefaults,
      Controls,
      ProjectionModels<C, Verbs>,
      KeyOf<Verbs>
    >;
  };
};

/** Cached views retain projections, but expose only read operations and Promises. */
export type CachedProjectedOperations<
  C extends VibORMConfig,
  ModelName extends keyof ClientSchema<C>,
  ClientDefaults,
  Controls,
  ModelMethods,
> = typeof projectedModelState extends keyof ModelMethods
  ? NonNullable<
      ModelMethods[typeof projectedModelState]
    > extends infer Projections extends Record<
      string,
      ProjectionModelsConstraint
    >
    ? UnionToIntersection<
        {
          [Key in keyof Projections & string]: {
            readonly [O in Extract<
              ProjectedOperation,
              CacheableOperations
            >]: ProjectedMethod<
              O,
              C,
              ModelName,
              ClientDefaults,
              Controls,
              Projections[Key],
              Key,
              false
            >;
          };
        }[keyof Projections & string]
      >
    : unknown
  : unknown;

type UnionToIntersection<Value> = (
  Value extends unknown
    ? (value: Value) => void
    : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

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
