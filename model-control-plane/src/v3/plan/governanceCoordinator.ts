import type { GitHubGovernanceStatusPort } from '../githubGovernanceStatus.js';
import { PlanRepository } from '../plans.js';

export class GovernanceCoordinator {
  readonly #repository: PlanRepository;
  readonly #status?: GitHubGovernanceStatusPort;

  constructor(options: { repository: PlanRepository; status?: GitHubGovernanceStatusPort }) {
    this.#repository = options.repository;
    this.#status = options.status;
  }

  async reconcile(planId: string): Promise<void> {
    const plan = this.#repository.get(planId);
    if (!plan?.governanceStatusRequired || !this.#status) return;
    if (plan.source.kind !== 'EXTERNAL_CHANGE' || plan.source.origin?.kind !== 'GITHUB_PULL_REQUEST') return;
    const revision = plan.externalHeadRevision ?? plan.source.revision;
    if (plan.governanceStatusRevision === revision && plan.governanceStatusPlanStatus === plan.status) return;
    try {
      const publication = await this.#status.publish({
        repositoryPath: plan.repositoryPath,
        repository: plan.source.origin.repository,
        pullRequestNumber: plan.source.origin.pullRequestNumber,
        pullRequestUrl: plan.source.origin.pullRequestUrl,
        expectedHeadRevision: revision,
        previousHeadRevision:
          plan.externalHeadRevision && plan.externalHeadRevision !== plan.source.revision
            ? plan.source.revision
            : undefined,
        repairPublishedAt:
          plan.externalHeadRevision && plan.externalHeadRevision !== plan.source.revision
            ? plan.externalHeadPublishedAt
            : undefined,
        planId: plan.planId,
        planStatus: plan.status,
        blockedReason: plan.blockedReason,
      });
      const exactHeadPublished =
        publication.published !== false &&
        !publication.stale &&
        publication.observedHeadRevision === revision;
      const supersededHeadHandled =
        publication.published !== false &&
        publication.stale &&
        publication.superseded === true &&
        publication.observedHeadRevision !== revision;
      if (exactHeadPublished || supersededHeadHandled) {
        this.#repository.setGovernanceStatusPublished(plan.planId, revision, plan.status);
      }
    } catch {
      // Governance status is a retryable side effect, not plan truth. Leave the
      // publication fingerprint stale so periodic reconciliation retries it.
    }
  }
}
