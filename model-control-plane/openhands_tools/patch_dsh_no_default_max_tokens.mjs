#!/usr/bin/env node
import crypto from 'node:crypto';
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

const expectedFiles = {
  runtime: {
    path: runtimePath,
    pristine: 'eed9492246cc6451f060de211768d3128388046478deae7f1959de7cde56ea82',
    patched: 'df59cf7f76da6a8ac3df8e1f98452b99f6633bcb4e566999460df786ec15212c',
  },
  types: {
    path: typesPath,
    pristine: '8a8dc18b5c0f17ca0fb48e6ed2f1e7b1c3042258f4f86e024c9fbe71822b0f22',
    patched: 'e62542cb48c11c7c6ddb4d161c355d165b61d456acbc8cec88b96a10a369ca83',
  },
};

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readKnownFile(spec, label) {
  const value = fs.readFileSync(spec.path, 'utf8');
  const digest = sha256(value);
  if (digest !== spec.pristine && digest !== spec.patched) {
    throw new Error(`DSH no-default-max-tokens patch drift at ${label}: unexpected SHA-256`);
  }
  return { value, digest };
}

function replacePristine(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`DSH no-default-max-tokens patch drift at ${label}`);
  }
  if (source.includes(after)) {
    throw new Error(
      `DSH no-default-max-tokens patch drift at ${label}: mixed pristine/patched state`,
    );
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const runtimeState = readKnownFile(expectedFiles.runtime, 'runtime');
const typesState = readKnownFile(expectedFiles.types, 'types');
if (
  (runtimeState.digest === expectedFiles.runtime.patched) !==
  (typesState.digest === expectedFiles.types.patched)
) {
  throw new Error('DSH no-default-max-tokens patch drift: mixed file-generation state');
}

if (runtimeState.digest === expectedFiles.runtime.pristine) {
  let runtime = runtimeState.value;
  runtime = replacePristine(
    runtime,
    '\t\t\tdefaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,',
    '\t\t\t...configured?.maxTokens === void 0 && connection.maxTokens === void 0 ? {} : { defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens },',
    'modelInfoFor.defaultMaxTokens',
  );
  runtime = replacePristine(
    runtime,
    '\tmaxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),',
    '\tmaxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),',
    'Config.maxTokens',
  );
  runtime = replacePristine(
    runtime,
    '\t\tmaxTokens: config.maxTokens ?? 256e3,',
    '\t\t...config.maxTokens === void 0 ? {} : { maxTokens: config.maxTokens },',
    'resolveAdapterOptions.maxTokens',
  );

  let types = typesState.value;
  types = replacePristine(
    types,
    '    /** Default per-request output cap; explicit request values win. */\n    maxTokens: number;',
    '    /** Optional per-request output cap; omission leaves the provider request uncapped by DSH. */\n    maxTokens?: number;',
    'DeepSeekConnectionOptions.maxTokens',
  );

  if (sha256(runtime) !== expectedFiles.runtime.patched) {
    throw new Error('DSH no-default-max-tokens patch drift: patched runtime SHA-256 mismatch');
  }
  if (sha256(types) !== expectedFiles.types.patched) {
    throw new Error('DSH no-default-max-tokens patch drift: patched types SHA-256 mismatch');
  }
  fs.writeFileSync(runtimePath, runtime);
  fs.writeFileSync(typesPath, types);
}

// Re-read both files so the success path is tied to the exact post-patch bytes,
// including the idempotent already-patched case.
if (sha256(fs.readFileSync(runtimePath)) !== expectedFiles.runtime.patched) {
  throw new Error('DSH no-default-max-tokens patch drift: runtime final SHA-256 mismatch');
}
if (sha256(fs.readFileSync(typesPath)) !== expectedFiles.types.patched) {
  throw new Error('DSH no-default-max-tokens patch drift: types final SHA-256 mismatch');
}

console.log(`patched @deepseek-ai/dsh-llm-deepseek@${pkg.version}: implicit maxTokens disabled`);
