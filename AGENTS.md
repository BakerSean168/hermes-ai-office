# Agent instructions

## Oracle2 Hermes deployment safety

The production Hermes instance on oracle2 serves multiple long-running profiles
through one multiplexed gateway, including MemoFlow. AI Office development must
not recreate the `hermes-personal` container just to load plugin changes.

For AI Office deployment, always use:

```bash
sudo /usr/local/sbin/hermes-ai-office-deploy --deploy
```

The deployer classifies changes and enforces these rules:

- `dashboard/**`, docs, tests, and deployment-script changes are hot-synced with
  no Gateway restart.
- runtime plugin changes are staged while any Agent turn/session is active.
- pending runtime changes are automatically activated by a systemd reconcile
  timer after Hermes becomes idle.
- runtime activation first requests Hermes' native drain (which refuses new
  turns), then syncs the plugin and invokes Hermes' native Gateway restart API.
- the Docker container and Dashboard process are not recreated.

Do **not** run `docker compose up -d --force-recreate hermes`, `docker restart
hermes-personal`, or an equivalent container replacement for an AI Office
plugin/dashboard update. Container recreation is reserved for actual image,
environment, volume, or Compose changes and must only be done in an explicit
maintenance operation after `hermes-ai-office-deploy --guard-only` confirms
that the multiplexed Gateway has no active work.
