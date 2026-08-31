import { assertDeliveryGate, type DeliveryEvidence, type DeliveryPolicy } from '../domain/delivery.js';
import { V4Error } from '../domain/errors.js';

export interface DeliveryPort {
  preparePullRequest(input: { repository: string; baseBranch: string; headSha: string }): { pullRequestId: string };
  merge?(input: { pullRequestId: string; expectedHeadSha: string }): { mergeSha: string };
  verify?(input: { repository: string; revision: string }): { verified: boolean; evidenceRef: string };
}

export class DeliveryKernel {
  constructor(readonly port?: DeliveryPort) {}

  validate(policy: DeliveryPolicy, evidence: DeliveryEvidence, currentHeadSha: string): void {
    assertDeliveryGate(policy, evidence, currentHeadSha);
  }

  prepare(policy: DeliveryPolicy, currentHeadSha: string): { repository: string; baseBranch: string; headSha: string } {
    if (!policy.autoMerge) throw new V4Error('DELIVERY_AUTHORIZATION_REQUIRED');
    if (policy.expectedHeadSha && policy.expectedHeadSha !== currentHeadSha) throw new V4Error('DELIVERY_SHA_STALE');
    return { repository: policy.targetRepository, baseBranch: policy.baseBranch, headSha: currentHeadSha };
  }

  merge(policy: DeliveryPolicy, evidence: DeliveryEvidence, currentHeadSha: string, pullRequestId: string): { mergeSha?: string; prepared: boolean } {
    this.validate(policy, evidence, currentHeadSha);
    if (!this.port?.merge) return { prepared: true };
    const result = this.port.merge({ pullRequestId, expectedHeadSha: currentHeadSha });
    if (result.mergeSha.length === 0) throw new V4Error('DELIVERY_MERGE_EVIDENCE_INVALID');
    return { prepared: true, mergeSha: result.mergeSha };
  }

  verifyPostMerge(repository: string, revision: string): { verified: boolean; evidenceRef?: string } {
    if (!this.port?.verify) return { verified: false };
    return this.port.verify({ repository, revision });
  }
}
