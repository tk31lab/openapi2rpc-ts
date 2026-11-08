import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

/** Type-checks TypeScript sources with strict settings and returns the diagnostics as text. */
export function typecheck(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'openapi2rpc-ts-'));
  const paths = Object.entries(files).map(([name, code]) => {
    const p = join(dir, name);
    writeFileSync(p, code);
    return p;
  });
  const program = ts.createProgram(paths, {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noImplicitOverride: true,
    noUnusedLocals: true,
    verbatimModuleSyntax: true,
    isolatedModules: true,
    types: [],
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => `${d.file ? `${d.file.fileName.slice(dir.length + 1)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}: ` : ''}${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
}
