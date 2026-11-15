import { docComment, propKey } from './names.js';
import { isRef, resolvePointer, type Document, type Schema, type SchemaOrRef } from './spec.js';

const SCHEMA_REF_PREFIX = '#/components/schemas/';

/** Converts JSON Schemas to TypeScript type expressions. */
export class TypeRenderer {
  /** depth guard for refs that are inlined (refs outside #/components/schemas/<name>) */
  private inlining = new Set<string>();

  constructor(
    private readonly doc: Document,
    /** component schema key -> generated TypeScript type name */
    private readonly schemaNames: Map<string, string>,
    private readonly warn: (message: string) => void,
  ) {}

  /** Renders a type expression. `indent` is the indentation of the line the expression starts on. */
  render(schema: SchemaOrRef | undefined, indent = ''): string {
    if (schema === undefined || schema === true) return 'unknown';
    if (schema === false) return 'never';
    if (isRef(schema)) return this.renderRef(schema.$ref, indent);

    const parts: string[] = [];

    if ('const' in schema) {
      parts.push(literal(schema.const));
    } else if (schema.enum) {
      parts.push(unionOf(schema.enum.map(literal)));
    } else {
      const own = this.renderOwnType(schema, indent);
      if (own) parts.push(own);
    }

    if (schema.allOf?.length) {
      parts.push(...schema.allOf.map((s) => this.render(s, indent)));
    }
    for (const variants of [schema.oneOf, schema.anyOf]) {
      if (variants?.length) parts.push(unionOf(variants.map((s) => this.render(s, indent))));
    }

    let type = parts.length === 0 ? 'unknown' : parts.length === 1 ? parts[0]! : parts.map(wrapForIntersection).join(' & ');
    if (isNullable(schema) && !splitTopLevelUnion(type).includes('null')) {
      type = `${wrapForUnion(type)} | null`;
    }
    return type;
  }

  /** True if the schema renders to a plain object type, i.e. can be emitted as an interface. */
  isPlainObject(schema: SchemaOrRef): schema is Schema {
    if (typeof schema !== 'object' || isRef(schema)) return false;
    if (schema.allOf || schema.oneOf || schema.anyOf || schema.enum || 'const' in schema) return false;
    if (isNullable(schema)) return false;
    const types = typesOf(schema);
    return types.length === 1 && types[0] === 'object' && schema.properties !== undefined;
  }

  /** Renders the body of an object type (the part between the braces). */
  renderObjectMembers(schema: Schema, indent: string): string {
    const inner = `${indent}  `;
    const required = new Set(schema.required ?? []);
    let out = '';
    for (const [name, prop] of Object.entries(schema.properties ?? {})) {
      const info = typeof prop === 'object' && !isRef(prop) ? prop : undefined;
      out += docComment(
        inner,
        info?.title && info.description ? info.title : undefined,
        info?.description ?? info?.title,
        info?.format && `@format ${info.format}`,
        info?.deprecated && '@deprecated',
      );
      out += `${inner}${propKey(name)}${required.has(name) ? '' : '?'}: ${this.render(prop, inner)};\n`;
    }
    const extra = schema.additionalProperties;
    if (extra !== undefined && extra !== false) {
      // An index signature must be compatible with every declared property, so fall back to
      // `unknown` when the object also has named properties.
      const valueType = schema.properties && Object.keys(schema.properties).length > 0 ? 'unknown' : this.render(extra === true ? undefined : extra, inner);
      out += `${inner}[key: string]: ${valueType};\n`;
    }
    return out;
  }

  private renderRef(ref: string, indent: string): string {
    if (ref.startsWith(SCHEMA_REF_PREFIX)) {
      const key = decodeURIComponent(ref.slice(SCHEMA_REF_PREFIX.length)).replace(/~1/g, '/').replace(/~0/g, '~');
      const name = this.schemaNames.get(key);
      if (name) return name;
    }
    const target = resolvePointer(this.doc, ref);
    if (target === undefined) {
      this.warn(`unresolvable $ref "${ref}" rendered as unknown`);
      return 'unknown';
    }
    if (this.inlining.has(ref)) {
      this.warn(`recursive inline $ref "${ref}" rendered as unknown`);
      return 'unknown';
    }
    this.inlining.add(ref);
    try {
      return this.render(target as SchemaOrRef, indent);
    } finally {
      this.inlining.delete(ref);
    }
  }

  private renderOwnType(schema: Schema, indent: string): string | undefined {
    const types = typesOf(schema).filter((t) => t !== 'null');
    if (types.length === 0) return undefined;
    return unionOf(types.map((t) => this.renderPrimitive(t, schema, indent)));
  }

  private renderPrimitive(type: string, schema: Schema, indent: string): string {
    switch (type) {
      case 'string':
        return schema.format === 'binary' ? 'Blob' : 'string';
      case 'integer':
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'array': {
        const item = this.render(schema.items, indent);
        return /^[\w.]+$/.test(item) ? `${item}[]` : `Array<${item}>`;
      }
      case 'object': {
        const hasProps = schema.properties && Object.keys(schema.properties).length > 0;
        const extra = schema.additionalProperties;
        if (!hasProps) {
          if (extra === false) return 'Record<string, never>';
          if (extra === undefined || extra === true) return 'Record<string, unknown>';
          return `Record<string, ${this.render(extra, indent)}>`;
        }
        return `{\n${this.renderObjectMembers(schema, indent)}${indent}}`;
      }
      default:
        this.warn(`unknown schema type "${type}" rendered as unknown`);
        return 'unknown';
    }
  }
}

/** The JSON Schema types of a schema, inferring `object` / `array` from keywords when `type` is absent. */
export function typesOf(schema: Schema): string[] {
  if (Array.isArray(schema.type)) return schema.type;
  if (typeof schema.type === 'string') return [schema.type];
  if (schema.properties || schema.additionalProperties !== undefined) return ['object'];
  if (schema.items) return ['array'];
  return [];
}

export function isNullable(schema: Schema): boolean {
  return schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes('null'));
}

export function literal(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return 'unknown';
}

function unionOf(members: string[]): string {
  const uniq = [...new Set(members.flatMap(splitTopLevelUnion))];
  if (uniq.length === 0) return 'never';
  if (uniq.includes('unknown')) return 'unknown';
  return uniq.join(' | ');
}

/** Splits "A | B | { x: C | D }" into its top-level union members. */
function splitTopLevelUnion(type: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | undefined;
  for (let i = 0; i < type.length; i++) {
    const c = type[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if ('({[<'.includes(c)) depth++;
    else if (')}]>'.includes(c)) depth--;
    else if (depth === 0 && type.startsWith(' | ', i)) {
      out.push(type.slice(start, i));
      start = i + 3;
      i += 2;
    }
  }
  out.push(type.slice(start));
  return out;
}

function wrapForUnion(type: string): string {
  return type.includes(' & ') && !type.trimStart().startsWith('{') ? `(${type})` : type;
}

function wrapForIntersection(type: string): string {
  return splitTopLevelUnion(type).length > 1 ? `(${type})` : type;
}
