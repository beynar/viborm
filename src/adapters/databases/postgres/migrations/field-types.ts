/**
 * PostgreSQL Field Type Mapping
 *
 * Maps ORM field types to PostgreSQL native types.
 */

export function mapFieldType(
  fieldType: string,
  options?: { array?: boolean; autoIncrement?: boolean }
): string {
  let baseType: string;

  switch (fieldType) {
    case "string":
      baseType = "text";
      break;
    case "int":
      baseType = options?.autoIncrement ? "serial" : "integer";
      break;
    case "float":
      baseType = "double precision";
      break;
    case "decimal":
      baseType = "numeric";
      break;
    case "boolean":
      baseType = "boolean";
      break;
    case "datetime":
      baseType = "timestamptz";
      break;
    case "date":
      baseType = "date";
      break;
    case "time":
      baseType = "time";
      break;
    case "bigint":
      baseType = options?.autoIncrement ? "bigserial" : "bigint";
      break;
    case "json":
      baseType = "jsonb";
      break;
    case "blob":
      baseType = "bytea";
      break;
    case "vector":
      baseType = "vector";
      break;
    case "point":
      baseType = "point";
      break;
    default:
      baseType = fieldType;
  }

  return options?.array ? `${baseType}[]` : baseType;
}
