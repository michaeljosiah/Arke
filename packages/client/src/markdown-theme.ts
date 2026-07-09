// SPEC-032: syntax highlighting for rendered agent/spec markdown, mirroring OpenCode v2's shiki use
// (packages/session-ui/src/components/markdown-shiki.worker.ts) but on-brand for Arke's design
// contract (SPEC-033): a low-saturation NEUTRAL palette with the teal brand accent as the single
// restrained accent (keywords/strings), plus green/red on diff lines (allowed on diffs per the
// design guide). Shiki is loaded lazily (dynamic import → code-split) so it never weighs on the
// initial paint and never blocks text display; unknown languages and a not-yet-ready highlighter
// fall back to plain monospace.
import type { ThemeRegistrationRaw } from 'shiki';

type CoreHighlighter = { codeToHtml: (code: string, options: { lang: string; theme: string }) => string };

// Curated authoring language set — anything else renders plain. Kept small so the lazy chunk stays
// lean. Fence languages are normalised through ALIAS before lookup.
const LANGS = [
  'typescript', 'tsx', 'javascript', 'jsx', 'json', 'bash', 'python', 'go', 'rust',
  'yaml', 'sql', 'diff', 'html', 'css', 'markdown',
] as const;

const ALIAS: Record<string, string> = {
  ts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript', react: 'tsx',
  py: 'python', rs: 'rust', golang: 'go', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  yml: 'yaml', md: 'markdown', htm: 'html', text: '', txt: '', plaintext: '', '': '',
};

/** Resolve a fence language to a loaded shiki grammar, or null to render plain monospace. */
export function normalizeLang(lang?: string | null): string | null {
  if (!lang) return null;
  const l = lang.toLowerCase();
  const canon = l in ALIAS ? ALIAS[l] : l;
  return canon && (LANGS as readonly string[]).includes(canon) ? canon : null;
}

// Two custom themes on the neutral ramp. Editor background is transparent so the wrapper's neutral
// surface (var(--secondary)) shows through in both themes.
const LIGHT: ThemeRegistrationRaw = {
  name: 'arke-light',
  type: 'light',
  colors: { 'editor.background': 'transparent', 'editor.foreground': '#0A0A0A' },
  settings: [
    { settings: { foreground: '#0A0A0A' } },
    { scope: ['comment', 'punctuation.definition.comment', 'string.comment'], settings: { foreground: '#737373', fontStyle: 'italic' } },
    { scope: ['keyword', 'storage', 'storage.type', 'keyword.control', 'keyword.operator.expression', 'keyword.operator.new'], settings: { foreground: '#0E7490' } },
    { scope: ['string', 'string.quoted', 'string.template', 'constant.other.symbol'], settings: { foreground: '#0E7490' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.language.boolean'], settings: { foreground: '#525252' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call.generic'], settings: { foreground: '#171717', fontStyle: 'bold' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], settings: { foreground: '#404040' } },
    { scope: ['variable', 'variable.other', 'meta.definition.variable'], settings: { foreground: '#0A0A0A' } },
    { scope: ['punctuation', 'meta.brace', 'keyword.operator'], settings: { foreground: '#737373' } },
    { scope: ['entity.name.tag'], settings: { foreground: '#0E7490' } },
    { scope: ['entity.other.attribute-name'], settings: { foreground: '#525252' } },
    { scope: ['markup.inserted', 'markup.inserted.diff', 'meta.diff.header.to-file'], settings: { foreground: '#16A34A' } },
    { scope: ['markup.deleted', 'markup.deleted.diff', 'meta.diff.header.from-file'], settings: { foreground: '#E7000B' } },
  ],
};

const DARK: ThemeRegistrationRaw = {
  name: 'arke-dark',
  type: 'dark',
  colors: { 'editor.background': 'transparent', 'editor.foreground': '#E5E5E5' },
  settings: [
    { settings: { foreground: '#E5E5E5' } },
    { scope: ['comment', 'punctuation.definition.comment', 'string.comment'], settings: { foreground: '#A1A1A1', fontStyle: 'italic' } },
    { scope: ['keyword', 'storage', 'storage.type', 'keyword.control', 'keyword.operator.expression', 'keyword.operator.new'], settings: { foreground: '#3AB7CE' } },
    { scope: ['string', 'string.quoted', 'string.template', 'constant.other.symbol'], settings: { foreground: '#3AB7CE' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.language.boolean'], settings: { foreground: '#A1A1A1' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call.generic'], settings: { foreground: '#FAFAFA', fontStyle: 'bold' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], settings: { foreground: '#D4D4D4' } },
    { scope: ['variable', 'variable.other', 'meta.definition.variable'], settings: { foreground: '#E5E5E5' } },
    { scope: ['punctuation', 'meta.brace', 'keyword.operator'], settings: { foreground: '#A1A1A1' } },
    { scope: ['entity.name.tag'], settings: { foreground: '#3AB7CE' } },
    { scope: ['entity.other.attribute-name'], settings: { foreground: '#D4D4D4' } },
    { scope: ['markup.inserted', 'markup.inserted.diff', 'meta.diff.header.to-file'], settings: { foreground: '#16A34A' } },
    { scope: ['markup.deleted', 'markup.deleted.diff', 'meta.diff.header.from-file'], settings: { foreground: '#EF4444' } },
  ],
};

// Fine-grained shiki: the core highlighter + the JavaScript regex engine (no oniguruma WASM) + only
// the curated grammars, so the build bundles ~15 language chunks on demand rather than shiki's full
// ~200-grammar registry. Everything is behind dynamic imports → code-split, off the initial paint.
let hlPromise: Promise<CoreHighlighter> | null = null;
function getHighlighter(): Promise<CoreHighlighter> {
  if (!hlPromise) {
    hlPromise = Promise.all([import('shiki/core'), import('shiki/engine/javascript')])
      .then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) => createHighlighterCore({
        themes: [LIGHT, DARK],
        langs: [
          import('@shikijs/langs/typescript'), import('@shikijs/langs/tsx'),
          import('@shikijs/langs/javascript'), import('@shikijs/langs/jsx'),
          import('@shikijs/langs/json'), import('@shikijs/langs/bash'),
          import('@shikijs/langs/python'), import('@shikijs/langs/go'),
          import('@shikijs/langs/rust'), import('@shikijs/langs/yaml'),
          import('@shikijs/langs/sql'), import('@shikijs/langs/diff'),
          import('@shikijs/langs/html'), import('@shikijs/langs/css'),
          import('@shikijs/langs/markdown'),
        ],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      }) as unknown as CoreHighlighter)
      .catch((err) => { hlPromise = null; throw err; }); // allow a later retry if a chunk failed to load
  }
  return hlPromise;
}

// Cache highlighted HTML by theme|lang|code so re-renders (and re-mounts) never re-highlight identical
// code. Bounded so a long session cannot grow it without limit.
const cache = new Map<string, string>();
const CACHE_MAX = 400;

/**
 * Highlight `code` in `lang` for the current theme, returning shiki HTML (styled spans, content
 * escaped — safe to inject) or null when the language is unknown or the highlighter is unavailable
 * (still loading / failed), in which case the caller renders plain monospace.
 */
export async function highlightCode(code: string, lang: string, isDark: boolean): Promise<string | null> {
  const theme = isDark ? 'arke-dark' : 'arke-light';
  const key = `${theme}|${lang}|${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  try {
    const hl = await getHighlighter();
    const html = hl.codeToHtml(code, { lang, theme });
    if (cache.size >= CACHE_MAX) { const first = cache.keys().next().value; if (first !== undefined) cache.delete(first); }
    cache.set(key, html);
    return html;
  } catch {
    return null; // highlighter unavailable → caller falls back to plain monospace
  }
}
