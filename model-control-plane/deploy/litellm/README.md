# LiteLLM runtime gateway

LiteLLM is the single AI Office authority for provider credentials, physical deployments, provider-local retry/cooldown, health, and spend.

Production stores models and credentials in LiteLLM's database. The checked-in `config.yaml` therefore keeps `model_list: []` and only declares stable routing behavior.

ADR-003 routing is active. Pixel owns only two capabilities (`IMPLEMENTATION` and `REASONING`), selects an approved model family and resource, persists that selection, and then launches the corresponding model-native agent. Every active LiteLLM binding therefore has a unique `route-<resource>-<model>` group. The checked-in gateway config has no cross-family alias or fallback: LiteLLM cannot silently turn DeepSeek into GLM, Sol into another reviewer, or a free resource into a metered relay.

The curated automatic model families are `gpt-5.6-luna`, `gpt-5.6-sol`, `deepseek-v4-flash`, the current approved GLM model, `claude-opus-5`, and `claude-opus-4-8`. Provider-native ChatGPT Business and Antigravity resources participate above LiteLLM through the same deterministic selector. See `docs/adr/ADR-003-static-model-agent-resource-routing.md`.

Provider and model mutation is performed through LiteLLM Admin. AI Office only reads the registry and correlated spend facts.

The versioned operational importer belongs to the infrastructure authority, not this repository: `my-infrastructure/etc/server/oracle2/hermes/provideradmin/hermes-litellm-providerctl.py` is installed on Oracle2 as `/usr/local/sbin/hermes-litellm-providerctl` and is the ProviderAdmin entry point for secure credential/deployment mutation. Keeping the mutator there prevents Pixel Agent from becoming a second provider authority.

The economic tier and immutable `resource_sequence` remain deployment metadata, but Pixel compares them before issuing any gateway request. A retry creates a new execution and re-runs the selector with the prior resource binding excluded. `codex-auto-review`, `planning-premium`, `review-premium`, `implementation-efficient`, and obsolete GPT 5.4/5.5 groups are retained only as blocked historical records during rollback retention; they are not automatic routes.

## Admin UI dark theme

The pinned LiteLLM `v1.92.2` backend keeps its upstream dashboard intact and enables a dark UI with the published `darkreader@4.9.128` website API. The image build injects Dark Reader's Dynamic Theme into LiteLLM's exported dashboard HTML and serves the library locally from the existing `_next/static` asset path, so the dashboard does not depend on a browser extension or a third-party CDN at runtime.

This is intentionally separate from LiteLLM's still-unmerged upstream dashboard dark-mode work, allowing the gateway backend to remain pinned while providing a maintained third-party dark theme implementation.
