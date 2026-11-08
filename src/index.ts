import { parse as parseYaml } from 'yaml';
import { generate, runtimeSource, type GenerateOptions, type GenerateResult } from './generator.js';
import type { Document } from './spec.js';

export { generate, runtimeSource };
export type { Document, GenerateOptions, GenerateResult };

/** Parses an OpenAPI 3.x document from YAML or JSON text. */
export function parseSpec(text: string): Document {
  const doc = parseYaml(text, { maxAliasCount: -1 }) as unknown;
  if (typeof doc !== 'object' || doc === null) throw new Error('OpenAPI document must be an object');
  const version = (doc as { openapi?: unknown }).openapi;
  if (typeof version !== 'string') {
    throw new Error((doc as { swagger?: unknown }).swagger ? 'Swagger 2.0 is not supported; convert it to OpenAPI 3.x first' : 'missing `openapi` version field');
  }
  if (!version.startsWith('3.')) throw new Error(`unsupported OpenAPI version ${version}`);
  return doc as Document;
}

/** Parses an OpenAPI document and generates TypeScript code from it. */
export function generateFromText(text: string, options?: GenerateOptions): GenerateResult {
  return generate(parseSpec(text), options);
}
