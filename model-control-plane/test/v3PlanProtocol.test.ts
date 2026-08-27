import assert from 'node:assert/strict';
import test from 'node:test';

import { parseExternalProgressAudit, parseOrchestrationProposal } from '../src/v3/plan/protocol.js';

test('plan orchestration protocol accepts fenced JSON and normalizes bounded graph fields', () => {
  const proposal = parseOrchestrationProposal(`\n\`\`\`json\n${JSON.stringify({
    analysisSummary: 'Repository-backed plan.',
    batches: [{
      key: 'batch-1',
      title: 'First batch',
      dependsOn: [],
      workItems: [{
        key: 'TASK-1',
        title: 'Task',
        objective: 'Implement task.',
        acceptanceCriteria: ['Focused test passes.'],
      }],
    }],
  })}\n\`\`\`\n`);

  assert.equal(proposal.analysisSummary, 'Repository-backed plan.');
  assert.equal(proposal.batches[0]?.workItems[0]?.key, 'TASK-1');
});

test('external progress audit requires one explicit verdict for every requested work item', () => {
  assert.throws(
    () => parseExternalProgressAudit(
      JSON.stringify({
        candidateRevision: 'candidate',
        safeToAdopt: true,
        analysisSummary: 'Checked repository evidence.',
        blockedBatch: { key: 'batch-3', resolved: true, evidence: 'Integrated.' },
        workItems: [{ key: 'TASK-1', status: 'VERIFIED_COMPLETE', evidence: 'test' }],
        risks: [],
      }),
      'candidate',
      'batch-3',
      new Set(['TASK-1', 'TASK-2']),
    ),
    /EXTERNAL_PROGRESS_AUDIT_INCOMPLETE/,
  );
});

test('external progress audit rejects a result for a different pinned revision', () => {
  assert.throws(
    () => parseExternalProgressAudit(
      JSON.stringify({
        candidateRevision: 'moved',
        safeToAdopt: true,
        analysisSummary: 'Checked repository evidence.',
        blockedBatch: { key: 'batch-3', resolved: true, evidence: 'Integrated.' },
        workItems: [],
        risks: [],
      }),
      'candidate',
      'batch-3',
      new Set(),
    ),
    /EXTERNAL_PROGRESS_AUDIT_REVISION_MISMATCH/,
  );
});
