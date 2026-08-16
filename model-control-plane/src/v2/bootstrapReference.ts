import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from '../db.mjs';
import { runV2Migrations } from './migrations.js';
import { V2Repository } from './repository.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbFile = process.env.MODEL_CP_DB ?? path.resolve(here, '../../data/control-plane.sqlite');
const db = openDb(dbFile);
runV2Migrations(db);
const repository = new V2Repository(db);
const result = repository.bootstrapReference({
  supplierSlug: process.env.V2_REFERENCE_SUPPLIER_SLUG ?? 'planner-pool',
  supplierName: process.env.V2_REFERENCE_SUPPLIER_NAME ?? 'Planner Pool',
  supplierModelKey: process.env.V2_REFERENCE_MODEL_KEY ?? 'deepseek-v4-flash',
  supplierModelName: process.env.V2_REFERENCE_MODEL_NAME ?? 'DeepSeek V4 Flash',
  agreementRef: process.env.V2_REFERENCE_AGREEMENT_REF ?? 'planner-pool-primary',
  agreementName:
    process.env.V2_REFERENCE_AGREEMENT_NAME ?? 'Planner Pool Primary Compatibility Supply',
  gatewaySlug: process.env.V2_REFERENCE_GATEWAY_SLUG ?? 'litellm-reference',
  gatewayKind: 'LITELLM',
  gatewayName: process.env.V2_REFERENCE_GATEWAY_NAME ?? 'LiteLLM Reference Gateway',
  gatewayBaseUrlHint: process.env.LITELLM_BASE_URL ?? 'http://127.0.0.1:4000',
  workScopeSlug: process.env.V2_REFERENCE_SCOPE_SLUG ?? 'development',
  workScopeName: process.env.V2_REFERENCE_SCOPE_NAME ?? 'Development',
  externalProfileRef: process.env.V2_REFERENCE_PROFILE_REF ?? 'development',
  positionSlug: process.env.V2_REFERENCE_POSITION_SLUG ?? 'coding-review',
  positionName: process.env.V2_REFERENCE_POSITION_NAME ?? 'Coding Reviewer',
  positionKind: 'REVIEWER',
  runtimeKind: 'CODEX',
  protocol: 'openai-responses',
});

process.stdout.write(`${JSON.stringify(result)}\n`);
