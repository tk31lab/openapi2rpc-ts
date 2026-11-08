import { describe, expect, it } from 'vitest';
import { camel, constName, pascal, propKey, words } from '../src/names.js';

describe('names', () => {
  it('splits words', () => {
    expect(words('get-pet_by.ID')).toEqual(['get', 'pet', 'by', 'ID']);
    expect(words('HTTPServerError')).toEqual(['HTTP', 'Server', 'Error']);
    expect(words('petId2')).toEqual(['pet', 'Id2']);
  });

  it('converts cases', () => {
    expect(pascal('pet.status')).toBe('PetStatus');
    expect(pascal('3dModel')).toBe('_3dModel');
    expect(camel('X-Request-Id')).toBe('xRequestId');
    expect(camel('get_pet')).toBe('getPet');
    expect(camel('ID')).toBe('id');
    expect(constName('pending-review')).toBe('PENDING_REVIEW');
    expect(constName('inStock')).toBe('IN_STOCK');
    expect(constName('1st')).toBe('_1ST');
    expect(constName('')).toBe('EMPTY');
  });

  it('quotes non-identifier keys', () => {
    expect(propKey('name')).toBe('name');
    expect(propKey('legacy-code')).toBe('"legacy-code"');
  });
});
