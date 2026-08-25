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

## Secure OpenAI-compatible provider import

Oracle2 installs `providerctl.py` as `/usr/local/sbin/hermes-litellm-providerctl` for
credential-bearing imports initiated by Hermes. This is an operational wrapper around
LiteLLM Admin; it does **not** introduce a second provider registry.

The importer:

- reads the upstream key from a mode-`0600` file, stdin, or a hidden TTY prompt — never a CLI argument;
- probes `<base>/models` and the `/v1` alternate, then stores the working canonical API base;
- can restrict discovery to GPT chat models and excludes image/audio/realtime/transcription surfaces;
- creates one LiteLLM credential and points every deployment at it with `litellm_credential_name`;
- writes `legacy_provider_key`, `commercial_type`, `protocol`, and `supply_origin` metadata consumed by the V3 model registry;
- maps economic class to deployment order (`FREE`/`SPONSORED` 20, `SUBSCRIPTION` 30, `METERED` 40, `OTHER` 60);
- refuses an implicit credential overwrite. `--reuse-existing-credential` exists only for intentionally resuming a partial import.

Always probe before persistence. For a commercial OpenAI-compatible relay:

```bash
sudo /usr/local/sbin/hermes-litellm-providerctl \
  --name example-relay \
  --display-name 'Example Relay' \
  --base-url https://example.invalid \
  --family gpt \
  --commercial-type METERED

sudo /usr/local/sbin/hermes-litellm-providerctl \
  --name example-relay \
  --display-name 'Example Relay' \
  --base-url https://example.invalid \
  --family gpt \
  --commercial-type METERED \
  --apply
```

The first command is a dry run. In both cases the key is requested without echo when a
TTY is available. Agent-driven use should write the supplied key to a temporary mode-`0600`
file, pass `--key-file`, then securely remove the file after the command returns.
