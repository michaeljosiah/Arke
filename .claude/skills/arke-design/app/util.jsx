// SpecOne Orchestrator — shared utilities & tiny presentational helpers.
(function () {
  const e = React.createElement;
  const Icon = window.SO_Icon;

  window.SO_ago = function (ts) {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  };

  // uppercase tracked label (sentence-case content, sans, per brand)
  window.SO_Label = function ({ children, style }) {
    return e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)', ...style } }, children);
  };

  // mono key:value metadata row
  window.SO_Meta = function ({ children, style }) {
    return e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted-foreground)', ...style } }, children);
  };

  // page wrapper with scroll + max width
  window.SO_Page = function ({ children, max, pad }) {
    return e('div', { style: { height: '100%', overflowY: 'auto' } },
      e('div', { style: { padding: pad || 'var(--page-pad)', maxWidth: max || 'none', margin: max ? '0 auto' : 0 } }, children));
  };

  // section heading with optional eyebrow + action
  window.SO_SectionHead = function ({ eyebrow, title, sub, action, style }) {
    return e('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 18, ...style } },
      e('div', { style: { flex: 1, minWidth: 0 } },
        eyebrow ? e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)', marginBottom: 6 } }, eyebrow) : null,
        e('h1', { style: { margin: 0, fontFamily: 'var(--font-sans)', fontSize: 21, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--foreground)' } }, title),
        sub ? e('p', { style: { margin: '6px 0 0', fontFamily: 'var(--font-sans)', fontSize: 13.5, lineHeight: 1.5, color: 'var(--muted-foreground)', maxWidth: 620 } }, sub) : null),
      action || null);
  };

  // empty / placeholder pane
  window.SO_Empty = function ({ icon, title, body }) {
    return e('div', { style: { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, padding: 40 } },
      e('span', { style: { color: 'var(--neutral-400)' } }, e(Icon, { name: icon, size: 28 })),
      e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 16, fontWeight: 600, color: 'var(--foreground)' } }, title),
      e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13, maxWidth: 380, textAlign: 'center', color: 'var(--muted-foreground)', lineHeight: 1.5 } }, body));
  };

  // harness setup: pick a supported coding agent → its install & start instructions
  const HARNESS_SETUP = [
    { id: 'opencode', name: 'OpenCode', scheme: 'opencode://', host: 'localhost:4096', recommended: true, note: 'open source · self-hostable · the reference harness', install: 'curl -fsSL https://opencode.ai/install | sh', start: 'opencode serve --port 4096' },
    { id: 'claude-code', name: 'Claude Code', scheme: 'acp://', host: 'localhost:7223', note: 'speaks ACP · normalised by the local coordinator', install: 'npm i -g @anthropic-ai/claude-code', start: 'claude-code acp --port 7223' },
    { id: 'codex', name: 'Codex', scheme: 'codex://', host: 'localhost:8088', note: 'experimental adapter · capability-flagged', install: 'npm i -g @openai/codex', start: 'codex serve --port 8088' },
  ];

  window.SO_HarnessSetup = function ({ onConnect, defaultId }) {
    const NS = window.SpecOneDesignSystem_b87656;
    const { Input, Button } = NS;
    const [sel, setSel] = React.useState(defaultId || 'opencode');
    const h = HARNESS_SETUP.find((x) => x.id === sel) || HARNESS_SETUP[0];
    const [host, setHost] = React.useState(h.host);
    React.useEffect(() => { setHost(h.host); }, [sel]);
    const Cmd = ({ label, cmd }) => e('div', { style: { marginBottom: 10 } },
      e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600, marginBottom: 4 } }, label),
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--neutral-950)', borderRadius: 'var(--radius-md)', padding: '8px 11px' } },
        e('span', { style: { flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 11.5, color: '#86EFAC', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, '$ ' + cmd),
        e('span', { style: { display: 'flex', color: '#737373', cursor: 'pointer' } }, e(Icon, { name: 'copy', size: 13 }))));
    return e('div', null,
      e('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600, marginBottom: 8 } }, 'Choose your coding agent'),
      e('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 } },
        HARNESS_SETUP.map((x) => e('button', { key: x.id, onClick: () => setSel(x.id),
          style: { display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderRadius: 'var(--radius-md)', cursor: 'pointer', border: '1px solid ' + (sel === x.id ? 'var(--foreground)' : 'var(--border)'), background: sel === x.id ? 'var(--accent)' : 'var(--card)', fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 500, color: 'var(--foreground)' } },
          e('span', { style: { display: 'flex', color: sel === x.id ? 'var(--foreground)' : 'var(--muted-foreground)' } }, e(Icon, { name: 'server', size: 14 })),
          x.name,
          x.recommended ? e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted-foreground)', border: '1px solid var(--border)', borderRadius: 999, padding: '1px 5px' } }, 'recommended') : null))),
      e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)', marginBottom: 12 } }, h.note),
      e(Cmd, { label: 'Install', cmd: h.install }),
      e(Cmd, { label: 'Start', cmd: h.start }),
      onConnect ? e(React.Fragment, null,
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 8px' } },
          e('span', { style: { flex: 1, height: 1, background: 'var(--border)' } }),
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--neutral-400)' } }, 'or point at an existing host'),
          e('span', { style: { flex: 1, height: 1, background: 'var(--border)' } })),
        e('div', { style: { display: 'flex', gap: 8 } },
          e('div', { style: { flex: 1, minWidth: 0 } }, e(Input, { mono: true, prefix: h.scheme, value: host, onChange: (ev) => setHost(ev.target.value) })),
          e(Button, { variant: 'secondary', style: { flex: 'none' }, onClick: () => onConnect(h.scheme + host) }, 'Connect'))) : null,
      e('p', { style: { margin: '10px 0 0', fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--muted-foreground)', lineHeight: 1.5 } }, 'Authentication happens in the harness — Arke never collects credentials.'));
  };

  window.SO_statusTone = { draft: 'draft', 'in-review': 'review', approved: 'approved', merged: 'merged' };
})();
