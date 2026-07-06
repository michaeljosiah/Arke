// SPEC-025: pure data derivations for the Overview screen. No React / store / transport imports, so they
// can be unit-tested without a DOM or the app graph. overview.tsx renders from these.

/** Everything waiting on a human: open gates, review-ready specs, diffs awaiting review, unhealthy sync. */
export function deriveTriage(cards: any[], projections: any[]): any[] {
  const items: any[] = [];
  for (const c of cards) {
    if (c.needsHuman) items.push({ key: 'gate-' + c.id, icon: 'lock', tone: 'var(--destructive)', kind: 'permission gate', title: (c.title || c.specId || c.id) + ' needs a decision', detail: c.specId || c.id, specId: c.specId || c.id, cta: 'Decide', go: 'spec' });
  }
  for (const c of cards) {
    if (c.col === 'review') items.push({ key: 'rev-' + c.id, icon: 'users', tone: 'var(--foreground)', kind: 'review', title: (c.specId || c.id) + ' is ready for a review panel', detail: c.title || '', cta: 'Open review', go: 'review' });
  }
  for (const c of cards) {
    if (c.col === 'diff') {
      const d = (c.sessions || []).map((s: any) => s.diff).find(Boolean) || c.diff;
      const detail = d ? `+${d.added} −${d.removed} across ${d.files} files` : (c.title || '');
      items.push({ key: 'diff-' + c.id, icon: 'diff', tone: 'var(--foreground)', kind: 'diff', title: (c.specId || c.id) + ' produced a diff', detail, specId: c.specId || c.id, cta: 'Review diff', go: 'spec' });
    }
  }
  for (const p of projections) {
    const unhealthy = (p.health !== undefined && p.health !== 'ok') || p.ok === false;
    if (unhealthy) {
      const system = p.system || p.target || 'record';
      const ref = p.id || p.artifactId || p.specId || '';
      items.push({ key: 'proj-' + ref + system, icon: 'link', tone: 'var(--warning)', kind: 'record sync', title: `${system} ${ref} needs attention`, detail: p.last || p.error || 'sync failed', cta: 'Open sync', go: 'projections' });
    }
  }
  return items;
}

export const PIPELINE_STAGES = [
  { id: 'draft', label: 'Draft' },
  { id: 'in-review', label: 'In review' },
  { id: 'approved', label: 'Approved' },
  { id: 'delivered', label: 'Delivered' }, // SPEC-024: terminal status renamed from `merged`
];

export const STAGE_FILL: Record<string, string> = { draft: 'var(--neutral-300)', 'in-review': 'var(--neutral-500)', approved: 'var(--neutral-700)', delivered: 'var(--foreground)' };

export function derivePipeline(specs: any[]): { id: string; label: string; n: number }[] {
  return PIPELINE_STAGES.map((st) => ({ ...st, n: specs.filter((sp) => sp.status === st.id).length }));
}

/** Join each git-branch status row with its specification's human title. */
export function deriveRepoRows(gitBranches: any[], specs: any[]): any[] {
  return (gitBranches || []).map((b) => ({ ...b, specTitle: (specs.find((s) => s.specId === b.specId) || {}).title || b.specId }));
}

/** Group projections by system with an unhealthy count, tolerating both live (`target`/`ok`) and demo shapes. */
export function deriveSyncSystems(projections: any[]): { system: string; count: number; warn: number; lastWarn?: string }[] {
  const by = new Map<string, { system: string; count: number; warn: number; lastWarn?: string }>();
  for (const p of projections || []) {
    const system = p.system || p.target || 'record';
    const unhealthy = (p.health !== undefined && p.health !== 'ok') || p.ok === false;
    const cur = by.get(system) || { system, count: 0, warn: 0, lastWarn: undefined as string | undefined };
    cur.count += 1;
    if (unhealthy) { cur.warn += 1; cur.lastWarn = p.last || p.error || p.id || ''; }
    by.set(system, cur);
  }
  return [...by.values()];
}
