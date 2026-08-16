# Hermes LiteLLM Reference Gateway

This deployment is the V2 reference implementation of the gateway ports. It is deliberately independent of the AI workforce domain database.

- Binds only to `127.0.0.1:4000` through host networking.
- Uses the digest-pinned LiteLLM v1.92.2 release image, whose container filesystem was verified as AArch64 on oracle2. The older v1.83.14-stable tag was rejected because its advertised ARM64 manifest contained x86-64 binaries.
- Stores provider/gateway credentials only in `/srv/hermes-personal/secrets/litellm.env` (`0600`).
- Starts with one controlled Employment-scoped route.
- Uses CPA as a temporary downstream compatibility upstream; existing production traffic remains on CPA.
- Does not require PostgreSQL or Redis for the first vertical slice.

Build the control-plane package, then bind an **already existing CURRENT Employment**. Gateway deployment never creates Supplier, Employee, Agreement, Appointment, or Employment identity:

```bash
npm run build --workspace @hermes/model-control-plane
sudo ./configure-reference-route.sh
```

Set `V2_REFERENCE_EMPLOYMENT_ID` for a new binding. If a current `employment:*` reference route is already present in the protected env file, the script may reuse that ID. The script validates the Employment against the V2 database, stores only the non-secret route name beside the gateway secrets, updates the CPA alias, restarts LiteLLM, and verifies the model list before retiring the previous reference alias. It never bootstraps business identity from a channel or model name.

Operational commands:

```bash
sudo systemctl status hermes-litellm
sudo journalctl -u hermes-litellm -f
curl http://127.0.0.1:4000/health/liveliness
```

The master key is never written to Git or printed by operational scripts.
