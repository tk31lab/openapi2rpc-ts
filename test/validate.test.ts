import { describe, expect, it, vi } from 'vitest';
import {
  Code,
  createFetchTransport,
  PetsServiceClient,
  RpcError,
  StoreServiceClient,
  validateValue,
  type ValidationIssue,
} from './fixtures/petstore.validate.generated.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function clientReturning(body: unknown, validateResponses?: boolean) {
  const fetch = vi.fn(async () => json(body));
  const transport = createFetchTransport({
    baseUrl: 'https://api.example.com',
    fetch,
    ...(validateResponses === undefined ? {} : { validateResponses }),
  });
  return { pets: new PetsServiceClient(transport), store: new StoreServiceClient(transport) };
}

async function rpcError(promise: Promise<unknown>): Promise<RpcError> {
  const err = await promise.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(RpcError);
  return err as RpcError;
}

const pet = { id: 1, name: 'Pochi', status: 'available' };

describe('--validate', () => {
  it('accepts responses that match the schema, including unknown extra fields', async () => {
    const { pets } = clientReturning({
      ...pet,
      tag: null,
      owner: { kind: 'shop', shopId: 's1' },
      attributes: { color: 'white' },
      addedLater: 'servers may add fields',
    });
    await expect(pets.getPet({ petId: 1 })).resolves.toMatchObject({ name: 'Pochi' });
  });

  it('rejects a missing required field with INTERNAL and the path', async () => {
    const { pets } = clientReturning({ pets: [pet, { id: 2, status: 'sold' }] });
    const err = await rpcError(pets.listPets());
    expect(err.code).toBe(Code.INTERNAL);
    expect(err.message).toBe('invalid response from PetsService.listPets: $.pets[1].name: required');
    expect(err.httpStatus).toBe(200);
    const details = err.details as { issues: ValidationIssue[]; body: unknown };
    expect(details.issues).toEqual([{ path: '$.pets[1].name', message: 'required' }]);
    expect(details.body).toEqual({ pets: [pet, { id: 2, status: 'sold' }] });
  });

  it('reports wrong types, enum values and nulls', async () => {
    const { pets } = clientReturning({ id: '1', name: 'Pochi', status: 'lost', birthday: null });
    const err = await rpcError(pets.getPet({ petId: 1 }));
    expect((err.details as { issues: ValidationIssue[] }).issues).toEqual([
      { path: '$.id', message: 'expected integer, got string "1"' },
      { path: '$.status', message: 'expected one of "available", "pending-review", "sold", got string "lost"' },
      { path: '$.birthday', message: 'expected string, got null' },
    ]);
    expect(err.message).toMatch(/\$\.id: expected integer, got string "1" \(and 2 more\)$/);
  });

  it('checks oneOf variants and map values', async () => {
    const { pets, store } = clientReturning({ ...pet, owner: { kind: 'robot' } });
    const err = await rpcError(pets.getPet({ petId: 1 }));
    expect(err.message).toContain('$.owner: does not match any of 2 variants');

    const inventory = clientReturning({ available: 3, sold: 'many' }).store;
    const err2 = await rpcError(inventory.getInventory());
    expect(err2.message).toContain('$.sold: expected integer, got string "many"');
    await expect(store.getInventory()).rejects.toBeInstanceOf(RpcError); // body above is a Pet, not a map of integers
  });

  it('can be turned off per transport', async () => {
    const { pets } = clientReturning({ id: 'not-a-number' }, false);
    await expect(pets.getPet({ petId: 1 })).resolves.toEqual({ id: 'not-a-number' });
  });

  it('does not touch error responses', async () => {
    const fetch = vi.fn(async () => json({ unexpected: true }, 404));
    const pets = new PetsServiceClient(createFetchTransport({ baseUrl: 'https://api.example.com', fetch }));
    const err = await rpcError(pets.getPet({ petId: 1 }));
    expect(err.code).toBe(Code.NOT_FOUND);
  });
});

describe('validateValue', () => {
  it('handles refs, nullable unions, const, boolean schemas and issue limits', () => {
    const defs = { Id: { type: ['integer'] } } as const;
    expect(validateValue({ a: 1 }, { type: ['object'], properties: { a: { $ref: 'Id' } } }, defs)).toEqual([]);
    expect(validateValue(null, { anyOf: [{ type: ['null'] }, { $ref: 'Id' }] }, defs)).toEqual([]);
    expect(validateValue('x', { const: 'y' })).toEqual([{ path: '$', message: 'expected "y", got string "x"' }]);
    expect(validateValue(1, true)).toEqual([]);
    expect(validateValue(1, false)).toEqual([{ path: '$', message: 'no value is allowed here' }]);
    expect(validateValue({ 'a-b': 1 }, { type: ['object'], properties: { 'a-b': { type: ['string'] } } })).toEqual([
      { path: '$["a-b"]', message: 'expected string, got number 1' },
    ]);
    const many = Array.from({ length: 50 }, () => 'x');
    expect(validateValue(many, { type: ['array'], items: { type: ['integer'] } }, {}, 3)).toHaveLength(3);
  });
});
