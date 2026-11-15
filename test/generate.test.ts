import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateFromText, runtimeSource } from '../src/index.js';
import { typecheck } from './typecheck.js';

const petstore = readFileSync(new URL('./fixtures/petstore.yaml', import.meta.url), 'utf8');

describe('generate', () => {
  it('matches the petstore snapshot', async () => {
    const { code, warnings } = generateFromText(petstore);
    expect(warnings).toEqual([]);
    await expect(code).toMatchFileSnapshot('./fixtures/petstore.generated.ts');
  });

  it('produces code that passes strict type-checking (embedded runtime)', () => {
    const { code } = generateFromText(petstore);
    expect(typecheck({ 'client.ts': code })).toEqual([]);
  });

  it('can import the runtime from a separate module', () => {
    const { code } = generateFromText(petstore, { runtimeImport: './runtime.js' });
    expect(code).not.toContain('export class RpcError');
    expect(code).toContain("export * from './runtime.js';");
    expect(typecheck({ 'client.ts': code, 'runtime.ts': runtimeSource() })).toEqual([]);
  });

  describe('objectStyle', () => {
    // a generic helper that only accepts index-signature-compatible objects
    const usage = `import type { Pet, GetPetRequest, GetInventoryRequest, StoreService } from './client.js';
import { StoreServiceClient } from './client.js';
declare function log(value: Record<string, unknown>): void;
declare const pet: Pet;
declare const req: GetPetRequest;
log(pet);
log(req);
const empty: GetInventoryRequest = {};
const svc: StoreService = new StoreServiceClient({ unary: async () => ({}) as never });
export { empty, svc };
`;

    it('declares objects with type aliases when objectStyle is "type"', () => {
      const { code } = generateFromText(petstore, { objectStyle: 'type' });
      expect(code).toContain('export type Pet = {\n  /** @format int64 */\n  id: number;');
      expect(code).toContain('export type GetPetRequest = {\n');
      expect(code).toContain('export type GetInventoryRequest = Record<string, never>;');
      expect(code).toContain('export type PetsService = {\n');
      expect(code).toContain('export class PetsServiceClient implements PetsService {');
      expect(code).not.toMatch(/^export interface (?!RpcErrorInit|ParamDescriptor|BodyDescriptor|ResponseDescriptor|MethodDescriptor|ServiceDefinition|CallOptions|UnaryRequest|UnaryResponse|Transport|FetchTransportOptions)/m);
      expect(typecheck({ 'client.ts': code, 'usage.ts': usage })).toEqual([]);
    });

    it('keeps interfaces by default (not assignable to Record<string, unknown>)', () => {
      const { code } = generateFromText(petstore);
      expect(code).toContain('export interface Pet {');
      const errors = typecheck({ 'client.ts': code, 'usage.ts': usage });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((e) => e.startsWith('usage.ts:') && e.includes('Index signature'))).toBe(true);
    });

    it('rejects unknown styles', () => {
      expect(() => generateFromText(petstore, { objectStyle: 'class' as never })).toThrow(/invalid objectStyle/);
    });
  });

  it('supports OpenAPI 3.1 type arrays, const and boolean schemas', () => {
    const { code } = generateFromText(`
openapi: 3.1.0
info: { title: t, version: '1' }
paths: {}
components:
  schemas:
    Thing:
      type: object
      required: [kind]
      properties:
        kind: { const: thing }
        label: { type: [string, 'null'] }
        anything: true
        nothing: false
        count: { type: [integer, string] }
`);
    expect(code).toContain(`export interface Thing {
  kind: 'thing';
  label?: string | null;
  anything?: unknown;
  nothing?: never;
  count?: number | string;
}`);
  });

  it('renames schemas that would shadow globals or runtime names', () => {
    const { code } = generateFromText(`
openapi: 3.0.0
info: { title: t, version: '1' }
paths: {}
components:
  schemas:
    Error: { type: object, properties: { message: { type: string } } }
    Code: { type: string }
    pet.Pet: { type: object, properties: { id: { type: string } } }
    Uses: { type: object, properties: { e: { $ref: '#/components/schemas/Error' }, p: { $ref: '#/components/schemas/pet.Pet' } } }
`);
    expect(code).toContain('export interface ErrorModel {');
    expect(code).toContain('export type CodeModel = string;');
    expect(code).toContain('export interface PetPet {');
    expect(code).toContain('  e?: ErrorModel;\n  p?: PetPet;');
    expect(typecheck({ 'client.ts': code })).toEqual([]);
  });

  it('derives names and avoids collisions', () => {
    const { code } = generateFromText(`
openapi: 3.0.0
info: { title: t, version: '1' }
paths:
  /items/{id}:
    get:
      tags: [ItemService]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: id, in: query, schema: { type: string } }
      responses: { '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/GetItemsByIdResponse' } } } } }
  /constructor:
    post:
      tags: [ItemService]
      operationId: constructor
      responses: { '204': { description: ok } }
components:
  schemas:
    GetItemsByIdResponse: { type: object, properties: { id: { type: string } } }
`);
    expect(code).toContain('export interface ItemService {');
    expect(code).toContain('getItemsById(request: GetItemsByIdRequest');
    expect(code).toContain('export type ItemGetItemsByIdResponse = GetItemsByIdResponse;');
    expect(code).toContain("{ field: 'id', name: 'id', in: 'path' }");
    expect(code).toContain("{ field: 'idQuery', name: 'id', in: 'query' }");
    expect(code).toContain('constructor2(request?: Constructor2Request');
    expect(typecheck({ 'client.ts': code })).toEqual([]);
  });

  it('warns about unresolvable references', () => {
    const { code, warnings } = generateFromText(`
openapi: 3.0.0
info: { title: t, version: '1' }
paths: {}
components:
  schemas:
    A: { $ref: './other.yaml#/B' }
`);
    expect(code).toContain('export type A = unknown;');
    expect(warnings).toEqual(['unresolvable $ref "./other.yaml#/B" rendered as unknown']);
  });

  it('rejects Swagger 2.0', () => {
    expect(() => generateFromText('swagger: "2.0"\ninfo: {}\npaths: {}')).toThrow(/Swagger 2.0/);
  });
});
