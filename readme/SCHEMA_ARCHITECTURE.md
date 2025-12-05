# Schema Architecture

VibORM uses a **config-based, type-safe schema system** where field definitions are immutable and chainable.

## Core Concepts

```mermaid
classDiagram
    class BaseField~T, TConfig~ {
        +config: TConfig
        +~: FieldInternals~T~
        #cloneWith(override): BaseField
        +nullable(): BaseField
        +array(): BaseField
        +id(): BaseField
        +unique(): BaseField
        +default(value): BaseField
    }
    
    class StringField~T~ {
        +config: StringFieldConfig
        +uuid(): StringField
        +ulid(): StringField
        +cuid(): StringField
        +validator(v): StringField
    }
    
    class NumberField~T~ {
        +config: NumberFieldConfig
        +int(): NumberField
        +float(): NumberField
        +autoIncrement(): NumberField
    }
    
    class Relation~G, T~ {
        +config: RelationConfig
        +~: RelationInternals
        +getter: () => Model
    }
    
    BaseField <|-- StringField
    BaseField <|-- NumberField
    BaseField <|-- BooleanField
    BaseField <|-- BigIntField
    BaseField <|-- DateTimeField
    BaseField <|-- JsonField
    BaseField <|-- BlobField
    BaseField <|-- EnumField
    BaseField <|-- VectorField
```

## Two Namespaces: `config` vs `~`

Each field has two property namespaces:

| Namespace | Purpose | Example |
|-----------|---------|---------|
| `config` | Runtime configuration (serializable) | `field.config.isOptional`, `field.config.fieldType` |
| `~` | Type inference & validators (lazy) | `field["~"].infer`, `field["~"].createValidator` |

```typescript
const email = s.string().nullable();

// Config (runtime values)
email.config.fieldType   // "string"
email.config.isOptional  // true

// Internals (type-level + validators)
email["~"].infer         // string | null (TypeScript type)
email["~"].createValidator.parse("test@example.com")  // Zod validation
```

## Chainable API Flow

```mermaid
flowchart LR
    A["s.string()"] --> B["StringField&lt;DefaultState&gt;"]
    B -->|".nullable()"| C["StringField&lt;MakeNullable&gt;"]
    C -->|".id()"| D["StringField&lt;MakeId&gt;"]
    D -->|".uuid()"| E["StringField&lt;MakeAuto&gt;"]
    
    style A fill:#f9f,stroke:#333
    style E fill:#9f9,stroke:#333
```

Each method returns a **new instance** with updated config and transformed generic type `T`:

```typescript
// Each call creates a new instance via cloneWith()
const field = s.string()      // StringField<DefaultFieldState<string>>
  .nullable()                  // StringField<MakeNullable<...>>
  .id()                        // StringField<MakeId<...>>
  .uuid();                     // StringField<MakeAuto<..., "uuid">>
```

## Type State Machine

The generic `T` tracks field state through type transformations:

```mermaid
stateDiagram-v2
    [*] --> DefaultFieldState: s.string()
    DefaultFieldState --> MakeNullable: .nullable()
    DefaultFieldState --> MakeId: .id()
    DefaultFieldState --> MakeUnique: .unique()
    DefaultFieldState --> MakeArray: .array()
    DefaultFieldState --> MakeDefault: .default(v)
    DefaultFieldState --> MakeAuto: .uuid() / .now()
    
    MakeNullable --> MakeId: .id()
    MakeId --> MakeAuto: .uuid()
```

```typescript
// FieldState tracks 6 dimensions:
interface FieldState<
  BaseType,      // string, number, Date, etc.
  IsNullable,    // true | false
  IsArray,       // true | false  
  IsId,          // true | false
  IsUnique,      // true | false
  HasDefault     // true | false
> { ... }
```

## Relations

```mermaid
flowchart TB
    subgraph "Relation Types"
        O2O["oneToOne"]
        O2M["oneToMany"]
        M2O["manyToOne"]
        M2M["manyToMany"]
    end
    
    subgraph "Config"
        RC["RelationConfig"]
        RC --> |contains| RT["relationType"]
        RC --> |contains| JT["junctionTable?"]
        RC --> |contains| CO["cascadeOptions?"]
    end
    
    O2O --> RC
    O2M --> RC
    M2O --> RC
    M2M --> RC
```

```typescript
const user = s.model("user", {
  id: s.string().id().uuid(),
  posts: s.relation.oneToMany(() => post),
  profile: s.relation.oneToOne(() => profile),
});

const post = s.model("post", {
  id: s.string().id().uuid(),
  author: s.relation.manyToOne(() => user),
  tags: s.relation.manyToMany(() => tag),
});
```

## Inheritance Pattern

```mermaid
flowchart TB
    subgraph "BaseField (shared logic)"
        CW["cloneWith()"]
        CM["nullable() / array() / id() / unique() / default()"]
        INT["~ internals initialization"]
    end
    
    subgraph "Subclass (type-specific)"
        OV["Override methods for return type narrowing"]
        SP["Type-specific methods (uuid, int, now...)"]
        CF["Config with fieldType"]
    end
    
    CW --> OV
    CM --> OV
    OV --> SP
```

**Key pattern:** Subclasses override common methods with one-liner casts for return type narrowing:

```typescript
// In StringField
override nullable(): StringField<MakeNullable<T>> {
  return super.nullable() as StringField<MakeNullable<T>>;
}
```

## Quick Reference

```typescript
import { s } from "viborm";

// Scalar fields
s.string()           // StringField
s.number() / s.int() / s.float() / s.decimal()
s.boolean()
s.bigint()
s.datetime()
s.json(zodSchema?)   // JsonField with optional validation
s.blob()
s.enumField(["A", "B", "C"])
s.vector(dimensions?)

// Modifiers (chainable)
.nullable()          // Allow null
.array()             // Make array type
.id()                // Primary key
.unique()            // Unique constraint
.default(value)      // Default value

// Auto-generation
.uuid() / .ulid() / .nanoid() / .cuid()  // String IDs
.autoIncrement()     // Number/BigInt IDs
.now() / .updatedAt() // DateTime

// Relations
s.relation.oneToOne(() => Model)
s.relation.oneToMany(() => Model)
s.relation.manyToOne(() => Model)
s.relation.manyToMany(() => Model)

// With options
s.relation({ onDelete: "CASCADE", junctionTable: "custom_name" })
  .manyToMany(() => Model)
```



