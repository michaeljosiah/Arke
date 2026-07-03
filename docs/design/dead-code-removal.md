# Dead code removal — logical-tier machinery (SPEC-016 revised / Omnigent adoption)

**Status:** ✅ done. This records what was removed and what was deliberately retained.

The Omnigent adoption made agents declare their own harness + model + provider in their image
`executor` block; dispatch sends that model directly on `SendMessageInput.model` via the
`AgentRegistry`. That removed the old **role → logical tier → registry-resolved model → instance**
routing from the live path. The code that implemented it has now been deleted.

## Removed
- `packages/coordinator/src/session-router.ts` + `test/session-router.test.ts` — the `SessionRouter`
  (role→instance routing, blocked-slot tracking). No `src/` importer remained.
- The tier engine in `packages/coordinator/src/registry.ts` + `test/registry.test.ts`:
  `RegistryResolver`, `tierLabelFor`, `blockKey`, `parseModel`, `modelMatchesCatalog`, and the dead
  types `ModelSelection`, `InstanceProjection`, `RegistryInstanceStatus`, `RosterResolution`,
  `CatalogValidationProblem/Result`, `NoInstanceForTierError`, `UnknownRoleError`,
  `RegistryConfigError`. `registry.ts` is now just types.
- The dead exports in `packages/coordinator/src/config-resolve.ts`: `resolveEffectiveConfig`,
  `assertSubstrateExclusivity`, `EffectiveConfig`, `SubstrateExclusivityError`, `SUBSTRATE_DRIVER`,
  and their coverage in `test/config-resolve.test.ts`. The file now keeps only `resolveProcessSettings`.

## Deliberately retained (still live)
- `resolveProcessSettings` (`config-resolve.ts`) — the global `settings` block resolution (coordinator
  port, query limits, OTLP), used by `server.ts` bootstrap.
- The config-storage types `ServesEntry` / `InstanceConfig` / `RosterEntry` / `RegistryConfig` and the
  projection types `HarnessStatus` / `AgentRosterEntry` / `RegistrySnapshot` / `RegistryWarning`
  (`registry.ts`) — used by the SPEC-019 **global harness-connect** flow (`global-config.ts`,
  `registry-config.ts`, `descriptorFor` in `server.ts`) and the current snapshot projection.

## Intentionally deferred (not dead, just vestigial data)
`ModelTier` (`packages/contracts/src/spec.ts`) and the tier-shaped `serves`/`roster` fields on the
stored `InstanceConfig`/`RosterEntry`, plus the `serves: [{ tier, label }]` field on
`RegistryUpdatedEvent` (`packages/contracts/src/events.ts`, emitted as `[]`), are still **parsed and
persisted** by the SPEC-019 global harness-connect storage (`registry-config.ts`). Nothing routes on
them, but removing them is a **storage + wire-schema change** to the global-config format, so it's
left as a separate, deliberate migration rather than folded into this cleanup.
