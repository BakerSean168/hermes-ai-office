# Hermes AI Office Documentation

This directory contains the product and architecture source of truth for the Hermes AI Office work.

## Start here

1. [`HERMES-AI-OFFICE-PRD.md`](HERMES-AI-OFFICE-PRD.md) — what the product is for and what user outcomes it must provide.
2. [`DOMAIN-MODEL-V2.md`](DOMAIN-MODEL-V2.md) — authoritative business model and terminology.
3. [`implementation-v2/README.md`](implementation-v2/README.md) — implementation-preparation package for the V2 migration.

## V2 implementation package

- [`implementation-v2/ARCHITECTURE.md`](implementation-v2/ARCHITECTURE.md)
- [`implementation-v2/GATEWAY-STRATEGY.md`](implementation-v2/GATEWAY-STRATEGY.md)
- [`implementation-v2/PERSISTENCE.md`](implementation-v2/PERSISTENCE.md)
- [`implementation-v2/API-CONTRACT.md`](implementation-v2/API-CONTRACT.md)
- [`implementation-v2/EVENT-CONTRACT.md`](implementation-v2/EVENT-CONTRACT.md)
- [`implementation-v2/WORKFLOWS.md`](implementation-v2/WORKFLOWS.md)
- [`implementation-v2/PROJECTIONS.md`](implementation-v2/PROJECTIONS.md)
- [`implementation-v2/MIGRATION.md`](implementation-v2/MIGRATION.md)
- [`implementation-v2/ROADMAP.md`](implementation-v2/ROADMAP.md)
- [`implementation-v2/VERIFICATION.md`](implementation-v2/VERIFICATION.md)

## Historical implementation specs

Repository-root `SPEC-*` files and `hermes-office-bridge/SPEC-*` document earlier implementation phases. They remain useful implementation history but do not override Domain Model V2.

## Authority rule

When documents disagree:

1. product intent/scope -> PRD;
2. business identity/lifecycle semantics -> Domain Model V2;
3. engineering implementation contract -> V2 implementation package;
4. historical `SPEC-*` -> evidence of past implementation only.
