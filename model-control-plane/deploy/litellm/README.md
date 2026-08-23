# LiteLLM runtime gateway

LiteLLM is the single AI Office authority for provider credentials, physical deployments, logical aliases, retry/fallback, health, and spend.

Production stores models and credentials in LiteLLM's database. The checked-in `config.yaml` therefore keeps `model_list: []` and only declares stable routing behavior.

Logical aliases used by AI Office:

- `planning-premium -> gpt-5.6-sol`
- `review-premium -> gpt-5.6-sol`
- `implementation-efficient -> deepseek-v4-flash`

Provider and model mutation is performed through LiteLLM Admin. AI Office only reads the registry and correlated spend facts.

The economic deployment order is encoded directly in LiteLLM deployment metadata, so fallback stays inside the gateway rather than in Hermes or AI Office.

## Admin UI dark theme

The pinned LiteLLM `v1.92.2` backend keeps its upstream dashboard intact and enables a dark UI with the published `darkreader@4.9.128` website API. The image build injects Dark Reader's Dynamic Theme into LiteLLM's exported dashboard HTML and serves the library locally from the existing `_next/static` asset path, so the dashboard does not depend on a browser extension or a third-party CDN at runtime.

This is intentionally separate from LiteLLM's still-unmerged upstream dashboard dark-mode work, allowing the gateway backend to remain pinned while providing a maintained third-party dark theme implementation.
