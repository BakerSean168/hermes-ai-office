# Hermes LiteLLM Reference Gateway

This deployment is the V2 reference implementation of the gateway ports. It is deliberately independent of the AI workforce domain database.

- Binds only to `127.0.0.1:4000` through host networking.
- Uses the digest-pinned LiteLLM v1.92.2 release image, whose container filesystem was verified as AArch64 on oracle2. The older v1.83.14-stable tag was rejected because its advertised ARM64 manifest contained x86-64 binaries.
- Stores provider/gateway credentials only in `/srv/hermes-personal/secrets/litellm.env` (`0600`).
- Starts with one controlled Employment-scoped route.
- Uses CPA as a temporary downstream compatibility upstream; existing production traffic remains on CPA.
- Does not require PostgreSQL or Redis for the first vertical slice.

Operational commands:

```bash
sudo systemctl status hermes-litellm
sudo journalctl -u hermes-litellm -f
curl http://127.0.0.1:4000/health/liveliness
```

The master key is never written to Git or printed by operational scripts.
