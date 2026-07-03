# Dead code to remove — logical-tier machinery (SPEC-016 revised / Omnigent adoption)

**Status:** scheduled for removal (marked `@deprecated` / banner-commented in place).

The Omnigent adoption made agents declare their own harness + model + provider in their image
`executor` block; dispatch sends that model directly on `SendMessageInput.model` via the
`AgentRegistry`. That removed the old **role → logical tier → registry-resolved model → instance**
routing from the live path. The modules that implemented it still compile but are unused, kept only
so the removal is a clean, separate, reviewable change.

Delete these together; nothing on the live path imports them (only their own tests + each other).

## Remove entirely
- `packages/coordinator/src/session-router.ts` + `packages/coordinator/test/session-router.test.ts`
  — the `SessionRouter` (role→instance routing, blocked-slot tracking). No `src/` importer.

## Remove the tier engine from `packages/coordinator/src/registry.ts`
Delete the resolver + tier helpers; **keep** the config + projection types:
- **Remove:** `RegistryResolver`, `tierLabelFor`, `blockKey`, `parseModel`, `modelMatchesCatalog`,
  `ModelSelection`, `InstanceProjection`, `RegistryInstanceStatus`, `RosterResolution`,
  `CatalogValidationProblem`, `CatalogValidationResult`, `NoInstanceForTierError`,
  `UnknownRoleError`, `RegistryConfigError`, and the `ModelTier`-typed `tier` fields on `ServesEntry`
  / `RosterEntry`. Also `packages/coordinator/test/registry.test.ts`.
- **KEEP (still live):**
  - `ServesEntry`, `InstanceConfig`, `RosterEntry`, `RegistryConfig` — used by the SPEC-019 **global
    harness-connect** flow (`global-config.ts`, `descriptorFor` in `server.ts`, `parseInstances` in
    `registry-config.ts`). These describe a *connected harness endpoint + credentialsRef*, orthogonal
    to model resolution. (When removed above, `ServesEntry.tier`/`RosterEntry.tier` become vestigial
    fields on otherwise-live types — drop the fields, keep the types.)
  - `HarnessStatus`, `AgentRosterEntry`, `RegistrySnapshot`, `RegistryWarning`, `RegistryWarningReason`
    — the current registry projection shape (built in `ProjectContext.refreshRegistry`).

## Remove the dead exports from `packages/coordinator/src/config-resolve.ts`
- **Remove:** `resolveEffectiveConfig`, `assertSubstrateExclusivity`, `EffectiveConfig`,
  `SubstrateExclusivityError`, `SUBSTRATE_DRIVER`, and their coverage in `config-resolve.test.ts`.
- **KEEP:** `resolveProcessSettings` — LIVE (called by `server.ts` bootstrap for the global `settings`
  block: coordinator port, query limits, OTLP endpoint).

## Contracts / event schema follow-up
- `ModelTier` (`packages/contracts/src/spec.ts`) and the `serves: [{ tier, label }]` field on
  `RegistryUpdatedEvent` (`packages/contracts/src/events.ts`) are now vestigial — the coordinator
  emits `serves: []`. Drop `serves` from the event (and `ModelTier` if nothing else needs it) when the
  above is removed. This is a wire-schema change, so do it as its own commit.

## Verification after removal
`npm run typecheck` clean + `npm run test` green across all workspaces (contracts, agent-image,
adapter-opencode, adapter-omnigent, coordinator, client). The live path is exercised by the
`AgentRegistry`, review-panel, registry-integration, and scaffold suites — none of which touch the
tier engine.
