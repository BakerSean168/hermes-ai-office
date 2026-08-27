# AI Office contracts

`dashboard.schema.json` is the single backend-to-frontend contract for the AI Office console.

Rules:

- `dashboard/plugin_api/` is the producer; `dashboard/dist/index.js` is the consumer.
- Field aliases and compatibility fallbacks are not supported. If the producer shape changes, update the contract and consumer in the same change.
- Control Plane source paths are documented with `x-control-plane-source`; derived fields use `x-derived`.
- `schemaVersion` is owned by this contract. The frontend rejects an unexpected version instead of silently guessing a shape.
- Contract tests verify the producer DTO keys and the consumer's expected schema version.
