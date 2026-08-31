#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const packageRoot = process.argv[2];
if (!packageRoot) {
  console.error('usage: patch_dsh_no_default_max_tokens.mjs <dsh-llm-deepseek-package-root>');
  process.exit(2);
}

const packageJsonPath = path.join(packageRoot, 'package.json');
const runtimePath = path.join(packageRoot, 'lib', 'index.js');
const typesPath = path.join(packageRoot, 'lib', 'types', 'adapter.d.ts');
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const expectedVersion = '0.1.1-rc.2';
if (pkg.version !== expectedVersion) {
  throw new Error(
    `unsupported @deepseek-ai/dsh-llm-deepseek version: ${pkg.version}; expected ${expectedVersion}`,
  );
}

function replaceExactly(source, before, after, label) {
  if (source.includes(after)) return source;
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`DSH no-default-max-tokens patch drift at ${label}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

let runtime = fs.readFileSync(runtimePath, 'utf8');
runtime = replaceExactly(
  runtime,
  '\t\t\tdefaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,',
  '\t\t\t...configured?.maxTokens === void 0 && connection.maxTokens === void 0 ? {} : { defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens },',
  'modelInfoFor.defaultMaxTokens',
);
runtime = replaceExactly(
  runtime,
  '\tmaxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),',
  '\tmaxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),',
  'Config.maxTokens',
);
runtime = replaceExactly(
  runtime,
  '\t\tmaxTokens: config.maxTokens ?? 256e3,',
  '\t\t...config.maxTokens === void 0 ? {} : { maxTokens: config.maxTokens },',
  'resolveAdapterOptions.maxTokens',
);
fs.writeFileSync(runtimePath, runtime);

let types = fs.readFileSync(typesPath, 'utf8');
types = replaceExactly(
  types,
  '    /** Default per-request output cap; explicit request values win. */\n    maxTokens: number;',
  '    /** Optional per-request output cap; omission leaves the provider request uncapped by DSH. */\n    maxTokens?: number;',
  'DeepSeekConnectionOptions.maxTokens',
);
fs.writeFileSync(typesPath, types);

console.log(`patched @deepseek-ai/dsh-llm-deepseek@${pkg.version}: implicit maxTokens disabled`);
