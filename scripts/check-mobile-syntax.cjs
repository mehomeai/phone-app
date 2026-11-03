#!/usr/bin/env node
// Repo syntax check (NOT a full typecheck).
//
// Parses every TS/TSX file under apps/mobile + portable src with the mobile
// TypeScript compiler's transpileModule (syntax + JSX only). This catches
// syntax errors without the disk-heavy full `tsc -p` install graph.
//
// Compiler resolution (no hardcoded usernames in-repo):
//   1. MOBILE_TYPESCRIPT_PATH env var (explicit override, e.g. absolute path
//      to typescript.js for local checks without installs).
//   2. require.resolve('typescript') from apps/mobile (installed compiler).
//   3. require.resolve('typescript') from the repo root.
// If none resolve, exits 2 with a clear message.
//
// Usage:
//   node scripts/check-mobile-syntax.cjs
//   MOBILE_TYPESCRIPT_PATH=/abs/path/to/typescript.js node scripts/check-mobile-syntax.cjs
//
// Exit 0 = all files parsed; exit 1 = syntax errors; exit 2 = no compiler.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MOBILE_DIR = path.join(ROOT, 'apps', 'mobile');
const PORTABLE_DIR = path.join(ROOT, 'src');

function resolveCompiler() {
  const override = process.env.MOBILE_TYPESCRIPT_PATH || process.env.TYPESCRIPT_MODULE_PATH;
  if (override) {
    try {
      return require(override);
    } catch (error) {
      console.error(`Could not load TypeScript from override ${override}: ${error.message}`);
      process.exit(2);
    }
  }
  const candidates = [
    () => require.resolve('typescript', { paths: [MOBILE_DIR] }),
    () => require.resolve('typescript', { paths: [ROOT] }),
    () => require.resolve('typescript'),
  ];
  for (const get of candidates) {
    try {
      const resolved = get();
      return require(resolved);
    } catch {
      // Try next.
    }
  }
  console.error(
    'No TypeScript compiler found. Install apps/mobile deps or set MOBILE_TYPESCRIPT_PATH to an absolute typescript.js.',
  );
  process.exit(2);
}

function collectFiles(dirs, extensions) {
  const out = [];
  const stack = [...dirs];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.expo' || entry.name === 'dist') continue;
        stack.push(full);
      } else if (extensions.has(path.extname(entry.name))) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function main() {
  const ts = resolveCompiler();
  const compilerPath = ts._compilerPath || ts.version || 'unknown';
  const files = collectFiles([MOBILE_DIR, PORTABLE_DIR], new Set(['.ts', '.tsx']));
  let ok = 0;
  const failures = [];
  for (const file of files) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (error) {
      failures.push({ file, message: `read failed: ${error.message}` });
      continue;
    }
    try {
      const result = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactNative,
          allowImportingTsExtensions: true,
        },
        fileName: file,
        reportDiagnostics: true,
      });
      const syntaxErrors = (result.diagnostics ?? []).filter(
        (d) => d.category === ts.DiagnosticCategory.Error,
      );
      if (syntaxErrors.length > 0) {
        const message = syntaxErrors
          .map((d) => (typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText))
          .join('; ');
        failures.push({ file, message });
      } else {
        ok += 1;
      }
    } catch (error) {
      failures.push({ file, message: error.message });
    }
  }
  console.log(`compiler: ${compilerPath}`);
  console.log(`checked: ${files.length} files (${ok} ok, ${failures.length} failed)`);
  console.log('NOTE: syntax-only transpile; NOT a full typecheck.');
  if (failures.length > 0) {
    for (const failure of failures.slice(0, 20)) {
      console.log(`FAIL ${path.relative(ROOT, failure.file)}: ${failure.message}`);
    }
    process.exit(1);
  }
}

main();
