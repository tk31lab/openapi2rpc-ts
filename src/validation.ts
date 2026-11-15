import { isNullable, typesOf } from './schema.js';
import { isRef, resolvePointer, type Document, type SchemaOrRef } from './spec.js';

const SCHEMA_REF_PREFIX = '#/components/schemas/';

/** The compact JSON Schema subset understood by the runtime's `validateValue`. */
export type RuntimeSchema = boolean | { [key: string]: unknown };

/**
 * Converts OpenAPI schemas into the compact form checked at runtime (`--validate`).
 * - refs to component schemas become `{ $ref: "<TypeScript name>" }`
 * - `nullable` / `type: [.., "null"]` become an explicit `"null"` type
 * - `oneOf` is checked like `anyOf` (at least one variant must match), matching the TS union
 * - `additionalProperties: false` is ignored: unknown fields are tolerated, like in protobuf
 */
export class RuntimeSchemaBuilder {
  private inlining = new Set<string>();

  constructor(
    private readonly doc: Document,
    private readonly schemaNames: Map<string, string>,
  ) {}

  build(schema: SchemaOrRef | undefined): RuntimeSchema {
    if (schema === undefined || schema === true) return true;
    if (schema === false) return false;
    if (isRef(schema)) return this.ref(schema.$ref);

    const out: Record<string, unknown> = {};
    const types = typesOf(schema).filter((t) => t !== 'null');
    if (types.length > 0) out['type'] = types;
    if ('const' in schema) out['const'] = schema.const;
    if (schema.enum) out['enum'] = schema.enum.filter((v) => v !== null);
    if (schema.properties) {
      out['properties'] = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, this.build(v)]));
    }
    if (schema.required?.length) out['required'] = schema.required;
    if (schema.items !== undefined) out['items'] = this.build(schema.items);
    if (typeof schema.additionalProperties === 'object') out['additionalProperties'] = this.build(schema.additionalProperties);

    const allOf = (schema.allOf ?? []).map((s) => this.build(s));
    const unions = [schema.oneOf, schema.anyOf].filter((u) => u?.length).map((u) => u!.map((s) => this.build(s)));
    if (unions.length === 1) out['anyOf'] = unions[0];
    else allOf.push(...unions.map((u) => ({ anyOf: u })));
    if (allOf.length > 0) out['allOf'] = allOf;

    const inner: RuntimeSchema = Object.keys(out).length === 0 ? true : out;
    const nullable = isNullable(schema) || (schema.enum?.includes(null) ?? false);
    if (!nullable || inner === true) return inner;
    // With only type/structure keywords, adding "null" to the type list is enough (structure
    // checks apply to objects and arrays only). enum, const, $ref (via allOf) and unions are wrapped.
    const structural = ['type', 'properties', 'required', 'items', 'additionalProperties'];
    if (out['type'] && Object.keys(out).every((k) => structural.includes(k))) {
      return { ...out, type: [...(out['type'] as string[]), 'null'] };
    }
    return { anyOf: [{ type: ['null'] }, inner] };
  }

  private ref(ref: string): RuntimeSchema {
    if (ref.startsWith(SCHEMA_REF_PREFIX)) {
      const key = decodeURIComponent(ref.slice(SCHEMA_REF_PREFIX.length)).replace(/~1/g, '/').replace(/~0/g, '~');
      const name = this.schemaNames.get(key);
      if (name) return { $ref: name };
    }
    const target = resolvePointer(this.doc, ref);
    if (target === undefined || this.inlining.has(ref)) return true; // already warned by the type renderer
    this.inlining.add(ref);
    try {
      return this.build(target as SchemaOrRef);
    } finally {
      this.inlining.delete(ref);
    }
  }
}
