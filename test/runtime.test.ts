import { describe, expect, it, vi } from 'vitest';
import {
  Code,
  createClients,
  createFetchTransport,
  PetStatus,
  PetsServiceClient,
  RpcError,
  type Interceptor,
} from './fixtures/petstore.generated.js';

interface Captured {
  url: string;
  init: RequestInit;
}

function mockFetch(respond: (req: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const req = { url, init };
    calls.push(req);
    return respond(req);
  });
  return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-trace': 't1' } });

const pet = { id: 1, name: 'Pochi', status: 'available' };

describe('generated client over fetch', () => {
  it('transcodes path, query and header params', async () => {
    const { fetch, calls } = mockFetch(() => json({ pets: [pet] }));
    const pets = new PetsServiceClient(createFetchTransport({ baseUrl: 'https://api.example.com/v1/', fetch }));

    const page = await pets.listPets({ pageSize: 10, status: [PetStatus.AVAILABLE, PetStatus.SOLD] });
    expect(page.pets[0]?.name).toBe('Pochi');
    expect(calls[0]?.url).toBe('https://api.example.com/v1/pets?page_size=10&status=available&status=sold');
    expect(calls[0]?.init.method).toBe('GET');

    await pets.getPet({ petId: 42 });
    expect(calls[1]?.url).toBe('https://api.example.com/v1/pets/42');
  });

  it('sends JSON bodies, header params and metadata', async () => {
    const { fetch, calls } = mockFetch(() => json(pet, 201));
    const pets = new PetsServiceClient(
      createFetchTransport({ baseUrl: 'https://api.example.com', fetch, metadata: () => ({ authorization: 'Bearer t' }) }),
    );

    await pets.createPet({ xRequestId: 'req-1', body: { name: 'Pochi' } }, { metadata: { 'x-extra': '1' } });
    const headers = new Headers(calls[0]?.init.headers);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"name":"Pochi"}');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('X-Request-Id')).toBe('req-1');
    expect(headers.get('authorization')).toBe('Bearer t');
    expect(headers.get('x-extra')).toBe('1');
  });

  it('sends multipart bodies and decodes text responses', async () => {
    const { fetch, calls } = mockFetch(() => new Response('https://cdn/p.png', { headers: { 'content-type': 'text/plain' } }));
    const pets = new PetsServiceClient(createFetchTransport({ baseUrl: 'https://api.example.com', fetch }));

    const url = await pets.postPetsPhotoByPetId({ petId: 1, body: { file: new Blob(['png']), caption: 'hi' } });
    expect(url).toBe('https://cdn/p.png');
    const form = calls[0]?.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('caption')).toBe('hi');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('returns Empty for responses without content', async () => {
    const { fetch } = mockFetch(() => new Response(null, { status: 204 }));
    const pets = new PetsServiceClient(createFetchTransport({ baseUrl: 'https://api.example.com', fetch }));
    await expect(pets.deletePet({ petId: 1 })).resolves.toEqual({});
  });

  it('maps HTTP errors to RpcError with gRPC codes', async () => {
    const { fetch } = mockFetch(() => json({ code: 404, message: 'pet 9 not found' }, 404));
    const pets = new PetsServiceClient(createFetchTransport({ baseUrl: 'https://api.example.com', fetch }));

    const err = await pets.getPet({ petId: 9 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    const rpc = err as RpcError;
    expect(rpc.code).toBe(Code.NOT_FOUND);
    expect(rpc.codeName).toBe('NOT_FOUND');
    expect(rpc.message).toBe('pet 9 not found');
    expect(rpc.httpStatus).toBe(404);
    expect(rpc.details).toEqual({ code: 404, message: 'pet 9 not found' });
    expect(rpc.metadata['x-trace']).toBe('t1');
  });

  it('maps network failures to UNAVAILABLE', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const pets = new PetsServiceClient(createFetchTransport({ baseUrl: 'https://api.example.com', fetch }));
    await expect(pets.listPets()).rejects.toMatchObject({ code: Code.UNAVAILABLE, message: 'fetch failed' });
  });

  it('rejects missing path params with INVALID_ARGUMENT', async () => {
    const { fetch } = mockFetch(() => json(pet));
    const pets = new PetsServiceClient(createFetchTransport({ baseUrl: 'https://api.example.com', fetch }));
    await expect(pets.getPet({} as never)).rejects.toMatchObject({ code: Code.INVALID_ARGUMENT });
    expect(fetch).not.toHaveBeenCalled();
  });

  // a fetch that never answers but honours the abort signal, like the real one
  const hangingFetch = (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });

  it('enforces deadlines with DEADLINE_EXCEEDED', async () => {
    const pets = new PetsServiceClient(createFetchTransport({ baseUrl: 'https://api.example.com', fetch: hangingFetch }));
    await expect(pets.listPets({}, { timeoutMs: 20 })).rejects.toMatchObject({ code: Code.DEADLINE_EXCEEDED });
  });

  it('cancels with CANCELLED', async () => {
    const pets = new PetsServiceClient(createFetchTransport({ baseUrl: 'https://api.example.com', fetch: hangingFetch }));
    const controller = new AbortController();
    const call = pets.listPets({}, { signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toMatchObject({ code: Code.CANCELLED });
  });

  it('runs interceptors outermost-first', async () => {
    const order: string[] = [];
    const tag = (name: string): Interceptor => (next) => async (req) => {
      order.push(`${name}:${req.method.service}.${req.method.name}`);
      req.metadata = { ...req.metadata, [`x-${name}`]: '1' };
      const res = await next(req);
      order.push(`${name}:done`);
      return res;
    };
    const { fetch, calls } = mockFetch(() => json({ pets: [] }));
    const clients = createClients(createFetchTransport({ baseUrl: 'https://api.example.com', fetch, interceptors: [tag('a'), tag('b')] }));

    await clients.pets.listPets();
    expect(order).toEqual(['a:PetsService.listPets', 'b:PetsService.listPets', 'b:done', 'a:done']);
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('x-a')).toBe('1');
    expect(headers.get('x-b')).toBe('1');
  });

  it('accepts a custom transport (e.g. for tests)', async () => {
    const clients = createClients({
      unary: async <Req, Res>(method: { name: string }, request: Req) => ({ method: method.name, request }) as Res,
    });
    await expect(clients.store.getInventory()).resolves.toEqual({ method: 'getInventory', request: {} });
  });
});
