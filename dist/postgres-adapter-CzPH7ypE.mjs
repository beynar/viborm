import{t as e}from"./sql-CFtZ-oR0.mjs";function t(e){switch(e){case`CASCADE`:return`cascade`;case`SET NULL`:return`setNull`;case`RESTRICT`:return`restrict`;case`SET DEFAULT`:return`setDefault`;case`NO ACTION`:default:return`noAction`}}function n(e){let t=e.udt_name.startsWith(`_`)?e.udt_name.slice(1)+`[]`:e.udt_name;return e.data_type===`character varying`&&e.character_maximum_length?`varchar(${e.character_maximum_length})`:e.data_type===`character`&&e.character_maximum_length?`char(${e.character_maximum_length})`:e.data_type===`numeric`&&e.numeric_precision?e.numeric_scale?`numeric(${e.numeric_precision},${e.numeric_scale})`:`numeric(${e.numeric_precision})`:t}function r(e){return e?e.includes(`nextval(`)||e.includes(`_seq'::regclass)`):!1}function i(e){if(e&&!r(e))return e.replace(/::\w+(\[\])?$/,``).trim()}async function a(e){let[a,o,s,c,l,u,d]=await Promise.all([e(`
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;
`),e(`
SELECT
  c.table_name,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default,
  c.character_maximum_length,
  c.numeric_precision,
  c.numeric_scale
FROM information_schema.columns c
JOIN information_schema.tables t
  ON c.table_name = t.table_name
  AND c.table_schema = t.table_schema
WHERE c.table_schema = 'public'
  AND t.table_type = 'BASE TABLE'
ORDER BY c.table_name, c.ordinal_position;
`),e(`
SELECT
  tc.table_name,
  tc.constraint_name,
  kcu.column_name,
  kcu.ordinal_position
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
WHERE tc.table_schema = 'public'
  AND tc.constraint_type = 'PRIMARY KEY'
ORDER BY tc.table_name, kcu.ordinal_position;
`),e(`
SELECT
  t.relname AS table_name,
  i.relname AS index_name,
  a.attname AS column_name,
  ix.indisunique AS is_unique,
  am.amname AS index_type,
  pg_get_expr(ix.indpred, ix.indrelid) AS filter_condition,
  array_position(ix.indkey, a.attnum) AS ordinal_position
FROM pg_index ix
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_am am ON am.oid = i.relam
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
WHERE n.nspname = 'public'
  AND NOT ix.indisprimary
  AND t.relkind = 'r'
ORDER BY t.relname, i.relname, array_position(ix.indkey, a.attnum);
`),e(`
SELECT
  tc.table_name,
  tc.constraint_name,
  kcu.column_name,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name,
  rc.delete_rule,
  rc.update_rule,
  kcu.ordinal_position
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name
  AND ccu.table_schema = tc.table_schema
JOIN information_schema.referential_constraints rc
  ON rc.constraint_name = tc.constraint_name
  AND rc.constraint_schema = tc.table_schema
WHERE tc.table_schema = 'public'
  AND tc.constraint_type = 'FOREIGN KEY'
ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position;
`),e(`
SELECT
  tc.table_name,
  tc.constraint_name,
  kcu.column_name,
  kcu.ordinal_position
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
WHERE tc.table_schema = 'public'
  AND tc.constraint_type = 'UNIQUE'
ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position;
`),e(`
SELECT
  t.typname AS enum_name,
  e.enumlabel AS enum_value,
  e.enumsortorder AS sort_order
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
ORDER BY t.typname, e.enumsortorder;
`)]),f=new Map;for(let e of o.rows){let t=f.get(e.table_name)||[];t.push(e),f.set(e.table_name,t)}let p=new Map;for(let e of s.rows){let t=p.get(e.table_name)||[];t.push(e),p.set(e.table_name,t)}let m=new Map;for(let e of c.rows){m.has(e.table_name)||m.set(e.table_name,new Map);let t=m.get(e.table_name),n=t.get(e.index_name)||[];n.push(e),t.set(e.index_name,n)}let h=new Map;for(let e of l.rows){h.has(e.table_name)||h.set(e.table_name,new Map);let t=h.get(e.table_name),n=t.get(e.constraint_name)||[];n.push(e),t.set(e.constraint_name,n)}let g=new Map;for(let e of u.rows){g.has(e.table_name)||g.set(e.table_name,new Map);let t=g.get(e.table_name),n=t.get(e.constraint_name)||[];n.push(e),t.set(e.constraint_name,n)}let _=new Map;for(let e of d.rows){let t=_.get(e.enum_name)||[];t.push(e),_.set(e.enum_name,t)}let v=[];for(let e of a.rows){let a=e.table_name,o=(f.get(a)||[]).map(e=>({name:e.column_name,type:n(e),nullable:e.is_nullable===`YES`,default:i(e.column_default),autoIncrement:r(e.column_default)})),s,c=p.get(a);c&&c.length>0&&(c.sort((e,t)=>e.ordinal_position-t.ordinal_position),s={columns:c.map(e=>e.column_name),name:c[0].constraint_name});let l=[],u=m.get(a);if(u)for(let[e,t]of u){t.sort((e,t)=>e.ordinal_position-t.ordinal_position);let n=t[0];l.push({name:e,columns:t.map(e=>e.column_name),unique:n.is_unique,type:n.index_type,where:n.filter_condition||void 0})}let d=[],_=h.get(a);if(_)for(let[e,n]of _){n.sort((e,t)=>e.ordinal_position-t.ordinal_position);let r=n[0];d.push({name:e,columns:n.map(e=>e.column_name),referencedTable:r.foreign_table_name,referencedColumns:n.map(e=>e.foreign_column_name),onDelete:t(r.delete_rule),onUpdate:t(r.update_rule)})}let y=[],b=g.get(a);if(b)for(let[e,t]of b)t.sort((e,t)=>e.ordinal_position-t.ordinal_position),y.push({name:e,columns:t.map(e=>e.column_name)});v.push({name:a,columns:o,primaryKey:s,indexes:l,foreignKeys:d,uniqueConstraints:y})}let y=[];for(let[e,t]of _)t.sort((e,t)=>e.sort_order-t.sort_order),y.push({name:e,values:t.map(e=>e.enum_value)});return{tables:v,enums:y.length>0?y:void 0}}function o(e){return`"${e.replace(/"/g,`""`)}"`}function s(e){return`'${e.replace(/'/g,`''`)}'`}function c(e){switch(e){case`cascade`:return`CASCADE`;case`setNull`:return`SET NULL`;case`restrict`:return`RESTRICT`;case`setDefault`:return`SET DEFAULT`;case`noAction`:default:return`NO ACTION`}}function l(e){let t=[o(e.name)];return e.autoIncrement?e.type===`integer`||e.type===`int4`?t.push(`SERIAL`):e.type===`bigint`||e.type===`int8`?t.push(`BIGSERIAL`):e.type===`smallint`||e.type===`int2`?t.push(`SMALLSERIAL`):t.push(e.type):t.push(e.type),e.nullable||t.push(`NOT NULL`),e.default!==void 0&&!e.autoIncrement&&t.push(`DEFAULT ${e.default}`),t.join(` `)}function u(e){switch(e.type){case`createTable`:{let{table:t}=e,n=t.columns.map(l);if(t.primaryKey){let e=t.primaryKey.columns.map(o).join(`, `),r=t.primaryKey.name?`CONSTRAINT ${o(t.primaryKey.name)} `:``;n.push(`${r}PRIMARY KEY (${e})`)}for(let e of t.uniqueConstraints){let t=e.columns.map(o).join(`, `);n.push(`CONSTRAINT ${o(e.name)} UNIQUE (${t})`)}let r=[`CREATE TABLE ${o(t.name)} (\n  ${n.join(`,
  `)}\n)`];for(let e of t.indexes)r.push(u({type:`createIndex`,tableName:t.name,index:e}));for(let e of t.foreignKeys)r.push(u({type:`addForeignKey`,tableName:t.name,fk:e}));return r.join(`;
`)}case`dropTable`:return`DROP TABLE ${o(e.tableName)} CASCADE`;case`renameTable`:return`ALTER TABLE ${o(e.from)} RENAME TO ${o(e.to)}`;case`addColumn`:{let t=l(e.column);return`ALTER TABLE ${o(e.tableName)} ADD COLUMN ${t}`}case`dropColumn`:return`ALTER TABLE ${o(e.tableName)} DROP COLUMN ${o(e.columnName)}`;case`renameColumn`:return`ALTER TABLE ${o(e.tableName)} RENAME COLUMN ${o(e.from)} TO ${o(e.to)}`;case`alterColumn`:{let{tableName:t,columnName:n,from:r,to:i}=e,a=[],s=o(t),c=o(n);return r.type!==i.type&&a.push(`ALTER TABLE ${s} ALTER COLUMN ${c} TYPE ${i.type} USING ${c}::${i.type}`),r.nullable!==i.nullable&&(i.nullable?a.push(`ALTER TABLE ${s} ALTER COLUMN ${c} DROP NOT NULL`):a.push(`ALTER TABLE ${s} ALTER COLUMN ${c} SET NOT NULL`)),r.default!==i.default&&(i.default===void 0?a.push(`ALTER TABLE ${s} ALTER COLUMN ${c} DROP DEFAULT`):a.push(`ALTER TABLE ${s} ALTER COLUMN ${c} SET DEFAULT ${i.default}`)),a.join(`;
`)}case`createIndex`:{let{tableName:t,index:n}=e,r=n.unique?`UNIQUE `:``,i=n.type?`USING ${n.type} `:``,a=n.columns.map(o).join(`, `),s=n.where?` WHERE ${n.where}`:``;return`CREATE ${r}INDEX ${o(n.name)} ON ${o(t)} ${i}(${a})${s}`}case`dropIndex`:return`DROP INDEX ${o(e.indexName)}`;case`addForeignKey`:{let{tableName:t,fk:n}=e,r=n.columns.map(o).join(`, `),i=n.referencedColumns.map(o).join(`, `),a=n.onDelete?` ON DELETE ${c(n.onDelete)}`:``,s=n.onUpdate?` ON UPDATE ${c(n.onUpdate)}`:``;return`ALTER TABLE ${o(t)} ADD CONSTRAINT ${o(n.name)} FOREIGN KEY (${r}) REFERENCES ${o(n.referencedTable)} (${i})${a}${s}`}case`dropForeignKey`:return`ALTER TABLE ${o(e.tableName)} DROP CONSTRAINT ${o(e.fkName)}`;case`addUniqueConstraint`:{let{tableName:t,constraint:n}=e,r=n.columns.map(o).join(`, `);return`ALTER TABLE ${o(t)} ADD CONSTRAINT ${o(n.name)} UNIQUE (${r})`}case`dropUniqueConstraint`:return`ALTER TABLE ${o(e.tableName)} DROP CONSTRAINT ${o(e.constraintName)}`;case`addPrimaryKey`:{let{tableName:t,primaryKey:n}=e,r=n.columns.map(o).join(`, `),i=n.name?o(n.name):o(`${t}_pkey`);return`ALTER TABLE ${o(t)} ADD CONSTRAINT ${i} PRIMARY KEY (${r})`}case`dropPrimaryKey`:return`ALTER TABLE ${o(e.tableName)} DROP CONSTRAINT ${o(e.constraintName)}`;case`createEnum`:{let{enumDef:t}=e,n=t.values.map(s).join(`, `);return`CREATE TYPE ${o(t.name)} AS ENUM (${n})`}case`dropEnum`:return`DROP TYPE ${o(e.enumName)}`;case`alterEnum`:{let{enumName:t,addValues:n,removeValues:r}=e,i=[];if(n)for(let e of n)i.push(`ALTER TYPE ${o(t)} ADD VALUE ${s(e)}`);return r&&r.length>0&&i.push(`-- WARNING: Removing enum values requires recreating the type. Values to remove: ${r.join(`, `)}`),i.join(`;
`)}default:throw Error(`Unknown operation type: ${e.type}`)}}function d(e,t){let n;switch(e){case`string`:n=`text`;break;case`int`:n=t?.autoIncrement?`serial`:`integer`;break;case`float`:n=`double precision`;break;case`decimal`:n=`numeric`;break;case`boolean`:n=`boolean`;break;case`datetime`:n=`timestamptz`;break;case`date`:n=`date`;break;case`time`:n=`time`;break;case`bigint`:n=t?.autoIncrement?`bigserial`:`bigint`;break;case`json`:n=`jsonb`;break;case`blob`:n=`bytea`;break;case`vector`:n=`vector`;break;case`point`:n=`point`;break;default:n=e}return t?.array?`${n}[]`:n}const f={introspect:a,generateDDL:u,mapFieldType:d};var p=class{constructor(){this.raw=t=>e.raw`${t}`,this.identifiers={escape:t=>e.raw`"${t}"`,column:(t,n)=>t?e.raw`"${t}"."${n}"`:e.raw`"${n}"`,table:(t,n)=>e.raw`"${t}" AS "${n}"`,aliased:(t,n)=>e`${t} AS ${e.raw`"${n}"`}`},this.literals={value:t=>e`${t}`,null:()=>e.raw`NULL`,true:()=>e.raw`TRUE`,false:()=>e.raw`FALSE`,list:t=>t.length===0?e.raw`()`:e`(${e.join(t,`, `)})`,json:t=>e`${t}`},this.operators={eq:(t,n)=>e`${t} = ${n}`,neq:(t,n)=>e`${t} <> ${n}`,lt:(t,n)=>e`${t} < ${n}`,lte:(t,n)=>e`${t} <= ${n}`,gt:(t,n)=>e`${t} > ${n}`,gte:(t,n)=>e`${t} >= ${n}`,like:(t,n)=>e`${t} LIKE ${n}`,notLike:(t,n)=>e`${t} NOT LIKE ${n}`,ilike:(t,n)=>e`${t} ILIKE ${n}`,notIlike:(t,n)=>e`${t} NOT ILIKE ${n}`,in:(t,n)=>e`${t} = ANY(${n})`,notIn:(t,n)=>e`${t} <> ALL(${n})`,isNull:t=>e`${t} IS NULL`,isNotNull:t=>e`${t} IS NOT NULL`,between:(t,n,r)=>e`${t} BETWEEN ${n} AND ${r}`,notBetween:(t,n,r)=>e`${t} NOT BETWEEN ${n} AND ${r}`,and:(...t)=>t.length===0?e.raw`TRUE`:t.length===1?t[0]:e`(${e.join(t,` AND `)})`,or:(...t)=>t.length===0?e.raw`FALSE`:t.length===1?t[0]:e`(${e.join(t,` OR `)})`,not:t=>e`NOT (${t})`,exists:t=>e`EXISTS (${t})`,notExists:t=>e`NOT EXISTS (${t})`},this.expressions={add:(t,n)=>e`(${t} + ${n})`,subtract:(t,n)=>e`(${t} - ${n})`,multiply:(t,n)=>e`(${t} * ${n})`,divide:(t,n)=>e`(${t} / ${n})`,concat:(...t)=>t.length===0?e.raw`''`:t.length===1?t[0]:e`(${e.join(t,` || `)})`,upper:t=>e`UPPER(${t})`,lower:t=>e`LOWER(${t})`,coalesce:(...t)=>e`COALESCE(${e.join(t,`, `)})`,greatest:(...t)=>e`GREATEST(${e.join(t,`, `)})`,least:(...t)=>e`LEAST(${e.join(t,`, `)})`,cast:(t,n)=>e`CAST(${t} AS ${e.raw`${n}`})`},this.aggregates={count:t=>t?e`COUNT(${t})`:e.raw`COUNT(*)`,countDistinct:t=>e`COUNT(DISTINCT ${t})`,sum:t=>e`SUM(${t})`,avg:t=>e`AVG(${t})`,min:t=>e`MIN(${t})`,max:t=>e`MAX(${t})`},this.json={object:t=>{if(t.length===0)return e.raw`'{}'::json`;let n=t.flatMap(([t,n])=>[e.raw`'${t}'`,n]);return e`json_build_object(${e.join(n,`, `)})`},array:t=>t.length===0?e.raw`'[]'::json`:e`json_build_array(${e.join(t,`, `)})`,emptyArray:()=>e.raw`'[]'::json`,agg:t=>e`COALESCE(json_agg(${t}), '[]'::json)`,rowToJson:t=>e`row_to_json(${e.raw`"${t}"`})`,objectFromColumns:t=>{if(t.length===0)return e.raw`'{}'::json`;let n=t.flatMap(([t,n])=>[e.raw`'${t}'`,n]);return e`json_build_object(${e.join(n,`, `)})`},extract:(t,n)=>{if(n.length===0)return t;if(n.length===1)return e`${t}->${n[0]}`;let r=n.join(`,`);return e`${t}#>'{${e.raw`${r}`}}'`},extractText:(t,n)=>{if(n.length===0)return t;if(n.length===1)return e`${t}->>${n[0]}`;let r=n.join(`,`);return e`${t}#>>'{${e.raw`${r}`}}'`}},this.arrays={literal:t=>t.length===0?e.raw`'{}'`:e`ARRAY[${e.join(t,`, `)}]`,has:(t,n)=>e`${n} = ANY(${t})`,hasEvery:(t,n)=>e`${t} @> ${n}`,hasSome:(t,n)=>e`${t} && ${n}`,isEmpty:t=>e`(cardinality(${t}) = 0 OR ${t} IS NULL)`,length:t=>e`cardinality(${t})`,get:(t,n)=>e`${t}[${n}]`,push:(t,n)=>e`array_append(${t}, ${n})`,set:(t,n,r)=>e`${t}[:${n}-1] || ARRAY[${r}] || ${t}[${n}+1:]`},this.orderBy={asc:t=>e`${t} ASC`,desc:t=>e`${t} DESC`,nullsFirst:t=>e`${t} NULLS FIRST`,nullsLast:t=>e`${t} NULLS LAST`},this.clauses={select:t=>e`SELECT ${t}`,selectDistinct:t=>e`SELECT DISTINCT ${t}`,from:t=>e`FROM ${t}`,where:t=>e`WHERE ${t}`,orderBy:t=>e`ORDER BY ${t}`,limit:t=>e`LIMIT ${t}`,offset:t=>e`OFFSET ${t}`,groupBy:t=>e`GROUP BY ${t}`,having:t=>e`HAVING ${t}`},this.set={assign:(t,n)=>e`${t} = ${n}`,increment:(t,n)=>e`${t} = ${t} + ${n}`,decrement:(t,n)=>e`${t} = ${t} - ${n}`,multiply:(t,n)=>e`${t} = ${t} * ${n}`,divide:(t,n)=>e`${t} = ${t} / ${n}`,push:(t,n)=>e`${t} = array_append(${t}, ${n})`,unshift:(t,n)=>e`${t} = array_prepend(${n}, ${t})`},this.filters={some:t=>e`EXISTS (${t})`,every:t=>e`NOT EXISTS (${t})`,none:t=>e`NOT EXISTS (${t})`,is:t=>e`EXISTS (${t})`,isNot:t=>e`NOT EXISTS (${t})`},this.subqueries={scalar:t=>e`(${t})`,correlate:(t,n)=>e`(${t}) AS ${e.raw`"${n}"`}`,existsCheck:(t,n)=>e`SELECT 1 FROM ${t} WHERE ${n}`},this.assemble={select:t=>{let n=[t.distinct?e`SELECT DISTINCT ON (${t.distinct}) ${t.columns}`:e`SELECT ${t.columns}`,e`FROM ${t.from}`];return t.joins&&t.joins.length>0&&n.push(...t.joins),t.where&&n.push(e`WHERE ${t.where}`),t.groupBy&&n.push(e`GROUP BY ${t.groupBy}`),t.having&&n.push(e`HAVING ${t.having}`),t.orderBy&&n.push(e`ORDER BY ${t.orderBy}`),t.limit&&n.push(e`LIMIT ${t.limit}`),t.offset&&n.push(e`OFFSET ${t.offset}`),e.join(n,` `)}},this.cte={with:t=>{let n=t.map(({name:t,query:n})=>e`${e.raw`"${t}"`} AS (${n})`);return e`WITH ${e.join(n,`, `)}`},recursive:(t,n,r,i=`all`)=>{let a=i===`all`?e.raw`UNION ALL`:e.raw`UNION`;return e`WITH RECURSIVE ${e.raw`"${t}"`} AS (
        ${n}
        ${a}
        ${r}
      )`}},this.mutations={insert:(t,n,r)=>{let i=n.map(t=>e.raw`"${t}"`),a=r.map(t=>e`(${e.join(t,`, `)})`);return e`INSERT INTO ${t} (${e.join(i,`, `)}) VALUES ${e.join(a,`, `)}`},update:(t,n,r)=>r?e`UPDATE ${t} SET ${n} WHERE ${r}`:e`UPDATE ${t} SET ${n}`,delete:(t,n)=>n?e`DELETE FROM ${t} WHERE ${n}`:e`DELETE FROM ${t}`,returning:t=>e`RETURNING ${t}`,onConflict:(t,n)=>t?e`ON CONFLICT (${t}) DO ${n}`:e`ON CONFLICT DO ${n}`},this.joins={inner:(t,n)=>e`INNER JOIN ${t} ON ${n}`,left:(t,n)=>e`LEFT JOIN ${t} ON ${n}`,right:(t,n)=>e`RIGHT JOIN ${t} ON ${n}`,full:(t,n)=>e`FULL OUTER JOIN ${t} ON ${n}`,cross:t=>e`CROSS JOIN ${t}`},this.setOperations={union:(...t)=>e.join(t,` UNION `),unionAll:(...t)=>e.join(t,` UNION ALL `),intersect:(...t)=>e.join(t,` INTERSECT `),except:(t,n)=>e`${t} EXCEPT ${n}`},this.capabilities={supportsReturning:!0,supportsCteWithMutations:!0,supportsFullOuterJoin:!0},this.lastInsertId=()=>e.raw`lastval()`,this.migrations=f,this.vector={literal:t=>e`${`[${t.join(`,`)}]`}::vector`,l2:(t,n)=>e`${t} <-> ${n}`,cosine:(t,n)=>e`${t} <=> ${n}`},this.geospatial={point:(t,n)=>e`ST_SetSRID(ST_MakePoint(${t}, ${n}), 4326)`,equals:(t,n)=>e`ST_Equals(${t}, ${n})`,intersects:(t,n)=>e`ST_Intersects(${t}, ${n})`,contains:(t,n)=>e`ST_Contains(${t}, ${n})`,within:(t,n)=>e`ST_Within(${t}, ${n})`,crosses:(t,n)=>e`ST_Crosses(${t}, ${n})`,overlaps:(t,n)=>e`ST_Overlaps(${t}, ${n})`,touches:(t,n)=>e`ST_Touches(${t}, ${n})`,covers:(t,n)=>e`ST_Covers(${t}, ${n})`,dWithin:(t,n,r)=>e`ST_DWithin(${t}::geography, ${n}::geography, ${r})`}}};const m=new p;export{m as n,p as t};
//# sourceMappingURL=postgres-adapter-CzPH7ypE.mjs.map