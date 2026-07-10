import assert from "node:assert/strict";
import { test } from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { HTML_SPEC_SCHEMA } from "../src/html-sanitize.js";

/**
 * SPEC-036: the sanitising HTML spec renderer's security boundary. These run the SAME plugin chain
 * react-markdown uses for an HTML spec body (remark-parse → remark-rehype{allowDangerousHtml} →
 * rehype-raw → rehype-sanitize[HTML_SPEC_SCHEMA]) and assert what survives the sanitise pass. Rendering
 * itself is verified manually in the browser preview; this pins the allow-list so it can't regress.
 */

/** Run the render pipeline up to the sanitised hast tree (no stringifier needed). */
async function sanitiseToTree(html: string): Promise<any> {
  const p = unified()
    .use(remarkParse)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, HTML_SPEC_SCHEMA);
  return p.run(p.parse(html));
}

/** Collect every element tagName and the concatenated text of the sanitised tree. */
function walk(tree: any): { tags: Set<string>; text: string; props: Array<Record<string, unknown>> } {
  const tags = new Set<string>();
  const props: Array<Record<string, unknown>> = [];
  let text = "";
  (function rec(n: any) {
    if (!n) return;
    if (n.type === "element") { tags.add(n.tagName); props.push(n.properties ?? {}); }
    if (n.type === "text") text += n.value;
    for (const c of n.children ?? []) rec(c);
  })(tree);
  return { tags, text, props };
}

test("a <script> tag and its content are dropped, not rendered or escaped", async () => {
  const tree = await sanitiseToTree(`<p>Visible.</p>\n<script>alert(document.cookie)</script>`);
  const { tags, text } = walk(tree);
  assert.ok(tags.has("p"), "the paragraph survives");
  assert.ok(!tags.has("script"), "no script element survives");
  assert.doesNotMatch(text, /alert\(document\.cookie\)/, "script source text is not rendered");
});

test("inline <style> and a style= attribute never survive", async () => {
  const tree = await sanitiseToTree(`<style>body{display:none}</style>\n<p style="color:red">Hi</p>`);
  const { tags, text, props } = walk(tree);
  assert.ok(!tags.has("style"), "no style element");
  assert.doesNotMatch(text, /display:none/, "style content not rendered");
  assert.ok(props.every((p) => !("style" in p)), "no style attribute survives on any element");
});

test("an inline event handler (onclick) is stripped from a surviving element", async () => {
  const tree = await sanitiseToTree(`<p onclick="steal()">Click</p>`);
  const { tags, props } = walk(tree);
  assert.ok(tags.has("p"), "paragraph survives");
  assert.ok(props.every((p) => !("onClick" in p) && !("onclick" in p)), "no onclick handler survives");
});

test("a javascript: href is neutralised; an http link survives", async () => {
  const tree = await sanitiseToTree(`<a href="javascript:evil()">x</a> <a href="https://example.com">ok</a>`);
  const { props } = walk(tree);
  const hrefs = props.map((p) => p.href).filter(Boolean);
  assert.ok(!hrefs.some((h: any) => /^javascript:/i.test(String(h))), "no javascript: href survives");
  assert.ok(hrefs.some((h: any) => h === "https://example.com"), "the https link is preserved");
});

test("an <img> (external resource load) is dropped", async () => {
  const tree = await sanitiseToTree(`<p>text</p><img src="https://evil.example/track.gif">`);
  assert.ok(!walk(tree).tags.has("img"), "img is not on the allow-list → dropped (no external load)");
});

test("an <iframe> is dropped", async () => {
  const tree = await sanitiseToTree(`<iframe src="https://evil.example"></iframe><p>after</p>`);
  const { tags } = walk(tree);
  assert.ok(!tags.has("iframe"), "iframe dropped");
  assert.ok(tags.has("p"), "surrounding content survives");
});

test("structural prose tags survive intact (headings, lists, tables, code, emphasis, links)", async () => {
  const html =
    `<h3>Requirement: A thing</h3>` +
    `<p>The system <strong>SHALL</strong> do <em>a thing</em> — see <a href="https://x.test">x</a>.</p>` +
    `<ul><li>one</li><li>two</li></ul>` +
    `<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>` +
    `<pre><code class="language-ts">const a = 1;</code></pre>`;
  const { tags, text } = walk(await sanitiseToTree(html));
  for (const t of ["h3", "p", "strong", "em", "a", "ul", "li", "table", "thead", "th", "td", "pre", "code"]) {
    assert.ok(tags.has(t), `<${t}> survives`);
  }
  assert.match(text, /The system SHALL do a thing/);
  assert.match(text, /const a = 1;/, "code content preserved");
});

test("the language-xxx className on <code> survives so the code renderer can highlight", async () => {
  const tree = await sanitiseToTree(`<pre><code class="language-ts">x</code></pre>`);
  const codeProps = walk(tree).props.find((p) => Array.isArray((p as any).className));
  assert.ok(codeProps, "a code element carries a className array");
  assert.ok((codeProps!.className as string[]).includes("language-ts"), "language-ts preserved");
});
