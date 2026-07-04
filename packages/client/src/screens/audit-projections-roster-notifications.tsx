import React from 'react';
import { Icon } from '../icons';
import { Button, Badge, Card, Callout, StatusDot, Tabs, Input } from '../ds';
import { Page, SectionHead, Empty, ago } from '../utils';
import { store, useStore, engine } from '../store';
import { fetchModels, fetchHarnessCapabilities, createAgent, configureAgent, isCoordinatorConnected } from '../live';

const e = React.createElement;

export function Audit() {
  const audit = useStore((s) => s.audit);
  const [filter, setFilter] = React.useState('all');
  const KIND = { approval: { icon: 'check', label: 'Approval' }, permission: { icon: 'lock', label: 'Permission' }, projection: { icon: 'link', label: 'Projection' }, session: { icon: 'terminal', label: 'Session' }, spec: { icon: 'fileText', label: 'Spec' } };
  const tabs = [{ id: 'all', label: 'All' }, { id: 'approval', label: 'Approvals' }, { id: 'permission', label: 'Permissions' }, { id: 'projection', label: 'Projections' }];
  const rows = audit.filter((a) => filter === 'all' || a.kind === filter);
  return e(Page, { max: 980 },
    e(SectionHead, { eyebrow: 'Governance', title: 'Audit & activity trace',
      sub: 'Every governed action — permission decisions and deterministic projections — logged with the change that triggered it. The local trace is the audit source of truth.',
      action: e(Button, { variant: 'outline', iconLeft: e(Icon, { name: 'download', size: 15 }) }, 'Export NDJSON') }),
    audit.length === 0
      ? e(Empty, { icon: 'history', title: 'No activity yet', body: 'Once agents act and you approve gated steps, every governed action is logged here with the change that triggered it.' })
      : e(React.Fragment, null,
    e('div', { style: { marginBottom: 14 } }, e(Tabs, { tabs, value: filter, onChange: setFilter, mono: false })),
    e('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-xl)', overflow: 'hidden', background: 'var(--card)' } },
      rows.map((a, i) => e('div', { key: a.id, className: i === 0 ? 'so-enter' : undefined, style: { display: 'flex', gap: 14, padding: '13px 18px', borderBottom: i < rows.length - 1 ? '1px solid var(--line-soft)' : 'none', alignItems: 'flex-start' } },
        e('span', { style: { flex: 'none', width: 30, height: 30, borderRadius: 'var(--radius-md)', background: 'var(--secondary)', color: a.status === 'pending' ? 'var(--warning)' : a.status === 'denied' ? 'var(--destructive)' : 'var(--foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, e(Icon, { name: (KIND[a.kind] || {}).icon || 'dot', size: 15 })),
        e('div', { style: { flex: 1, minWidth: 0 } },
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 500, color: 'var(--foreground)' } }, a.text),
          e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)', marginTop: 2 } }, a.detail)),
        e('div', { style: { flex: 'none', textAlign: 'right' } },
          e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--foreground)' } }, a.actor),
          e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--neutral-400)', marginTop: 2 } }, ago(a.ts))),
        e('div', { style: { flex: 'none', width: 78, textAlign: 'right' } },
          a.status === 'pending' ? e(Badge, { tone: 'warn' }, 'pending') : a.status === 'denied' ? e(Badge, { variant: 'destructive' }, 'denied') : e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--success)' } }, e(StatusDot, { status: 'agree' }), 'logged'))))) ),
  );
}

export function Projections() {
  const projections = useStore((s) => s.projections);
  const systems = [...new Set(projections.map((p) => p.system))] as string[];
  const okN = projections.filter((p) => p.health === 'ok').length;
  const warnN = projections.filter((p) => p.health !== 'ok').length;
  const Stat = ({ label, value, dot }: any) => e('div', { style: { flex: 1, padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--card)' } },
    e('div', { style: { display: 'flex', alignItems: 'center', gap: 7 } }, dot ? e(StatusDot, { status: dot }) : null, e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em' } }, value)),
    e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--muted-foreground)', marginTop: 2 } }, label));
  return e(Page, { max: 1020 },
    e(SectionHead, { eyebrow: 'Delivery', title: 'Record sync',
      sub: 'Health of writes to your systems of record (Jira, Azure DevOps). Each entry is a projection of the specification — driven deterministically by a plugin on a status change, never free-form agent behaviour, and every write is logged.' }),
    projections.length === 0
      ? e(Empty, { icon: 'link', title: 'Nothing to sync yet', body: 'When a specification is approved, its tickets, work items and tracking entries are projected to your systems of record and their health appears here.' })
      : e(React.Fragment, null,
    e('div', { style: { display: 'flex', gap: 12, marginBottom: 20 } },
      e(Stat, { label: 'Connected systems', value: systems.length }),
      e(Stat, { label: 'Healthy projections', value: okN, dot: 'agree' }),
      e(Stat, { label: 'Need attention', value: warnN, dot: warnN ? 'waiting' : 'idle' })),
    systems.map((sys) => e('div', { key: sys, style: { marginBottom: 22 } },
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
        e('span', { style: { display: 'flex', color: 'var(--muted-foreground)' } }, e(Icon, { name: 'link', size: 16 })),
        e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 600 } }, sys),
        e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, 'MCP at host · tokens never leave it')),
      e('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-xl)', overflow: 'hidden', background: 'var(--card)' } },
        projections.filter((p) => p.system === sys).map((p, i, arr) => e('div', { key: p.id, style: { display: 'flex', alignItems: 'center', gap: 14, padding: '12px 18px', borderBottom: i < arr.length - 1 ? '1px solid var(--line-soft)' : 'none' } },
          e(StatusDot, { status: p.health === 'ok' ? 'agree' : 'waiting', pulse: p.health !== 'ok' }),
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--foreground)', width: 70 } }, p.id),
          e('span', { style: { flex: 1, minWidth: 0, fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, p.title),
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)', cursor: 'pointer' }, onClick: () => store.set({ view: 'board' }) }, p.spec),
          e(Badge, { variant: 'secondary' }, p.state),
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: p.health === 'ok' ? 'var(--neutral-400)' : 'var(--warning)', width: 130, textAlign: 'right' } }, p.last),
          p.health !== 'ok' ? e(Button, { size: 'sm', variant: 'outline', iconLeft: e(Icon, { name: 'refresh', size: 13 }), onClick: () => store.set({ projections: store.get().projections.map((x) => x.id === p.id ? { ...x, health: 'ok', last: 'just now' } : x) }) }, 'Retry') : e('span', { style: { width: 78 } }))))),
    )),
  );
}

// ============================ AGENT ROSTER (SPEC-016 revised + SPEC-021) ======
// The live roster: each agent DECLARES its own harness + model + provider + tools/MCP/skills +
// permission grid in its committed image (agents/<name>/config.yaml). The roster reads that
// projection (model ids + permission verbs are public; only credentials stay host-side) and the
// editor writes back to the image via agent.create / agent.configure.

const VERBS = ['allow', 'ask', 'deny'];
function verbColor(v: string) { return v === 'allow' ? 'var(--success)' : v === 'deny' ? 'var(--destructive)' : 'var(--warning)'; }
function splitModel(m?: string): { provider: string; name: string } {
  if (!m) return { provider: 'gateway', name: '' };
  const i = m.indexOf('/');
  return i > 0 ? { provider: m.slice(0, i), name: m.slice(i + 1) } : { provider: 'gateway', name: m };
}

/** A small downward-opening dropdown (the roster editor's building block). */
function Sel({ value, options, onChange, icon, small }: any) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<any>(null);
  React.useEffect(() => { const h = (ev: any) => { if (ref.current && !ref.current.contains(ev.target)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  return e('div', { ref, style: { position: 'relative' } },
    e('button', { onClick: () => setOpen((o: boolean) => !o), style: { display: 'flex', alignItems: 'center', gap: 6, width: '100%', justifyContent: 'space-between', padding: small ? '4px 8px' : '6px 9px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: small ? 11 : 12, color: 'var(--foreground)' } },
      e('span', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
        icon ? e('span', { style: { display: 'flex', color: 'var(--muted-foreground)' } }, e(Icon, { name: icon, size: 12 })) : null,
        e('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, value || '—')),
      e('span', { style: { display: 'flex', color: 'var(--neutral-400)' } }, e(Icon, { name: 'chevronDown', size: 12 }))),
    open ? e('div', { style: { position: 'absolute', top: '108%', left: 0, minWidth: '100%', maxHeight: 220, overflowY: 'auto', background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', zIndex: 60, padding: 4 } },
      (options.length ? options : ['—']).map((o: string) => e('button', { key: o, onClick: () => { onChange(o); setOpen(false); }, style: { display: 'block', width: '100%', textAlign: 'left', padding: '6px 9px', borderRadius: 'var(--radius-sm)', border: 'none', background: o === value ? 'var(--accent)' : 'transparent', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--foreground)', whiteSpace: 'nowrap' } }, o))) : null,
  );
}

function EditorRow({ label, hint, children }: any) {
  return e('div', { style: { marginBottom: 14 } },
    e('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 } },
      e('span', { style: { fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, color: 'var(--foreground)' } }, label),
      hint ? e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--neutral-400)' } }, hint) : null),
    children);
}

/** One MCP tool being edited: local (command/args/env) or remote (url/headers). */
function ToolEditor({ tool, caps, onChange, onRemove }: any) {
  const localOk = !caps || caps.mcp?.local !== false;
  const remoteOk = !caps || caps.mcp?.remote !== false;
  const setTransport = (t: string) => onChange({ ...tool, transport: t });
  const pairs = tool.transport === 'remote' ? (tool.headers || []) : (tool.environment || []);
  const pairKey = tool.transport === 'remote' ? 'headers' : 'environment';
  const setPairs = (p: any) => onChange({ ...tool, [pairKey]: p });
  return e('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 10, marginBottom: 8, background: 'var(--card)' } },
    e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
      e('span', { style: { display: 'flex', color: 'var(--muted-foreground)' } }, e(Icon, { name: 'link', size: 13 })),
      e('div', { style: { flex: 1 } }, e(Input, { value: tool.name, size: 'sm', mono: true, placeholder: 'tool name (e.g. github)', onChange: (ev: any) => onChange({ ...tool, name: ev.target.value }) })),
      e('div', { style: { width: 108 } }, e(Sel, { value: tool.transport, small: true, options: [...(localOk ? ['local'] : []), ...(remoteOk ? ['remote'] : [])], onChange: setTransport })),
      e('button', { onClick: onRemove, title: 'Remove tool', style: { display: 'flex', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 2 } }, e(Icon, { name: 'trash', size: 14 }))),
    tool.transport === 'remote'
      ? e('div', { style: { marginBottom: 6 } }, e(Input, { value: tool.url || '', size: 'sm', mono: true, placeholder: 'https://host/mcp', onChange: (ev: any) => onChange({ ...tool, url: ev.target.value }) }))
      : e('div', { style: { display: 'flex', gap: 6, marginBottom: 6 } },
          e('div', { style: { flex: 1 } }, e(Input, { value: tool.command || '', size: 'sm', mono: true, placeholder: 'command (e.g. uv)', onChange: (ev: any) => onChange({ ...tool, command: ev.target.value }) })),
          e('div', { style: { flex: 2 } }, e(Input, { value: tool.argsText ?? '', size: 'sm', mono: true, placeholder: 'args (space-separated)', onChange: (ev: any) => onChange({ ...tool, argsText: ev.target.value }) }))),
    e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--neutral-400)', margin: '4px 0 4px' } }, tool.transport === 'remote' ? 'headers — secrets as ${VAR}, never inline' : 'environment — secrets as ${VAR}, never inline'),
    (pairs as any[]).map((p: any, i: number) => e('div', { key: i, style: { display: 'flex', gap: 6, marginBottom: 5 } },
      e('div', { style: { flex: 1 } }, e(Input, { value: p.k, size: 'sm', mono: true, placeholder: 'KEY', onChange: (ev: any) => setPairs(pairs.map((x: any, j: number) => j === i ? { ...x, k: ev.target.value } : x)) })),
      e('div', { style: { flex: 1 } }, e(Input, { value: p.v, size: 'sm', mono: true, placeholder: '${VAR}', onChange: (ev: any) => setPairs(pairs.map((x: any, j: number) => j === i ? { ...x, v: ev.target.value } : x)) })),
      e('button', { onClick: () => setPairs(pairs.filter((_: any, j: number) => j !== i)), style: { display: 'flex', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 2 } }, e(Icon, { name: 'x', size: 13 })))),
    e('button', { onClick: () => setPairs([...(pairs as any[]), { k: '', v: '' }]), style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' } }, '+ add ' + (tool.transport === 'remote' ? 'header' : 'variable')),
  );
}

const PERMISSION_KEYS = ['read', 'edit', 'write', 'bash', 'webfetch', 'websearch'];

/**
 * The capability-aware agent editor (SPEC-021): create a new agent or edit an existing one. On create
 * it writes the whole image (name, harness, model, mode, permission, MCP tools) via agent.create; on
 * edit it writes model + permission via agent.configure (harness/tools of an existing image are shown
 * but not rewritten here). It validates against the harness capability manifest — offering only the
 * MCP forms the harness supports and warning when a form is unavailable.
 */
function AgentEditor({ existing, harnessDefault, onClose, onSaved }: any) {
  const isEdit = !!existing;
  const initModel = splitModel(existing?.model);
  const [name, setName] = React.useState(existing?.role || '');
  const [description, setDescription] = React.useState(existing?.description || '');
  const [harness, setHarness] = React.useState(existing?.harness || harnessDefault || 'opencode-native');
  const [provider, setProvider] = React.useState(initModel.provider);
  const [model, setModel] = React.useState(initModel.name);
  const [effort, setEffort] = React.useState(existing?.reasoningEffort || 'default');
  const [mode, setMode] = React.useState(existing?.mode || 'subagent');
  const [perms, setPerms] = React.useState<any[]>(Object.entries(existing?.permission || {}).map(([k, v]) => ({ k, v })));
  const [tools, setTools] = React.useState<any[]>([]);
  const [catalog, setCatalog] = React.useState<any[]>([]);
  const [caps, setCaps] = React.useState<any>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (isCoordinatorConnected()) {
      void fetchModels().then(setCatalog).catch(() => setCatalog([]));
      void fetchHarnessCapabilities().then(setCaps).catch(() => setCaps(null));
    }
  }, []);

  const providers = React.useMemo(() => {
    const set = new Set<string>((catalog || []).map((m: any) => m.provider));
    set.add(initModel.provider); set.add('gateway');
    return [...set].sort();
  }, [catalog]);
  const models = React.useMemo(() => {
    const ids = (catalog || []).filter((m: any) => m.provider === provider).map((m: any) => m.id);
    if (provider === initModel.provider && initModel.name && !ids.includes(initModel.name)) ids.push(initModel.name);
    return [...new Set<string>(ids)].sort();
  }, [catalog, provider]);
  React.useEffect(() => { if (models.length && !models.includes(model)) setModel(models[0]); }, [provider]);

  // Permission KEYS offered in the grid (SPEC-021): the six common built-ins, plus every built-in the
  // harness manifest reports (glob, apply_patch, todowrite, …), plus a `<server>_*` wildcard gate for
  // each declared/existing MCP tool — so an agent that adds an MCP server can actually gate it here.
  const permKeyOptions = React.useMemo(() => {
    const keys = new Set<string>(PERMISSION_KEYS);
    (caps?.builtinTools || []).forEach((k: string) => keys.add(k));
    // OpenCode namespaces MCP tools as `<mcp>_<tool>` and gates them with a `<mcp>_*` wildcard — the
    // underscore is required, or a `github*` gate would not match `github_search` (SPEC-021).
    (tools || []).forEach((t: any) => { if (t.name) keys.add(`${t.name}_*`); });
    (existing?.tools || []).forEach((t: any) => { if (t.name) keys.add(`${t.name}_*`); });
    perms.forEach((p: any) => { if (p.k) keys.add(p.k); });
    return [...keys].sort();
  }, [caps, tools, existing, perms]);

  const save = async () => {
    setError(null);
    if (!isEdit && !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) { setError('name must be a slug (letters, digits, . _ -)'); return; }
    if (!model && provider !== 'gateway') { setError('pick a model'); return; }
    setSaving(true);
    const permission = Object.fromEntries(perms.filter((p) => p.k && p.v).map((p) => [p.k, p.v]));
    let res: any;
    if (isEdit) {
      // Pass permission (even {}) so removing all rows clears the block, and mode so a primary/subagent
      // change persists. An empty model = "leave as-is" (the coordinator keeps a default-model agent).
      res = await configureAgent(name, provider, model, effort === 'default' ? undefined : effort, permission, mode);
    } else {
      const toolMap: any = {};
      for (const t of tools) {
        if (!t.name) continue;
        if (t.transport === 'remote') {
          toolMap[t.name] = { type: 'mcp', transport: 'remote', url: t.url, ...(t.headers?.length ? { headers: Object.fromEntries(t.headers.filter((p: any) => p.k).map((p: any) => [p.k, p.v])) } : {}) };
        } else {
          const args = (t.argsText || '').trim() ? t.argsText.trim().split(/\s+/) : undefined;
          toolMap[t.name] = { type: 'mcp', transport: 'local', command: t.command, ...(args ? { args } : {}), ...(t.environment?.length ? { environment: Object.fromEntries(t.environment.filter((p: any) => p.k).map((p: any) => [p.k, p.v])) } : {}) };
        }
      }
      res = await createAgent({
        name, harness, mode,
        ...(description ? { description } : {}),
        ...(provider !== 'gateway' && model ? { model: `${provider}/${model}` } : model ? { model } : {}),
        ...(effort !== 'default' ? { reasoningEffort: effort } : {}),
        ...(Object.keys(permission).length ? { permission } : {}),
        ...(Object.keys(toolMap).length ? { tools: toolMap } : {}),
      });
    }
    setSaving(false);
    if (!res.ok) { setError(res.error || 'failed to save'); return; }
    onSaved();
  };

  const mcpUnavailable = caps && caps.mcp && caps.mcp.local === false && caps.mcp.remote === false;

  return e('div', { onClick: onClose, style: { position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '48px 16px', overflowY: 'auto' } },
    e('div', { onClick: (ev: any) => ev.stopPropagation(), style: { width: 540, maxWidth: '100%', background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-md)', padding: 20 } },
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 } },
        e('span', { style: { width: 34, height: 34, borderRadius: 'var(--radius-md)', background: 'var(--primary)', color: 'var(--primary-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' } }, e(Icon, { name: 'bot', size: 17 })),
        e('div', { style: { flex: 1 } },
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600 } }, isEdit ? `Edit ${existing.role}` : 'New agent'),
          e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, isEdit ? 'writes to agents/' + existing.role + '/config.yaml' : 'creates agents/<name>/config.yaml')),
        e('button', { onClick: onClose, style: { display: 'flex', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 4 } }, e(Icon, { name: 'x', size: 18 }))),

      e(EditorRow, { label: 'Name', hint: isEdit ? 'immutable' : 'slug' },
        isEdit ? e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--foreground)', padding: '6px 0' } }, name)
          : e(Input, { value: name, mono: true, placeholder: 'e.g. researcher', onChange: (ev: any) => setName(ev.target.value) })),
      e(EditorRow, { label: 'Description' }, e(Input, { value: description, placeholder: 'what this agent does', onChange: (ev: any) => setDescription(ev.target.value) })),
      e('div', { style: { display: 'flex', gap: 10 } },
        e('div', { style: { flex: 1 } }, e(EditorRow, { label: 'Harness', hint: isEdit ? 'immutable' : undefined },
          isEdit ? e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--foreground)', padding: '6px 0' } }, harness)
            : e(Sel, { value: harness, icon: 'server', options: [...new Set([harness, 'opencode-native'])], onChange: setHarness }))),
        e('div', { style: { flex: 1 } }, e(EditorRow, { label: 'Mode' }, e(Sel, { value: mode, icon: 'bot', options: ['primary', 'subagent'], onChange: setMode })))),
      e('div', { style: { display: 'flex', gap: 10 } },
        e('div', { style: { flex: 1 } }, e(EditorRow, { label: 'Provider' }, e(Sel, { value: provider, icon: 'server', options: providers, onChange: setProvider }))),
        e('div', { style: { flex: 1 } }, e(EditorRow, { label: 'Model' }, e(Sel, { value: model || '—', icon: 'cpu', options: models.length ? models : [model || '—'], onChange: setModel }))),
        e('div', { style: { width: 120 } }, e(EditorRow, { label: 'Reasoning' }, e(Sel, { value: effort, icon: 'zap', options: ['default', 'low', 'medium', 'high', 'xhigh'], onChange: setEffort })))),
      (catalog || []).length === 0 ? e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)', marginBottom: 12, lineHeight: 1.5 } }, 'Harness catalog unavailable (offline or no models capability) — the current provider stays selectable.') : null,

      e(EditorRow, { label: 'Permissions', hint: 'allow · ask · deny' },
        e('div', null,
          perms.map((p, i) => e('div', { key: i, style: { display: 'flex', gap: 6, marginBottom: 6 } },
            e('div', { style: { flex: 1 } }, e(Sel, { value: p.k || '—', small: true, options: permKeyOptions, onChange: (v: string) => setPerms(perms.map((x, j) => j === i ? { ...x, k: v } : x)) })),
            e('div', { style: { width: 110 } }, e(Sel, { value: p.v || 'allow', small: true, options: VERBS, onChange: (v: string) => setPerms(perms.map((x, j) => j === i ? { ...x, v } : x)) })),
            e('button', { onClick: () => setPerms(perms.filter((_, j) => j !== i)), style: { display: 'flex', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 2 } }, e(Icon, { name: 'x', size: 13 })))),
          e('button', { onClick: () => setPerms([...perms, { k: '', v: 'allow' }]), style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' } }, '+ add permission'))),

      isEdit
        ? (existing.tools?.length ? e(EditorRow, { label: 'Tools', hint: 'edit via config.yaml' },
            e('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              existing.tools.map((t: any) => e('span', { key: t.name, style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)', border: '1px solid var(--border)', borderRadius: 999, padding: '2px 8px' } }, `${t.name} · ${t.kind}`)))) : null)
        : e(EditorRow, { label: 'Tools (MCP)', hint: caps?.harness ? `${caps.harness}${caps.version ? ' ' + caps.version : ''}` : undefined },
            mcpUnavailable
              ? e(Callout, { variant: 'default' }, 'This harness does not support MCP tools.')
              : e('div', null,
                  tools.map((t, i) => e(ToolEditor, { key: i, tool: t, caps, onChange: (nt: any) => setTools(tools.map((x, j) => j === i ? nt : x)), onRemove: () => setTools(tools.filter((_, j) => j !== i)) })),
                  e('button', { onClick: () => setTools([...tools, { name: '', transport: (caps && caps.mcp?.local === false) ? 'remote' : 'local', environment: [], headers: [] }]), style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' } }, '+ add MCP server'))),

      error ? e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--destructive)', marginTop: 6, marginBottom: 4 } }, error) : null,
      e('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 } },
        e(Button, { variant: 'outline', size: 'sm', onClick: onClose }, 'Cancel'),
        e(Button, { size: 'sm', disabled: saving, onClick: save }, saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create agent'))),
  );
}

function AgentCard({ a, onEdit }: any) {
  return e(Card, { padding: 16 },
    e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
      e('span', { style: { width: 36, height: 36, borderRadius: 'var(--radius-md)', background: 'var(--primary)', color: 'var(--primary-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' } }, e(Icon, { name: 'bot', size: 18 })),
      e('div', { style: { flex: 1, minWidth: 0 } },
        e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 600 } }, a.role),
        e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' } }, a.mode || 'subagent')),
      e('button', { onClick: onEdit, title: 'Edit agent', style: { display: 'flex', alignItems: 'center', gap: 5, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--card)', cursor: 'pointer', padding: '4px 9px', fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--foreground)' } }, e(Icon, { name: 'pencil', size: 12 }), 'Edit')),
    e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--foreground)', padding: '6px 9px', background: 'var(--secondary)', borderRadius: 'var(--radius-sm)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
      e('span', { style: { display: 'flex', color: 'var(--muted-foreground)' } }, e(Icon, { name: 'cpu', size: 12 })),
      a.model ? (a.reasoningEffort ? `${a.model} · ${a.reasoningEffort}` : a.model) : `${a.harness} · model set by agent`),
    a.tools?.length ? e('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 } },
      a.tools.map((t: any) => e('span', { key: t.name, title: t.kind, style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--foreground)', border: '1px solid var(--border)', borderRadius: 999, padding: '1px 8px' } },
        e(Icon, { name: t.kind === 'mcp' ? 'link' : t.kind === 'function' ? 'code' : 'bot', size: 10 }), t.name))) : null,
    a.skills?.length ? e('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 } },
      a.skills.map((s: string) => e('span', { key: s, style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)', background: 'var(--secondary)', borderRadius: 999, padding: '1px 8px' } },
        e(Icon, { name: 'sparkle', size: 10 }), s))) : null,
    Object.keys(a.permission || {}).length ? e('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
      Object.entries(a.permission).map(([k, v]: any) => e('span', { key: k, style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted-foreground)', border: '1px solid var(--border)', borderRadius: 999, padding: '1px 8px' } },
        k, e('span', { style: { color: verbColor(v), marginLeft: 4 } }, v)))) : null,
  );
}

export function Agents() {
  const roster = useStore((s: any) => s.roster) as any[];
  const live = useStore((s: any) => s.live);
  const [editing, setEditing] = React.useState<any>(null); // { existing? } | null
  const openCreate = () => setEditing({ existing: null });
  const openEdit = (a: any) => setEditing({ existing: a });
  const harnessDefault = React.useMemo(() => (roster || []).map((a) => a.harness).find(Boolean), [roster]);

  return e(Page, { max: 1020 },
    e(SectionHead, { eyebrow: 'Project', title: 'Agent roster',
      sub: 'The agents ship into the repository, not onto a machine — committed as their image (agents/<name>/config.yaml) and reviewed through pull request like the specification. Each agent declares its own harness, model, tools, MCP and permissions; only credentials stay host-side.',
      action: e(Button, { variant: 'outline', iconLeft: e(Icon, { name: 'plus', size: 15 }), disabled: !live, onClick: openCreate }, 'Add agent') }),
    !live ? e(Callout, { variant: 'default', style: { marginBottom: 16 } }, 'Connect a coordinator to view and edit this project’s agent roster.') : null,
    (roster || []).length === 0
      ? e(Empty, { icon: 'bot', title: 'No agents yet', body: live ? 'Create your first agent — declare its harness, model, tools, MCP and permissions. It is written to the repo as an image and appears here.' : 'Once a coordinator is connected, this project’s committed agents appear here.' })
      : e('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 } },
          (roster || []).map((a) => e(AgentCard, { key: a.role, a, onEdit: () => openEdit(a) }))),
    editing ? e(AgentEditor, { existing: editing.existing, harnessDefault, onClose: () => setEditing(null), onSaved: () => setEditing(null) }) : null,
  );
}

export function Notifications() {
  const notifs = useStore((s) => s.notifs);
  const KIND = { permission: 'lock', review: 'users', diff: 'diff', projection: 'link', merge: 'merge' };
  return e(Page, { max: 820 },
    e(SectionHead, { eyebrow: 'Governance', title: 'Notifications',
      sub: 'What needs attention — approvals waiting, reviews due, projections and merges.',
      action: e(Button, { variant: 'outline', onClick: () => engine.markNotifsRead() }, 'Mark all read') }),
    notifs.length === 0
      ? e(Empty, { icon: 'bell', title: "You're all caught up", body: 'Approvals waiting, reviews due, projections and merges will show up here as the harness reports them.' })
      : e('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-xl)', overflow: 'hidden', background: 'var(--card)' } },
      notifs.map((n, i) => e('button', { key: n.id, onClick: () => store.set({ view: n.view || 'board' }), style: { display: 'flex', gap: 14, width: '100%', textAlign: 'left', padding: '14px 18px', border: 'none', borderBottom: i < notifs.length - 1 ? '1px solid var(--line-soft)' : 'none', background: n.read ? 'transparent' : 'var(--accent)', cursor: 'pointer' } },
        e('span', { style: { flex: 'none', width: 32, height: 32, borderRadius: 'var(--radius-md)', background: 'var(--secondary)', color: n.kind === 'permission' ? 'var(--destructive)' : 'var(--foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, e(Icon, { name: KIND[n.kind] || 'dot', size: 16 })),
        e('div', { style: { flex: 1, minWidth: 0 } },
          e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--foreground)', fontWeight: n.read ? 400 : 500 } }, n.text),
          e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--neutral-400)', marginTop: 2 } }, n.kind + ' · ' + ago(n.ts))),
        n.read ? null : e('span', { style: { flex: 'none', width: 8, height: 8, borderRadius: 999, background: 'var(--destructive)', marginTop: 6 } }))),
    ),
  );
}
