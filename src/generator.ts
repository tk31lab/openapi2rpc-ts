import { readFileSync } from 'node:fs';
import { camel, constName, docComment, pascal, propKey, unique, words } from './names.js';
import { literal, TypeRenderer, typesOf } from './schema.js';
import { RuntimeSchemaBuilder } from './validation.js';
import {
  deref,
  HTTP_METHODS,
  isRef,
  type Document,
  type MediaType,
  type Operation,
  type Parameter,
  type RequestBody,
  type Response,
} from './spec.js';

export interface GenerateOptions {
  /**
   * Import the runtime from this module instead of embedding it in the output,
   * e.g. `./rpc-runtime.js`. Useful when generating several clients.
   */
  runtimeImport?: string;
  /**
   * How object types (messages, requests, services) are declared.
   * - `interface` (default): `export interface Task { ... }`
   * - `type`: `export type Task = { ... };` — assignable to `Record<string, unknown>`
   */
  objectStyle?: ObjectStyle;
  /**
   * Embed the response schemas and check every JSON response against them at runtime.
   * A mismatch fails the call with `Code.INTERNAL` (see `validateResponses` on the transport).
   */
  validate?: boolean;
}

export type ObjectStyle = 'interface' | 'type';

/** Declares an object type; `members` is the text between the braces. */
function objectDecl(style: ObjectStyle, name: string, members: string): string {
  if (style === 'type') return members ? `export type ${name} = {\n${members}};\n\n` : `export type ${name} = Record<string, never>;\n\n`;
  return members ? `export interface ${name} {\n${members}}\n\n` : `export interface ${name} {}\n\n`;
}

export interface GenerateResult {
  code: string;
  warnings: string[];
}

/** Source of the runtime that is embedded into (or imported by) generated code. */
export function runtimeSource(): string {
  return readFileSync(new URL('../templates/runtime.ts', import.meta.url), 'utf8');
}

type BodyEncoding = 'json' | 'form' | 'multipart' | 'text' | 'binary';
type ResponseEncoding = 'json' | 'text' | 'binary' | 'none';

interface FieldInfo {
  field: string;
  param: Parameter;
}

interface MethodInfo {
  name: string;
  httpMethod: string;
  path: string;
  op: Operation;
  requestType: string;
  responseType: string;
  fields: FieldInfo[];
  body?: { field: string; contentType: string; encoding: BodyEncoding; required: boolean; media: MediaType; description?: string };
  response: { encoding: ResponseEncoding; media?: MediaType; description?: string };
}

interface ServiceInfo {
  /** e.g. "Pet" */
  base: string;
  /** e.g. "PetService" */
  name: string;
  description?: string;
  methods: MethodInfo[];
  methodNames: Set<string>;
}

/** Generates gRPC-style TypeScript code for an OpenAPI document. */
export function generate(doc: Document, options: GenerateOptions = {}): GenerateResult {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  const runtime = runtimeSource();
  const style: ObjectStyle = options.objectStyle ?? 'interface';
  if (style !== 'interface' && style !== 'type') throw new Error(`invalid objectStyle "${String(style)}" (expected "interface" or "type")`);

  // Names that generated declarations must not shadow: runtime declarations and common globals.
  const used = new Set<string>([
    ...[...runtime.matchAll(/^(?:export )?(?:async )?(?:function|const|class|type|interface) (\w+)/gm)].map((m) => m[1]!),
    ...['Error', 'Object', 'Array', 'Date', 'Record', 'Promise', 'String', 'Number', 'Boolean', 'Map', 'Set',
      'Symbol', 'Function', 'Blob', 'File', 'FormData', 'Response', 'Request', 'Headers', 'URL', 'URLSearchParams',
      'AbortSignal', 'AbortController', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit', 'Exclude', 'Extract',
      'JSON', 'Math', 'BigInt', 'RequestInit', 'BodyInit', 'createClients'],
  ]);

  // 1. component schemas -> type names
  const schemaNames = new Map<string, string>();
  for (const key of Object.keys(doc.components?.schemas ?? {})) {
    const base = pascal(key);
    schemaNames.set(key, used.has(base) ? unique(used, `${base}Model`) : unique(used, base));
  }
  const types = new TypeRenderer(doc, schemaNames, warn);
  const validator = options.validate ? new RuntimeSchemaBuilder(doc, schemaNames) : undefined;
  used.add('rpcSchemas');

  // 2. operations -> services / methods
  const services = collectServices(doc, used, warn);

  // 3. emit
  let out = header(doc);
  if (options.runtimeImport) {
    out += validator
      ? `import { validateValue, type CallOptions, type Empty, type JsonSchema, type ServiceDefinition, type Transport } from '${options.runtimeImport}';\n`
      : `import type { CallOptions, Empty, ServiceDefinition, Transport } from '${options.runtimeImport}';\n`;
    out += `export * from '${options.runtimeImport}';\n\n`;
  } else {
    out += `${runtime.trim()}\n\n`;
  }

  const schemaEntries = Object.entries(doc.components?.schemas ?? {});
  if (schemaEntries.length > 0) out += section('Messages (components.schemas)');
  for (const [key, schema] of schemaEntries) {
    const name = schemaNames.get(key)!;
    const info = typeof schema === 'object' && !isRef(schema) ? schema : undefined;
    out += docComment('', info?.title && info.description ? info.title : undefined, info?.description ?? info?.title, info?.deprecated && '@deprecated');
    if (types.isPlainObject(schema)) {
      out += objectDecl(style, name, types.renderObjectMembers(schema, ''));
      continue;
    }
    out += `export type ${name} = ${types.render(schema)};\n`;
    const values = info?.enum;
    if (info && values && values.length > 0 && values.every((v) => typeof v === 'string' || v === null) && typesOf(info).includes('string')) {
      const keys = new Set<string>();
      const members = (values.filter((v) => v !== null) as string[]).map((v) => `  ${unique(keys, constName(v))}: ${literal(v)},\n`);
      out += `export const ${name} = {\n${members.join('')}} as const;\n`;
    }
    out += '\n';
  }

  if (validator) {
    out += section('Schemas for response validation (--validate)');
    out += `const rpcSchemas: { readonly [name: string]: JsonSchema } = {\n`;
    for (const [key, schema] of schemaEntries) {
      out += `  ${propKey(schemaNames.get(key)!)}: ${JSON.stringify(validator.build(schema))},\n`;
    }
    out += `};\n\n`;
  }

  for (const svc of services) {
    out += section(svc.name);
    for (const m of svc.methods) out += requestAndResponse(m, types, style);
    out += serviceInterface(svc, style);
    out += serviceDefinition(svc, validator);
    out += serviceClient(svc);
  }

  if (services.length > 0) {
    out += section('Clients');
    out += `/** Creates a client for every service, sharing one transport. */\n`;
    out += `export function createClients(transport: Transport) {\n  return {\n`;
    const keys = new Set<string>();
    for (const svc of services) out += `    ${unique(keys, camel(svc.base))}: new ${svc.name}Client(transport),\n`;
    out += `  };\n}\n`;
  }

  return { code: out, warnings };
}

function header(doc: Document): string {
  const title = doc.info?.title ? `${doc.info.title}${doc.info.version ? ` (${doc.info.version})` : ''}` : undefined;
  return (
    `// Code generated by openapi2rpc-ts. DO NOT EDIT.\n` +
    (title ? `// source: ${title.replace(/\n/g, ' ')}\n` : '') +
    `/* eslint-disable */\n\n`
  );
}

function section(title: string): string {
  return `// ${'-'.repeat(73)}\n// ${title}\n// ${'-'.repeat(73)}\n\n`;
}

function collectServices(doc: Document, used: Set<string>, warn: (m: string) => void): ServiceInfo[] {
  const byTag = new Map<string, ServiceInfo>();
  const tagDescriptions = new Map((doc.tags ?? []).map((t) => [t.name, t.description]));
  // services follow the order of the top-level `tags`, then first appearance
  const order = (doc.tags ?? []).map((t) => t.name);

  const service = (tag: string): ServiceInfo => {
    let svc = byTag.get(tag);
    if (!svc) {
      let base = pascal(tag);
      if (base.endsWith('Service') && base !== 'Service') base = base.slice(0, -'Service'.length);
      const taken = (b: string) => [`${b}Service`, `${b}ServiceDefinition`, `${b}ServiceClient`].some((n) => used.has(n));
      let candidate = base;
      for (let i = 2; taken(candidate); i++) candidate = `${base}${i}`;
      for (const n of [`${candidate}Service`, `${candidate}ServiceDefinition`, `${candidate}ServiceClient`]) used.add(n);
      svc = { base: candidate, name: `${candidate}Service`, description: tagDescriptions.get(tag), methods: [], methodNames: new Set(['constructor']) };
      byTag.set(tag, svc);
    }
    return svc;
  };

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!item) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const tag = op.tags?.[0] ?? 'Default';
      if (!order.includes(tag)) order.push(tag);
      const svc = service(tag);

      const name = unique(svc.methodNames, camel(op.operationId ?? fallbackOperationName(method, path)));
      const typeBase = pascal(name);
      const requestType = used.has(`${typeBase}Request`) ? unique(used, `${svc.base}${typeBase}Request`) : unique(used, `${typeBase}Request`);
      const responseType = used.has(`${typeBase}Response`) ? unique(used, `${svc.base}${typeBase}Response`) : unique(used, `${typeBase}Response`);

      // path-level parameters, overridden by operation-level ones with the same name+location
      const params = new Map<string, Parameter>();
      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        const param = deref<Parameter>(doc, p);
        if (!param?.name || !param.in) {
          warn(`${method.toUpperCase()} ${path}: skipped unresolvable parameter`);
          continue;
        }
        params.set(`${param.in}:${param.name}`, param);
      }
      const fieldNames = new Set<string>();
      const fields = [...params.values()].map((param) => {
        let field = camel(param.name);
        if (fieldNames.has(field)) field = `${field}${pascal(param.in)}`;
        return { field: unique(fieldNames, field), param };
      });

      let body: MethodInfo['body'];
      const requestBody = deref<RequestBody>(doc, op.requestBody);
      if (requestBody?.content) {
        const picked = pickContent(requestBody.content, ['json', 'multipart', 'form', 'text', 'binary']);
        if (picked) {
          body = {
            field: unique(fieldNames, fieldNames.has('body') ? 'requestBody' : 'body'),
            contentType: picked.contentType,
            encoding: picked.encoding as BodyEncoding,
            required: requestBody.required === true,
            media: picked.media,
            description: requestBody.description,
          };
        }
      }

      svc.methods.push({
        name,
        httpMethod: method.toUpperCase(),
        path,
        op,
        requestType,
        responseType,
        fields,
        body,
        response: successResponse(doc, op),
      });
    }
  }

  return order.map((tag) => byTag.get(tag)).filter((s): s is ServiceInfo => s !== undefined);
}

/** "get" + "/pets/{petId}/photos" -> "getPetsPhotosByPetId" */
function fallbackOperationName(method: string, path: string): string {
  const segments = path.split('/').filter(Boolean);
  const plain = segments.filter((s) => !s.startsWith('{'));
  const params = segments.filter((s) => s.startsWith('{')).map((s) => s.slice(1, -1));
  return [method, ...plain, ...(params.length ? ['by', ...params.flatMap((p, i) => (i ? ['and', p] : [p]))] : [])]
    .flatMap(words)
    .join('-');
}

function classify(contentType: string): BodyEncoding {
  const ct = contentType.toLowerCase().split(';')[0]!.trim();
  if (ct === 'application/json' || ct.endsWith('+json')) return 'json';
  if (ct === 'multipart/form-data') return 'multipart';
  if (ct === 'application/x-www-form-urlencoded') return 'form';
  if (ct.startsWith('text/')) return 'text';
  return 'binary';
}

function pickContent(
  content: Record<string, MediaType>,
  preference: string[],
): { contentType: string; encoding: string; media: MediaType } | undefined {
  const entries = Object.entries(content);
  for (const want of preference) {
    const hit = entries.find(([ct]) => classify(ct) === want);
    if (hit) return { contentType: hit[0], encoding: want, media: hit[1] ?? {} };
  }
  return undefined;
}

function successResponse(doc: Document, op: Operation): MethodInfo['response'] {
  const codes = Object.keys(op.responses ?? {});
  const code =
    codes.filter((c) => /^2\d\d$/.test(c)).sort()[0] ??
    codes.find((c) => /^2xx$/i.test(c));
  if (!code) return { encoding: 'none' };
  const res = deref<Response>(doc, op.responses?.[code]);
  if (!res?.content || Object.keys(res.content).length === 0 || code === '204') {
    return { encoding: 'none', description: res?.description };
  }
  const picked = pickContent(res.content, ['json', 'text', 'binary', 'multipart', 'form'])!;
  const encoding: ResponseEncoding = picked.encoding === 'json' || picked.encoding === 'text' ? picked.encoding : 'binary';
  return { encoding, media: picked.media, description: res.description };
}

function requestAndResponse(m: MethodInfo, types: TypeRenderer, style: ObjectStyle): string {
  let out = docComment('', `Request message for \`${m.name}\`.`);
  let members = '';
  for (const { field, param } of m.fields) {
    const info = typeof param.schema === 'object' && !isRef(param.schema) ? param.schema : undefined;
    members += docComment('  ', param.description, `@in ${param.in} \`${param.name}\``, info?.format && `@format ${info.format}`, (param.deprecated || info?.deprecated) && '@deprecated');
    const required = param.required || param.in === 'path';
    members += `  ${propKey(field)}${required ? '' : '?'}: ${types.render(param.schema, '  ')};\n`;
  }
  if (m.body) {
    const b = m.body;
    const type = b.encoding === 'text' ? 'string' : b.encoding === 'binary' ? 'Blob' : types.render(b.media.schema, '  ');
    members += docComment('  ', b.description, `@in body (\`${b.contentType}\`)`);
    members += `  ${propKey(b.field)}${b.required ? '' : '?'}: ${type};\n`;
  }
  out += objectDecl(style, m.requestType, members);

  const resType =
    m.response.encoding === 'none' ? 'Empty'
      : m.response.encoding === 'text' ? 'string'
      : m.response.encoding === 'binary' ? 'Blob'
      : types.render(m.response.media?.schema);
  out += docComment('', `Response message for \`${m.name}\`.`, m.response.description && '', m.response.description);
  out += `export type ${m.responseType} = ${resType};\n\n`;
  return out;
}

function requestIsOptional(m: MethodInfo): boolean {
  return m.fields.every(({ param }) => !param.required && param.in !== 'path') && !m.body?.required;
}

function methodDoc(m: MethodInfo, indent: string): string {
  return docComment(
    indent,
    m.op.summary,
    m.op.summary && m.op.description ? '' : undefined,
    m.op.description,
    (m.op.summary || m.op.description) ? '' : undefined,
    `\`${m.httpMethod} ${m.path}\``,
    m.op.deprecated && '@deprecated',
  );
}

function serviceInterface(svc: ServiceInfo, style: ObjectStyle): string {
  let members = '';
  for (const m of svc.methods) {
    members += methodDoc(m, '  ');
    members += `  ${m.name}(request${requestIsOptional(m) ? '?' : ''}: ${m.requestType}, options?: CallOptions): Promise<${m.responseType}>;\n`;
  }
  return docComment('', svc.description) + objectDecl(style, svc.name, members);
}

function serviceDefinition(svc: ServiceInfo, validator: RuntimeSchemaBuilder | undefined): string {
  let out = `/** HTTP transcoding rules for ${svc.name}. */\n`;
  out += `export const ${svc.name}Definition = {\n  typeName: ${literal(svc.name)},\n  methods: {\n`;
  for (const m of svc.methods) {
    out += `    ${propKey(m.name)}: {\n`;
    out += `      service: ${literal(svc.name)},\n`;
    out += `      name: ${literal(m.name)},\n`;
    out += `      httpMethod: ${literal(m.httpMethod)},\n`;
    out += `      path: ${literal(m.path)},\n`;
    if (m.fields.length === 0) {
      out += `      params: [],\n`;
    } else {
      out += `      params: [\n`;
      for (const { field, param } of m.fields) {
        out += `        { field: ${literal(field)}, name: ${literal(param.name)}, in: ${literal(param.in)} },\n`;
      }
      out += `      ],\n`;
    }
    if (m.body) {
      out += `      body: { field: ${literal(m.body.field)}, contentType: ${literal(m.body.contentType)}, encoding: ${literal(m.body.encoding)} },\n`;
    }
    if (validator && m.response.encoding === 'json') {
      const schema = JSON.stringify(validator.build(m.response.media?.schema));
      out += `      response: {\n`;
      out += `        encoding: 'json',\n`;
      out += `        validate: (value: unknown) => validateValue(value, ${schema}, rpcSchemas),\n`;
      out += `      },\n`;
    } else {
      out += `      response: { encoding: ${literal(m.response.encoding)} },\n`;
    }
    out += `    },\n`;
  }
  return `${out}  },\n} as const satisfies ServiceDefinition;\n\n`;
}

function serviceClient(svc: ServiceInfo): string {
  let out = `/** ${svc.name} client. Pass a transport such as \`createFetchTransport({ baseUrl })\`. */\n`;
  out += `export class ${svc.name}Client implements ${svc.name} {\n`;
  out += `  readonly #transport: Transport;\n\n`;
  out += `  constructor(transport: Transport) {\n    this.#transport = transport;\n  }\n`;
  for (const m of svc.methods) {
    out += `\n${methodDoc(m, '  ')}`;
    const param = requestIsOptional(m) ? `request: ${m.requestType} = {}` : `request: ${m.requestType}`;
    out += `  ${m.name}(${param}, options?: CallOptions): Promise<${m.responseType}> {\n`;
    out += `    return this.#transport.unary<${m.requestType}, ${m.responseType}>(${svc.name}Definition.methods.${m.name}, request, options);\n`;
    out += `  }\n`;
  }
  return `${out}}\n\n`;
}
