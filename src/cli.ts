#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { generateFromText, runtimeSource } from './index.js';

const USAGE = `Usage: openapi2rpc-ts -i <openapi.yaml> [-o <out.ts>] [options]

Generates gRPC-style TypeScript clients from an OpenAPI 3.x definition.

Options:
  -i, --input <file>            OpenAPI document (YAML or JSON). "-" reads stdin
  -o, --output <file>           Output file (default: stdout)
      --runtime-import <module> Import the runtime from <module> instead of embedding it
      --emit-runtime <file>     Write the runtime to <file> (use with --runtime-import)
  -h, --help                    Show this help
`;

function writeOut(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function main(): number {
  let args;
  try {
    args = parseArgs({
      options: {
        input: { type: 'string', short: 'i' },
        output: { type: 'string', short: 'o' },
        'runtime-import': { type: 'string' },
        'emit-runtime': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args['emit-runtime']) writeOut(args['emit-runtime'], runtimeSource());
  if (!args.input) {
    if (args['emit-runtime']) return 0;
    process.stderr.write(USAGE);
    return 2;
  }

  const text = readFileSync(args.input === '-' ? 0 : args.input, 'utf8');
  let result;
  try {
    result = generateFromText(text, { runtimeImport: args['runtime-import'] });
  } catch (err) {
    process.stderr.write(`openapi2rpc-ts: ${(err as Error).message}\n`);
    return 1;
  }
  for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
  if (args.output) writeOut(args.output, result.code);
  else process.stdout.write(result.code);
  return 0;
}

process.exitCode = main();
