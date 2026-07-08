import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * SPEC-030 auto-PR configuration: a per-project delivery preference — whether the implementer opens the
 * pull request itself on delivery (a standing, config-time relaxation of SPEC-011's per-diff human gate)
 * or delivery stops at the diff-review gate for the engineer to open the PR. It lives in the canonical
 * project config file `.arke/config.json` under a `delivery` block (SPEC-005/019 — all project config
 * lives in that one file), alongside `registry`/`settings`. Default OFF: the safe, governed baseline.
 */

interface RawConfig {
  delivery?: { autoOpenPr?: unknown };
  [k: string]: unknown;
}

/** Read `delivery.autoOpenPr` from `.arke/config.json`. Missing / unparseable / wrong-type → false (the safe default). */
export function loadAutoOpenPr(configPath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as RawConfig;
    return parsed?.delivery?.autoOpenPr === true;
  } catch {
    return false;
  }
}

/**
 * Set `delivery.autoOpenPr` in `.arke/config.json`, PRESERVING every other key (registry, settings,
 * providers, …) — a read-modify-write, not a clobber. Creates the file (and its `.arke/` dir) as
 * `{ "delivery": { "autoOpenPr": … } }` when absent, and writes atomically (temp + rename). Throws when
 * the file exists but is not valid JSON, rather than overwrite a partially-edited config.
 */
export function setAutoOpenPr(configPath: string, value: boolean): void {
  let base: RawConfig = {};
  if (existsSync(configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      throw new Error(`${configPath} exists but is not valid JSON; refusing to overwrite it`);
    }
    if (parsed && typeof parsed === "object") base = parsed as RawConfig;
  }
  const prior = base.delivery && typeof base.delivery === "object" ? base.delivery : {};
  const next: RawConfig = { ...base, delivery: { ...prior, autoOpenPr: value } };
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, configPath);
}
