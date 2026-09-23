import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import { defaultOmit } from "@client/default-omit-extension";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type IsOptional<Type, Key extends keyof Type> = Record<
  never,
  never
> extends Pick<Type, Key>
  ? true
  : false;
/** Mutual assignability: the agreement two spellings of a recursive type can reach. */
type Agree<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

const node = s.model({
  id: s.string().id(),
  label: s.string(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => node)
    .name("Tree")
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => node).name("Tree"),
});

const graphNode = s.model({
  id: s.string().id(),
  label: s.string(),
  links: s.toMany(() => graphNode).name("Graph"),
  linkedBy: s.toMany(() => graphNode).name("Graph"),
});

const person = s.model({
  id: s.string().id(),
  mateId: s.string().nullable().unique(),
  mate: s
    .toOne(() => person)
    .name("Mate")
    .fields("mateId")
    .references("id"),
  mateOf: s.toOne(() => person).name("Mate"),
});

const keyless = s.model({
  code: s.string().unique(),
  parentCode: s.string().nullable(),
  parent: s
    .toOne(() => keyless)
    .name("KeylessTree")
    .fields("parentCode")
    .references("code"),
  children: s.toMany(() => keyless).name("KeylessTree"),
});

// TypeScript has structural model identity. These two deliberately have the
// same declaration surface; runtime admission still compares their objects.
const left = s.model({
  id: s.string().id(),
  links: s.toMany(() => right).name("Lookalike"),
  linkedBy: s.toMany(() => right).name("LookalikeBack"),
});

const right = s.model({
  id: s.string().id(),
  links: s.toMany(() => left).name("Lookalike"),
  linkedBy: s.toMany(() => left).name("LookalikeBack"),
});

const forest = s.model({
  id: s.string().id(),
  rootId: s.string().nullable(),
  root: s
    .toOne(() => forestNode)
    .name("ForestRoot")
    .fields("rootId")
    .references("id"),
});

const forestNode = s.model({
  id: s.string().id(),
  label: s.string(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => forestNode)
    .name("ForestTree")
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => forestNode).name("ForestTree"),
  forests: s.toMany(() => forest).name("ForestRoot"),
});

const compoundNode = s
  .model({
    tenantId: s.string().map("tenant_id"),
    localId: s.string().map("local_id"),
    label: s.string(),
    parentTenantId: s.string().nullable().map("parent_tenant_id"),
    parentLocalId: s.string().nullable().map("parent_local_id"),
    parent: s
      .toOne(() => compoundNode)
      .name("CompoundTree")
      .fields("parentTenantId", "parentLocalId")
      .references("tenantId", "localId"),
    children: s.toMany(() => compoundNode).name("CompoundTree"),
  })
  .id(["tenantId", "localId"], { name: "compound_node_pk" });

// A self VARIANT carrier and the inverse bound to its storage recurse on no
// ordinary edge, so neither exposes a recursive node.
const thread = s.model({
  id: s.string().id(),
  replyTo: s
    .toOne({ thread: () => thread }, { values: { thread: "thread.reply.v1" } })
    .name("ThreadReply")
    .optional(),
  replies: s.toMany(() => thread).name("ThreadReply"),
});

// A widened relation name is a pairing TypeScript cannot prove. The runtime
// resolver pairs the value and admits recursion; the static view fails closed.
const widenedName: string = "WidenedTree";
const widenedNode = s.model({
  id: s.string().id(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => widenedNode)
    .name(widenedName)
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => widenedNode).name(widenedName),
});

// Recursive slots reached through variant arms: a collection's `variants` and
// a to-one discriminator map.
const shelf = s.model({
  id: s.string().id(),
  items: s
    .toMany({ folder: () => folder }, { values: { folder: "shelf.folder.v1" } })
    .name("ShelfItems"),
  pinned: s
    .toOne({ folder: () => folder }, { values: { folder: "shelf.pin.v1" } })
    .name("ShelfPin")
    .optional(),
});

const folder = s.model({
  id: s.string().id(),
  name: s.string(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => folder)
    .name("FolderTree")
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => folder).name("FolderTree"),
  shelves: s.toMany(() => shelf).name("ShelfItems"),
  pinnedOn: s.toMany(() => shelf).name("ShelfPin"),
});

const schema = {
  node,
  graphNode,
  person,
  keyless,
  left,
  right,
  forest,
  forestNode,
  compoundNode,
  thread,
  widenedNode,
  shelf,
  folder,
};

const client = createClient({ schema, driver: new PGliteDriver() });

// =============================================================================
// RESULT SHAPES — one ordinary node wrapped once, per depth form
// =============================================================================

const bounded = () =>
  client.node.findMany({
    include: { children: { recurse: { depth: 4 } } },
  });
type BoundedNode = Awaited<
  ReturnType<typeof bounded>
>[number]["children"][number];
type _boundedChildIsOptional = Expect<
  Equal<IsOptional<BoundedNode, "children">, true>
>;
type _boundedRepeatsTheOrdinaryProjection = Expect<
  Equal<NonNullable<BoundedNode["children"]>[number]["label"], string>
>;

const exhaustive = () =>
  client.node.findMany({
    select: {
      children: {
        recurse: { depth: false },
        select: { id: true, label: true },
      },
    },
  });
type ExhaustiveNode = Awaited<
  ReturnType<typeof exhaustive>
>[number]["children"][number];
type _exhaustiveChildIsRequired = Expect<
  Equal<IsOptional<ExhaustiveNode, "children">, false>
>;
type _exhaustiveProjectionRepeats = Expect<
  Equal<ExhaustiveNode["children"][number]["label"], string>
>;

const recurseDepth: number = 5;
const widened = () =>
  client.node.findMany({
    include: { children: { recurse: { depth: recurseDepth } } },
  });
type WidenedNode = Awaited<
  ReturnType<typeof widened>
>[number]["children"][number];
type _widenedDepthStaysBounded = Expect<
  Equal<IsOptional<WidenedNode, "children">, true>
>;

// A depth that may be `false` is not a proof of exhaustive traversal.
const maybeExhaustiveDepth = recurseDepth > 3 ? false : recurseDepth;
const maybeExhaustive = () =>
  client.node.findMany({
    include: { children: { recurse: { depth: maybeExhaustiveDepth } } },
  });
type MaybeExhaustiveNode = Awaited<
  ReturnType<typeof maybeExhaustive>
>[number]["children"][number];
type _widenedExhaustiveStaysBounded = Expect<
  Equal<IsOptional<MaybeExhaustiveNode, "children">, true>
>;

// Neither is a recurse value that may be absent or a union of both forms.
const maybeRecurse = recurseDepth > 3 ? { depth: false as const } : undefined;
const optionalRecurse = () =>
  client.node.findMany({
    include: { children: { recurse: maybeRecurse } },
  });
type OptionalRecurseNode = Awaited<
  ReturnType<typeof optionalRecurse>
>[number]["children"][number];
type _optionalRecurseStaysBounded = Expect<
  Equal<IsOptional<OptionalRecurseNode, "children">, true>
>;

// `true` is not a depth, so a widened boolean is no depth either.
client.node.findMany({
  include: {
    // @ts-expect-error - `depth: boolean` admits `true`, which no traversal means
    children: { recurse: { depth: false as boolean } },
  },
});

// `recurse: undefined` is ordinary omission: the plain node, key unchanged.
const undefinedRecurse = () =>
  client.node.findMany({
    include: { children: { recurse: undefined, take: 2 } },
  });
const plainChildren = () =>
  client.node.findMany({ include: { children: { take: 2 } } });
type _undefinedRecurseIsThePlainNode = Expect<
  Equal<
    Awaited<ReturnType<typeof undefinedRecurse>>,
    Awaited<ReturnType<typeof plainChildren>>
  >
>;

client.node.findMany({
  // @ts-expect-error - `recurse: false` is not an admitted spelling
  include: { children: { recurse: false } },
});

const parent = () =>
  client.node.findMany({ include: { parent: { recurse: true } } });
type ParentNode = NonNullable<
  Awaited<ReturnType<typeof parent>>[number]["parent"]
>;
type _boundedParentStaysOptionalAndNullable = Expect<
  Equal<IsOptional<ParentNode, "parent">, true>
>;
type _parentValueRetainsSlotEmptiness = Expect<
  Equal<null extends ParentNode["parent"] ? true : false, true>
>;

// An ordinary relation may open a projection that contains a recursive slot.
const ordinaryThenRecursive = () =>
  client.forest.findMany({
    include: {
      root: { include: { children: { recurse: { depth: 2 } } } },
    },
  });
type ForestRoot = NonNullable<
  Awaited<ReturnType<typeof ordinaryThenRecursive>>[number]["root"]
>;
type _ordinaryThenRecursiveRepeats = Expect<
  Equal<ForestRoot["children"][number]["label"], string>
>;

// The ordinary node inferred for one recurrence may itself contain another
// recurrence without expanding either request into a depth-sized type.
const recursiveInsideRecursive = () =>
  client.node.findMany({
    include: {
      children: {
        recurse: { depth: 3 },
        include: { parent: { recurse: { depth: 2 } } },
      },
    },
  });
type NestedParent = NonNullable<
  Awaited<
    ReturnType<typeof recursiveInsideRecursive>
  >[number]["children"][number]["parent"]
>;
type _recursiveInsideRecursiveRepeats = Expect<
  Equal<NonNullable<NestedParent["parent"]>["label"], string>
>;

// Physical column mappings do not weaken a complete compound row key.
const mappedCompound = () =>
  client.compoundNode.findMany({
    include: { children: { recurse: { depth: 2 } } },
  });
type CompoundChild = Awaited<
  ReturnType<typeof mappedCompound>
>[number]["children"][number];
type _mappedCompoundKeyRepeats = Expect<
  Equal<CompoundChild["tenantId"], string>
>;

// A node whose `select` may be undefined keeps BOTH worlds of the ordinary
// node under the recursive wrapper.
const maybeSelect = recurseDepth > 3 ? { label: true as const } : undefined;
const unionNode = () =>
  client.node.findMany({
    include: { children: { recurse: { depth: 2 }, select: maybeSelect } },
  });
type UnionChild = Awaited<
  ReturnType<typeof unionNode>
>[number]["children"][number];
type _unionKeepsTheDefaultRow = Expect<
  Equal<
    [Extract<UnionChild, { parentId: string | null }>] extends [never]
      ? false
      : true,
    true
  >
>;
type _unionKeepsTheSelectedRow = Expect<
  Equal<IsOptional<UnionChild, "children">, true>
>;

// =============================================================================
// PLACEMENTS AND ELIGIBILITY
// =============================================================================

// Both directions of a self one-to-one edge are admitted.
client.person.findMany({ include: { mate: { recurse: true } } });
client.person.findMany({ include: { mateOf: { recurse: { depth: 2 } } } });

// A graph edge owns cycle policy; exhaustive traversal keeps prevention on.
client.graphNode.findMany({
  include: { links: { recurse: { depth: 3, preventCycles: false } } },
});
client.graphNode.findMany({
  include: { links: { recurse: { depth: false, preventCycles: true } } },
});
client.graphNode.findMany({
  select: { linkedBy: { recurse: true, select: { id: true } } },
});

// The field maps and cardinalities are structurally indistinguishable, but the
// existing mutual-partner proof still fails closed on this recursive pair.
// @ts-expect-error - runtime model identity is not statically proven
client.left.findMany({ include: { links: { recurse: true } } });

// A pairing TypeScript cannot prove fails closed; the runtime still admits it.
// @ts-expect-error - a widened relation name proves no pairing statically
client.widenedNode.findMany({ include: { children: { recurse: true } } });

// @ts-expect-error - a variant carrier has no ordinary edge to recurse on
client.thread.findMany({ include: { replyTo: { recurse: true } } });
// @ts-expect-error - neither has the inverse bound to its variant storage
client.thread.findMany({ include: { replies: { recurse: true } } });

// Every row-returning public operation reaches the same Source/Key-aware core.
client.node.findUnique({
  where: { id: "node" },
  include: { children: { recurse: true } },
});
client.node.findUniqueOrThrow({
  where: { id: "node" },
  include: { children: { recurse: true } },
});
client.node.findFirst({ include: { children: { recurse: true } } });
client.node.findFirstOrThrow({ include: { children: { recurse: true } } });
client.node.create({
  data: { id: "node", label: "Node", parentId: null },
  include: { children: { recurse: true } },
});
client.node.update({
  where: { id: "node" },
  data: { label: "Node" },
  include: { children: { recurse: true } },
});
client.node.delete({
  where: { id: "node" },
  include: { children: { recurse: true } },
});
client.node.upsert({
  where: { id: "node" },
  create: { id: "node", label: "Node", parentId: null },
  update: { label: "Node" },
  include: { children: { recurse: true } },
});

// The bulk projection is scalar-only, so it has no relation node to recurse.
client.node.updateMany({
  data: { label: "Node" },
  // @ts-expect-error - a bulk row projection names scalars only
  select: { id: true, children: { recurse: true } },
});

// @ts-expect-error - a complete primary key is required
client.keyless.findMany({ include: { children: { recurse: true } } });

// @ts-expect-error - recursive list pagination has no path-local meaning
client.node.findMany({ include: { children: { recurse: true, take: 1 } } });
// @ts-expect-error - nor has an offset
client.node.findMany({ include: { children: { recurse: true, skip: 1 } } });
client.node.findMany({
  include: {
    // @ts-expect-error - nor a cursor
    children: { recurse: true, cursor: { id: "node" } },
  },
});
client.node.findMany({
  // @ts-expect-error - nor distinct rows
  include: { children: { recurse: true, distinct: ["label"] } },
});

client.node.findMany({
  // @ts-expect-error - FK recursion has no caller-selectable cycle flag
  include: { children: { recurse: { depth: 3, preventCycles: false } } },
});

client.graphNode.findMany({
  // @ts-expect-error - exhaustive graph recursion cannot allow cycles
  include: { links: { recurse: { depth: false, preventCycles: false } } },
});

client.node.findMany({
  include: {
    // @ts-expect-error - the asking key is projected automatically
    children: { recurse: true, include: { children: true } },
  },
});

client.node.findMany({
  select: {
    // @ts-expect-error - in either projection of its own node
    children: { recurse: true, select: { id: true, children: true } },
  },
});

// =============================================================================
// EXACT OPTIONS — a misspelled or forbidden key beside a real one, any depth
// =============================================================================

client.node.findMany({
  include: {
    children: {
      // @ts-expect-error - the typo is refused beside the real depth key
      recurse: { depth: 2, depths: 3 },
    },
  },
});

const forbiddenFkCycleFlag = {
  include: {
    children: { recurse: { depth: 3, preventCycles: false } },
  },
} as const;
// @ts-expect-error - the FK flag is refused after argument forwarding too
client.node.findMany(forbiddenFkCycleFlag);

const misspelledRecurrenceOption = {
  include: {
    children: { recurse: { depth: 2, depths: 3 } },
  },
} as const;
// @ts-expect-error - the typo is refused after argument forwarding too
client.node.findMany(misspelledRecurrenceOption);

client.forest.findMany({
  include: {
    root: {
      include: {
        children: {
          // @ts-expect-error - a nested FK recurse has no cycle flag
          recurse: { depth: 2, preventCycles: false },
        },
      },
    },
  },
});

client.node.findMany({
  include: {
    children: {
      recurse: true,
      include: {
        // @ts-expect-error - nested typo is refused beside the real depth key
        parent: {
          recurse: { depth: 2, depths: 3 },
        },
      },
    },
  },
});

const nestedMisspelledRecurrenceOption = {
  include: {
    children: {
      recurse: true,
      include: {
        parent: { recurse: { depth: 2, depths: 3 } },
      },
    },
  },
} as const;
// @ts-expect-error - the nested typo is refused after argument forwarding too
client.node.findMany(nestedMisspelledRecurrenceOption);

const nestedForbiddenFkCycleFlag = {
  include: {
    root: {
      include: {
        children: { recurse: { depth: 2, preventCycles: false } },
      },
    },
  },
} as const;
// @ts-expect-error - the nested FK flag is refused after forwarding too
client.forest.findMany(nestedForbiddenFkCycleFlag);

// Three relations deep, in both projections, fresh and held in a variable.
client.forest.findMany({
  include: {
    root: {
      include: {
        // @ts-expect-error - a third-level typo beside the real depth key
        children: {
          recurse: true,
          include: { parent: { recurse: { depth: 2, depths: 3 } } },
        },
      },
    },
  },
});

client.forest.findMany({
  select: {
    root: {
      select: {
        // @ts-expect-error - the same typo under select placements
        children: {
          recurse: true,
          select: { parent: { recurse: { depth: 2, depths: 3 } } },
        },
      },
    },
  },
});

client.forest.findMany({
  include: {
    root: {
      include: {
        children: {
          recurse: true,
          include: {
            // @ts-expect-error - a third-level FK cycle flag
            parent: { recurse: { depth: 2, preventCycles: false } },
          },
        },
      },
    },
  },
});

const thirdLevelTypo = {
  include: {
    root: {
      include: {
        children: {
          recurse: true as const,
          include: { parent: { recurse: { depth: 2, depths: 3 } } },
        },
      },
    },
  },
};
// @ts-expect-error - a widened (non-const) variable is sealed too
client.forest.findMany(thirdLevelTypo);

// Arms of a variant projection are relation nodes as well.
client.shelf.findMany({
  include: {
    items: {
      variants: {
        // @ts-expect-error - a typo inside a collection's variant arm
        folder: { include: { children: { recurse: { depth: 1, dept: 2 } } } },
      },
    },
  },
});
client.shelf.findMany({
  include: {
    pinned: {
      // @ts-expect-error - a typo inside a to-one discriminator arm
      folder: { include: { children: { recurse: { depth: 1, dept: 2 } } } },
    },
  },
});
client.shelf.findMany({
  include: {
    items: {
      variants: { folder: { include: { children: { recurse: true } } } },
    },
    pinned: { folder: { include: { parent: { recurse: { depth: 2 } } } } },
  },
});

// Valid deep spellings stay open, including counts beside recursive slots.
const deepValid = {
  include: {
    root: {
      select: {
        label: true,
        children: {
          recurse: { depth: false },
          select: { label: true, parent: { recurse: { depth: 2 } } },
        },
        _count: { select: { children: true } },
      },
    },
  },
} as const;
const deepValidCall = () => client.forest.findMany(deepValid);
type DeepValidRoot = NonNullable<
  Awaited<ReturnType<typeof deepValidCall>>[number]["root"]
>;
type _deepValidIsExhaustive = Expect<
  Equal<IsOptional<DeepValidRoot["children"][number], "children">, false>
>;

// =============================================================================
// GENERIC WRAPPERS
// =============================================================================

// A wrapper generic over the depth infers per call site.
function treeWithDepth<const Depth extends number | false>(depth: Depth) {
  return client.node.findMany({
    include: { children: { recurse: { depth } } },
  });
}
const exhaustiveWrapper = () => treeWithDepth(false);
type ExhaustiveWrapperNode = Awaited<
  ReturnType<typeof exhaustiveWrapper>
>[number]["children"][number];
type _genericExhaustiveIsRequired = Expect<
  Equal<IsOptional<ExhaustiveWrapperNode, "children">, false>
>;
const boundedWrapper = () => treeWithDepth(3);
type BoundedWrapperNode = Awaited<
  ReturnType<typeof boundedWrapper>
>[number]["children"][number];
type _genericBoundedIsOptional = Expect<
  Equal<IsOptional<BoundedWrapperNode, "children">, true>
>;

// A wrapper generic over an ordinary node keeps compiling: the guard walks the
// literal and names boolean leaves, so a constraint of scalar leaves passes.
function childrenWith<Node extends { select?: { label?: true } }>(
  children: Node
) {
  return client.node.findMany({ include: { children } });
}
childrenWith({ select: { label: true } });

// A wrapper generic over the whole option bag cannot prove its bag free of a
// misspelled key, so it is refused; spell the bag and keep the depth generic.
function treeWithBag<const Bag extends true | { readonly depth?: number }>(
  recurse: Bag
) {
  return client.node.findMany({
    // @ts-expect-error - an unproven generic bag may carry a misspelled key
    include: { children: { recurse } },
  });
}
treeWithBag(true);

// =============================================================================
// CLIENT SURFACES — transactions, extension chains, cache, default omit
// =============================================================================

const transactional = () =>
  client.$transaction(async (tx) =>
    tx.node.findMany({ include: { children: { recurse: { depth: false } } } })
  );
type TransactionNode = Awaited<
  ReturnType<typeof transactional>
>[number]["children"][number];
type _transactionIsExhaustive = Expect<
  Equal<IsOptional<TransactionNode, "children">, false>
>;
const _transactionTypo = () =>
  client.$transaction(async (tx) =>
    tx.node.findMany({
      include: {
        children: {
          // @ts-expect-error - the transaction client seals the bag too
          recurse: { depth: 2, depths: 3 },
        },
      },
    })
  );

const one = { name: "rq-one" } as const;
const extendedOnce = client.$extends(one);
const extendedFive = client
  .$extends(one)
  .$extends({ name: "rq-two" })
  .$extends({ name: "rq-three" })
  .$extends({ name: "rq-four" })
  .$extends({ name: "rq-five" });
const onceExtended = () =>
  extendedOnce.node.findMany({
    include: { children: { recurse: { depth: false } } },
  });
type OnceExtendedNode = Awaited<
  ReturnType<typeof onceExtended>
>[number]["children"][number];
type _oneExtensionIsExhaustive = Expect<
  Equal<IsOptional<OnceExtendedNode, "children">, false>
>;
const fiveExtended = () =>
  extendedFive.node.findMany({
    include: { children: { recurse: { depth: 3 } } },
  });
type FiveExtendedNode = Awaited<
  ReturnType<typeof fiveExtended>
>[number]["children"][number];
type _fiveExtensionsStayBounded = Expect<
  Equal<IsOptional<FiveExtendedNode, "children">, true>
>;
extendedFive.node.findMany({
  include: {
    children: {
      // @ts-expect-error - five extensions later the bag is still sealed
      recurse: { depth: 2, depths: 3 },
    },
  },
});

const cachedClient = client.$extends(cache({ driver: new MemoryCache() }));
const cachedRead = () =>
  cachedClient.$withCache().node.findMany({
    include: { children: { recurse: true } },
  });
type CachedNode = Awaited<
  ReturnType<typeof cachedRead>
>[number]["children"][number];
type _cachedReadStaysBounded = Expect<
  Equal<IsOptional<CachedNode, "children">, true>
>;
cachedClient.$withCache().node.findMany({
  include: {
    children: {
      // @ts-expect-error - the cached surface seals the bag too
      recurse: { depth: 2, depths: 3 },
    },
  },
});

// A client default omit reaches every repeated level through the one node.
const omitting = client.$extends(
  defaultOmit<typeof schema>()({ node: { label: true } })
);
const omittedRead = () =>
  omitting.node.findMany({
    include: { children: { recurse: { depth: false } } },
  });
type OmittedNode = Awaited<
  ReturnType<typeof omittedRead>
>[number]["children"][number];
type _defaultOmitAtTheFirstLevel = Expect<
  Equal<"label" extends keyof OmittedNode ? true : false, false>
>;
type _defaultOmitAtTheRepeatedLevel = Expect<
  Equal<
    "label" extends keyof OmittedNode["children"][number] ? true : false,
    false
  >
>;

// =============================================================================
// RENDERED TYPE TEXT — the schema-only renderer's declarations, verbatim
// =============================================================================

// `renderOperationResultType(schema, "node", "findMany", { select: { label:
// true, children: { recurse: { depth: 2 }, select: { label: true } } } })`
// renders exactly these declarations (pinned in
// tests/contracts/public-client/schema-introspection.core.test.ts). They must
// compile and agree with the client's own inferred result.
type VibORMOperationResult = Array<{
  label: string;
  // biome-ignore lint/style/useConsistentArrayType: verbatim renderer output.
  children: Array<VibORMRecursiveNode1>;
}>;
type VibORMRecursiveNode1 = {
  label: string;
  // biome-ignore lint/style/useConsistentArrayType: verbatim renderer output.
  children?: Array<VibORMRecursiveNode1>;
};
const renderedCall = () =>
  client.node.findMany({
    select: {
      label: true,
      children: { recurse: { depth: 2 }, select: { label: true } },
    },
  });
type _renderedTextAgrees = Expect<
  Agree<Awaited<ReturnType<typeof renderedCall>>, VibORMOperationResult>
>;
