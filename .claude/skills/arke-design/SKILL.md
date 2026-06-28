---
name: arke-design
description: >-
  The canonical design system and design template for Arke (the Specification
  Orchestrator). Use whenever building, restyling, or specifying any Arke user
  interface — screens, components, the launch/splash screen, the authoring cockpit,
  the delivery board, review panels, overlays, settings. Provides the shadcn/ui
  "neutral" monochrome token contract (colours, typography on Geist, spacing,
  radius/shadow/motion), Lucide iconography rules, the brand voice, the prototype
  app screens as reference, and the Arke launch-screen designs. Treat the tokens as
  the contract and match the prototype's look exactly.
---

# Arke design system

This skill is the **canonical design template for Arke**. Every Arke UI surface — and
every Arke specification that touches a UI — should follow it. The look is **quiet
monochrome infrastructure**: white surfaces, neutral hairline borders, near-black
primary, a single red reserved for destructive/blocked states, **Geist** for everything,
**Geist Mono** for code/IDs/paths, **Lucide** line icons, sentence-case copy, British
spelling, no emoji.

> Note on naming: this bundle was generated in the project's "SpecOne" era; the product
> is now **Arke**. The tokens, components and screens are unchanged and authoritative —
> read "SpecOne" in the vendored `_ds/` readme as "Arke".

## How to use it

1. **Tokens are the contract.** Start from `_ds/.../styles.css` (the entry point that links
   every token file) and the `_ds/.../tokens/` files: `colors.css` (shadcn neutral, light +
   `.dark`), `typography.css` (Geist), `spacing.css` (4px grid), `effects.css` (radius +
   shadcn shadows), `fonts.css` (Geist via Google Fonts CDN). Never hardcode hex/px that a
   token already expresses.
2. **Match the prototype.** The interactive app screens under `app/*.jsx` are the reference
   implementation of every surface (shell, cockpit, review, board, config, governance). Mirror
   their layout, density and component usage. `screenshots/` shows the intended result.
3. **Launch screen.** `Arke Launch Screen Light.html` (light, default) and
   `Arke Launch Screen.html` (dark) are the app's launch/splash design: the `//Arke`
   wordmark (mono `//` + Geist letters), a hairline rule, the "Specification orchestrator"
   tag, and a live **"probing harness…"** indicator (green pulsing dot + indeterminate bar)
   that reflects harness reachability while the app boots. Reduced-motion is respected.
4. **Read the full guide.** `_ds/.../readme.md` is the long-form design guide (voice, colour,
   type, iconography, motion, layout). `_ds/.../_ds_manifest.json` indexes components.

## What's in here

```
.claude/skills/arke-design/
├─ SKILL.md                      this manifest
├─ Arke Launch Screen Light.html launch/splash — light (default)
├─ Arke Launch Screen.html       launch/splash — dark
├─ Specification Orchestrator.html  the full bundled prototype (all screens, runnable)
├─ index.html                    prototype entry
├─ app/                          prototype source — shell, store, screens_*, icons, util
├─ screenshots/                  rendered reference screenshots
└─ _ds/specone-design-system-…/  the design system
   ├─ styles.css · readme.md · _ds_manifest.json · _ds_bundle.js
   └─ tokens/  colors · typography · fonts · spacing · effects
```

## The principles the UI must hold (they shape every screen)

- **Direction of truth.** The specification is authoritative; tickets/tests/tracking are
  *projections* — the UI shows the spec as the centre, projections as outward, read-only.
- **Propose · decide · execute.** Every governed action passes a human gate; approval and
  permission surfaces are first-class (overlays, not free text).
- **The harness owns execution; the client owns the picture.** The UI realises and
  coordinates; it never holds credentials or runs agents. Status is shown with colour dots
  and pills, never faces.
- **Event-driven, accessible.** Things appear/update as events arrive (150–200ms, ease-out,
  no loops); keyboard-navigable, visible focus ring, reduced-motion respected (NFR-6).
