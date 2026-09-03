# LiteLLM runtime gateway

LiteLLM is the single AI Office authority for provider credentials, physical deployments, logical aliases, retry/fallback, health, and spend.

Production stores models and credentials in LiteLLM's database. The checked-in `config.yaml` therefore keeps `model_list: []` and only declares stable routing behavior.

Current compatibility aliases used by the pre-ADR-003 routing path:

- `planning-premium -> gpt-5.6-sol`
- `review-premium -> gpt-5.6-sol`
- `implementation-efficient -> deepseek-v4-flash`

These aliases are transitional. The target V4 model selector owns only two capabilities (`IMPLEMENTATION` and `REASONING`) and selects an approved model family before launching its model-native agent. LiteLLM therefore remains organized around canonical model-family groups such as `gpt-5.6-luna`, `gpt-5.6-sol`, `deepseek-v4-flash`, the current approved GLM model, `claude-opus-5`, and `claude-opus-4-8`; it must not become one cross-family `implementation` or `reasoning` group. See `docs/adr/ADR-003-static-model-agent-resource-routing.md`.

Provider and model mutation is performed through LiteLLM Admin. AI Office only reads the registry and correlated spend facts.

The versioned operational importer belongs to the infrastructure authority, not this repository: `my-infrastructure/etc/server/oracle2/hermes/provideradmin/hermes-litellm-providerctl.py` is installed on Oracle2 as `/usr/local/sbin/hermes-litellm-providerctl` and is the ProviderAdmin entry point for secure credential/deployment mutation. Keeping the mutator there prevents Pixel Agent from becoming a second provider authority.

The economic deployment order within one selected model family is encoded in LiteLLM deployment metadata. ADR-003 further requires a stable immutable resource sequence so same-tier providers no longer depend on equal-order shuffle. Pixel owns cross-model selection because the model family determines whether OpenHands launches DSH, ZCode, Codex, or Claude Code.

The current attempt-indexed review ladder (`review-premium -> codex-auto-review -> gpt-5.4`) is legacy behavior scheduled for removal by `docs/plan/active/2026-09-03-pixel-v4-routing-and-provider-governance.md`. New routing will re-run the deterministic `REASONING` resource selector rather than choosing a model because a review reached a particular attempt number.

## Admin UI dark theme

The pinned LiteLLM `v1.92.2` backend keeps its upstream dashboard intact and enables a dark UI with the published `darkreader@4.9.128` website API. The image build injects Dark Reader's Dynamic Theme into LiteLLM's exported dashboard HTML and serves the library locally from the existing `_next/static` asset path, so the dashboard does not depend on a browser extension or a third-party CDN at runtime.

This is intentionally separate from LiteLLM's still-unmerged upstream dashboard dark-mode work, allowing the gateway backend to remain pinned while providing a maintained third-party dark theme implementation.
