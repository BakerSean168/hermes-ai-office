# LiteLLM runtime gateway

LiteLLM is the single AI Office authority for provider credentials, physical deployments, logical aliases, retry/fallback, health, and spend.

Production stores models and credentials in LiteLLM's database. The checked-in `config.yaml` therefore keeps `model_list: []` and only declares stable routing behavior.

Logical aliases used by AI Office:

- `planning-premium -> gpt-5.6-sol`
- `review-premium -> gpt-5.6-sol`
- `implementation-efficient -> deepseek-v4-flash`

Provider and model mutation is performed through LiteLLM Admin. AI Office only reads the registry and correlated spend facts.

The economic deployment order is encoded directly in LiteLLM deployment metadata, so fallback stays inside the gateway rather than in Hermes or AI Office.
