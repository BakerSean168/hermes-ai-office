# Hermes LiteLLM Runtime Gateway

LiteLLM is the single provider/model runtime authority for AI Office V3 on oracle2.
Provider credentials, DB-backed model deployments, model-group aliases, routing,
health/cooldown state, and spend all terminate here. AI Office projects this state
read-only; provider/model mutations belong to LiteLLM Admin/API.

## Production boundary

- LiteLLM listens only on `127.0.0.1:4000`.
- PostgreSQL listens only on `127.0.0.1:54329` and stores LiteLLM technical state.
- The pinned LiteLLM image is AArch64-compatible and digest-pinned in `docker-compose.yml`.
- `/srv/hermes-personal/secrets/litellm.env` contains the master key and PostgreSQL secrets and stays outside Git.
- `/srv/hermes-personal/data/secrets/litellm-runtime.key` contains the scoped runtime virtual key used by workers.
- Tailnet-only Admin UI: `https://<tailnet-host>:10446/ui/` -> `127.0.0.1:4000` through Tailscale Serve. The real host name stays in the root-owned V3 runtime env file, not Git.
- The master key is used only by the control plane/Admin UI. OpenHands/OpenCode workers never receive it.

`config.yaml` intentionally contains no provider endpoint or provider API key and no
config-owned deployment. It only defines router behavior plus stable V3 aliases:

```text
planning-premium        -> gpt-5.6-sol
review-premium          -> gpt-5.6-sol
implementation-efficient -> deepseek-v4-flash
```

Physical deployments and reusable Credential Store entries are DB-backed and editable
through LiteLLM Admin. Deployment `order` implements economics/qualification priority
inside a model group while LiteLLM health/cooldown removes unhealthy candidates.

## Provider Hub cutover

The one-time migration is:

```bash
model-control-plane/scripts/migrate-provider-hub-to-litellm.py
```

It migrates safe Provider Hub metadata into LiteLLM Credential Store + DB deployments
without printing credential values. The old V2 Provider Hub tables are deliberately
left untouched as rollback/forensic evidence, but they are not the current V3 provider
runtime authority and are no longer exposed as the AI Office provider-management UI.

The migration preserves:

- stable provider identity in deployment metadata;
- protocol and supply-origin metadata;
- commercial type and economics-derived `order`;
- qualified primary/fallback order for validated V3 routes;
- deployment-level economics overrides when one credential exposes both free and paid
  model codes (for example DeepSeek V4 Flash FREE -> SUBSCRIPTION -> METERED);
- canonical API-root corrections for legacy rows whose historical URL is no longer a
  valid OpenAI-compatible endpoint;
- paused/active state translated to LiteLLM `blocked` state.

## Bootstrap / upgrade

Build the model control plane first, then bootstrap LiteLLM:

```bash
sudo ./bootstrap-dynamic-gateway.sh
```

The bootstrap is idempotent. It preserves the master key/database credentials without
printing them, enables DB-backed model storage, starts PostgreSQL + LiteLLM, and creates
the scoped runtime key when needed.

A normal provider/model change does **not** require editing `config.yaml`: use the
LiteLLM Admin UI/API. Restart LiteLLM only when router/global configuration changes.

## Operations

```bash
sudo systemctl status hermes-litellm
sudo journalctl -u hermes-litellm -f
curl http://127.0.0.1:4000/health/liveliness
curl http://127.0.0.1:8320/api/v3/development/model-registry
```

The last endpoint is the secret-free registry projection consumed by AI Office. It
returns credential names, deployment metadata, aliases and counts, never credential
values or provider API keys.
