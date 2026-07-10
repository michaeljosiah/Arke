// SPEC-036: the security boundary for rendering an HTML specification's body in the cockpit preview.
//
// An HTML spec body is UNTRUSTED (it is authored text that may contain anything). Before it is rendered it
// is parsed (`rehype-raw`) and sanitised (`rehype-sanitize`) against the locked schema below. Only a bounded
// set of structural prose tags survives; `<script>`/`<style>`/`<iframe>`/`<img>` are dropped, inline event
// handlers and `style` never survive (they are absent from the audited defaults we extend), and href schemes
// are restricted to http/https/mailto. This file deliberately holds NO React/DOM imports so the allow-list
// is small, auditable, and unit-testable in isolation (NFR-1/5).

import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

/** The locked allow-list handed to `rehype-sanitize`. Extends the audited GitHub default schema (which already
 *  excludes `style` and every `on*` handler) and then tightens tag names, attributes, and URL protocols. */
export const HTML_SPEC_SCHEMA: any = {
  ...defaultSchema,
  // Explicit tag allow-list (structural prose only). `img`, `iframe`, `script`, `style`, `svg`, `form`,
  // `input`, `button`, `object`, `embed`, … are absent → dropped (their text content is kept where it makes
  // sense, e.g. an unwrapped inline element's text).
  tagNames: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
    'pre', 'code', 'kbd', 'samp',
    'em', 'strong', 'b', 'i', 'del', 'ins', 'mark', 'sub', 'sup', 'small', 'abbr', 'span', 'div', 'section',
    'a', 'blockquote', 'q', 'cite', 'figure', 'figcaption',
  ],
  attributes: {
    ...defaultSchema.attributes,
    a: [['href'], 'title'],
    code: [['className', /^language-./]], // keep `language-xxx` so the code renderer can highlight fences
    th: ['scope'],
    td: [],
    '*': [], // no generic attributes anywhere (no id/class/style) except the explicit ones above
  },
  // Restrict URL schemes to exactly what the client's safeHref allows (the default also permits tel/xmpp/irc/…).
  protocols: { ...defaultSchema.protocols, href: ['http', 'https', 'mailto'] },
  strip: ['script', 'style'], // drop, don't escape-into-text
  clobberPrefix: 'arke-html',
};

/** The rehype plugin chain the {@link Markdown} renderer inserts when rendering an HTML spec body. */
export const HTML_REHYPE_PLUGINS: any[] = [rehypeRaw, [rehypeSanitize, HTML_SPEC_SCHEMA]];
