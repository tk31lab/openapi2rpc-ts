/** The subset of an OpenAPI 3.0 / 3.1 document used by the generator. */

export interface Reference {
  $ref: string;
}

export interface Document {
  openapi: string;
  info?: { title?: string; version?: string; description?: string };
  tags?: Tag[];
  paths?: Record<string, PathItem>;
  components?: Components;
}

export interface Tag {
  name: string;
  description?: string;
}

export interface Components {
  schemas?: Record<string, SchemaOrRef>;
  parameters?: Record<string, Parameter | Reference>;
  requestBodies?: Record<string, RequestBody | Reference>;
  responses?: Record<string, Response | Reference>;
}

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
export type HttpMethodKey = (typeof HTTP_METHODS)[number];

export type PathItem = {
  parameters?: (Parameter | Reference)[];
} & { [M in HttpMethodKey]?: Operation };

export interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: (Parameter | Reference)[];
  requestBody?: RequestBody | Reference;
  responses?: Record<string, Response | Reference>;
}

export interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: SchemaOrRef;
}

export interface RequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, MediaType>;
}

export interface Response {
  description?: string;
  content?: Record<string, MediaType>;
}

export interface MediaType {
  schema?: SchemaOrRef;
}

export interface Schema {
  type?: string | string[];
  format?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  /** OpenAPI 3.0 */
  nullable?: boolean;
  deprecated?: boolean;
  items?: SchemaOrRef;
  properties?: Record<string, SchemaOrRef>;
  required?: string[];
  additionalProperties?: boolean | SchemaOrRef;
  allOf?: SchemaOrRef[];
  oneOf?: SchemaOrRef[];
  anyOf?: SchemaOrRef[];
}

/** JSON Schema 2020-12 (OpenAPI 3.1) also allows `true` / `false` as schemas. */
export type SchemaOrRef = Schema | Reference | boolean;

export function isRef(v: unknown): v is Reference {
  return typeof v === 'object' && v !== null && typeof (v as Reference).$ref === 'string';
}

/** Resolves a local JSON pointer (`#/components/...`). Returns undefined for external refs. */
export function resolvePointer(doc: Document, ref: string): unknown {
  if (!ref.startsWith('#')) return undefined;
  let cur: unknown = doc;
  for (const raw of ref.slice(1).split('/').slice(1)) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Follows `$ref`s (for parameters, request bodies, responses) until a concrete object is found. */
export function deref<T>(doc: Document, value: T | Reference | undefined): T | undefined {
  const seen = new Set<string>();
  let cur: unknown = value;
  while (isRef(cur)) {
    if (seen.has(cur.$ref)) return undefined;
    seen.add(cur.$ref);
    cur = resolvePointer(doc, cur.$ref);
  }
  return cur as T | undefined;
}
