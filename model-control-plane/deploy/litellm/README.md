# Hermes LiteLLM Reference Gateway

This deployment is the V2 reference implementation of the gateway ports. It is deliberately independent of the AI workforce domain database.

- Binds LiteLLM only to `127.0.0.1:4000` through host networking.
- Uses a dedicated PostgreSQL instance bound to `127.0.0.1:54329` for LiteLLM technical state only. Business Supplier, Employee, Employment, Appointment, and usage-ledger identity remains in the Hermes domain database.
- Uses the digest-pinned LiteLLM v1.92.2 release image verified as AArch64 on oracle2.
- Stores the gateway master key, upstream compatibility key, and PostgreSQL credentials only in `/srv/hermes-personal/secrets/litellm.env` (`0600`).
- Stores the separate low-privilege runtime virtual key at `/srv/hermes-personal/data/secrets/litellm-runtime.key` (`0600`), never in OpenCode/Codex config.
- Starts with no config-owned model route. Any optional `employment:<employmentId>` gateway route must be provisioned explicitly through the DB-backed provisioning port.
- Each dynamic model route references a reusable LiteLLM Credential Store record instead of duplicating provider API keys into every deployment.
- Gateway retry/fallback stays inside one Employment route. Cross-Employment and cross-Employee decisions remain owned by Hermes Staffing.

## Bootstrap / upgrade

Build the control-plane package, then run:

```bash
sudo ./bootstrap-dynamic-gateway.sh
```

The bootstrap is idempotent. It preserves the LiteLLM master key and database credentials without printing them, creates the protected env file if it is missing, starts the dedicated PostgreSQL service, enables `store_model_in_db`, and creates a separate runtime virtual key. Historical config-owned Employment routes are intentionally not recreated. Gateway deployment never creates Supplier, Employee, Agreement, Appointment, or Employment identity from technical discovery.

## Dynamic onboarding flow

The intended path is:

```text
Hermes supplier onboarding
  -> create/reuse Supplier + SupplierModel + Employee + Employment
  -> gateway provisioning port
  -> LiteLLM Credential Store (one credential per SupplyAgreement)
  -> LiteLLM DB deployment named employment:<employmentId>
  -> Channel + GatewayBinding projection
  -> OpenCode/Codex runtime selector
```

Provider secrets cross the control-plane boundary only ephemerally during the explicit provisioning call. They are not stored in the Hermes business database, idempotency cache, events, Channel metadata, or runtime configuration.

## Operations

```bash
sudo systemctl status hermes-litellm
sudo journalctl -u hermes-litellm -f
curl http://127.0.0.1:4000/health/liveliness
```

The master key and runtime key are never written to Git or printed by operational scripts.
