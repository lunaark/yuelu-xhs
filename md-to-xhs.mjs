#!/usr/bin/env node
// Markdown → 小红书图文（Notion Exporter 风格）
// 用法：node tools/md-to-xhs.mjs <markdown文件> [输出目录]

import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, resolve, join } from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir, homedir } from "node:os";

const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
const require = createRequire(import.meta.url);
const { chromium } = require(`${globalRoot}/playwright`);

const args = process.argv.slice(2);

const PAGE_W = 1242;
const PAGE_H = 1656;
const FOOTER_H = 176;        // 页脚高度（含上下边距）
const FOOTER_FONT = 26;
const PADDING_TOP = 80;
const PADDING_BOTTOM = 32;
const PADDING_X = 75;
const SAFE_MARGIN = 20;      // 测量准确后的小安全垫
const CONTENT_H = PAGE_H - FOOTER_H - PADDING_TOP - PADDING_BOTTOM - SAFE_MARGIN;
const DEFAULT_FOOTER = "";
const FONT_SIZE_BODY = 34;
const LINE_HEIGHT_BODY = 1.6;
const CHARS_PER_LINE = 25;
const BLOCK_GAP = 32;

const PAGE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    color: #1a1a1a;
  }
  .measure-area {
    width: ${PAGE_W - PADDING_X * 2}px;
    padding: 0;
  }
  .measure-area > * + * { margin-top: ${BLOCK_GAP}px; }
  .measure-area > h1 + *, .measure-area > h2 + *, .measure-area > h3 + * { margin-top: 24px; }
  h1.h-1, h2.h-2, h3.h-3, h4.h-4, h5.h-5, h6.h-6 {
    font-size: ${FONT_SIZE_BODY}px; line-height: 1.45; font-weight: 700; color: #000;
  }
  h1.h-1 { font-size: 46px; line-height: 1.35; }
  h2.h-2 { font-size: 42px; line-height: 1.4; }
  p {
    font-size: ${FONT_SIZE_BODY}px; line-height: ${LINE_HEIGHT_BODY}; color: #1a1a1a; word-break: break-word;
  }
  p strong { font-weight: 700; color: #000; }
  p em { font-style: italic; color: #444; }
  blockquote { border-left: 6px solid #d0d0d0; padding: 8px 0 8px 28px; color: #444; }
  blockquote p { font-size: ${FONT_SIZE_BODY}px; line-height: ${LINE_HEIGHT_BODY}; }
  blockquote p + p { margin-top: 16px; }
  ul, ol { padding-left: 1.6em; }
  li { font-size: ${FONT_SIZE_BODY}px; line-height: ${LINE_HEIGHT_BODY}; color: #1a1a1a; margin-bottom: 12px; }
  li::marker { color: #555; }
  code.inline { background: #f1f1f1; border-radius: 6px; padding: 2px 8px;
    font-family: "SF Mono", "Menlo", "Consolas", monospace; font-size: 32px; color: #333; }
  pre { background: #f5f5f5; border-radius: 12px; padding: 24px 28px; overflow: hidden; }
  pre code {
    font-family: "SF Mono", "Menlo", "Consolas", monospace; font-size: 28px; line-height: 1.6;
    color: #333; white-space: pre-wrap; word-break: break-word;
  }
  figure { margin: 0; }
  figure img {
    width: 100%;
    max-height: 750px;
    object-fit: contain;
    border-radius: 8px;
    display: block;
  }
`;

// 解析 CLI: --footer "xxx" 可放任意位置；位置参数依次是 mdPath、outDir
let cliFooter = null;
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--footer") { cliFooter = args[++i] ?? ""; continue; }
  if (args[i].startsWith("--footer=")) { cliFooter = args[i].slice(9); continue; }
  positional.push(args[i]);
}

if (positional.length < 1) {
  console.error("用法：node md-to-xhs.mjs <markdown文件> [输出目录] [--footer \"品牌名\"]");
  process.exit(1);
}

const mdPath = resolve(positional[0]);
if (!existsSync(mdPath)) {
  console.error(`文件不存在：${mdPath}`);
  process.exit(1);
}

const slug = basename(mdPath, extname(mdPath));
const outDir = resolve(positional[1] || join(dirname(mdPath), `${slug}-xhs`));
mkdirSync(outDir, { recursive: true });

const rawMd = readFileSync(mdPath, "utf8");
const { frontmatter, body: md } = stripFrontmatter(rawMd);

// 页脚优先级：CLI > frontmatter > config > 默认空
const FOOTER_LABEL = cliFooter ?? frontmatter.footer ?? readConfigFooter() ?? DEFAULT_FOOTER;

const blocks = parseMarkdown(md, dirname(mdPath));

console.log(`解析得 ${blocks.length} 个块`);
console.log(`开始用浏览器测量真实块高度...`);
const heights = await measureBlockHeights(blocks);
console.log(`测量完成：[${heights.slice(0, 5).join(", ")}...]`);

const pages = paginateByRealHeights(blocks, heights);
console.log(`真实切页完成：${pages.length} 页`);

const html = renderScreenshotHtml(pages);
const tmpHtmlPath = join(tmpdir(), `md-to-xhs-${Date.now()}.html`);
writeFileSync(tmpHtmlPath, html, "utf8");

await screenshotAll(tmpHtmlPath, pages.length, outDir, slug);
try { unlinkSync(tmpHtmlPath); } catch {}

console.log(`完成：${outDir}`);
try { execSync(`open ${JSON.stringify(outDir)}`); } catch {}

// ======================== Markdown 解析 ========================

// 极简 frontmatter 解析：仅支持 ---/--- 包裹的 key: value 行
function stripFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { frontmatter: {}, body: raw };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { frontmatter: fm, body: raw.slice(m[0].length) };
}

function readConfigFooter() {
  const path = join(homedir(), ".config", "md-to-xhs.json");
  if (!existsSync(path)) return null;
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    return typeof cfg.footer === "string" ? cfg.footer : null;
  } catch { return null; }
}

function parseMarkdown(text, baseDir) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    if (line.startsWith("```")) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]); i++;
      }
      i++;
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }

    if (/^---+\s*$/.test(line)) { i++; continue; }

    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      blocks.push({ type: "heading", level: headerMatch[1].length, text: headerMatch[2].trim() });
      i++;
      continue;
    }

    if (line.startsWith(">")) {
      const quote = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", text: quote.join("\n") });
      continue;
    }

    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (imgMatch) {
      const alt = imgMatch[1];
      let src = imgMatch[2];
      if (!/^(https?:|data:|file:)/.test(src)) {
        src = resolve(baseDir, src);
        if (existsSync(src)) src = "file://" + src;
      }
      blocks.push({ type: "image", src, alt });
      i++;
      continue;
    }

    if (/^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const items = [];
      const ordered = /^\d+\.\s+/.test(line);
      while (i < lines.length && (/^[-*+]\s+/.test(lines[i]) || /^\d+\.\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^([-*+]|\d+\.)\s+/, ""));
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockBoundary(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", text: para.join(" ") });
  }

  return blocks;
}

function isBlockBoundary(line) {
  return line.startsWith("#") || line.startsWith(">") || line.startsWith("```")
    || /^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line) || /^---+\s*$/.test(line)
    || /^!\[/.test(line);
}

// ======================== 行内 Markdown 渲染 ========================

function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code class="inline">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  return out;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ======================== 块 → HTML 片段 ========================

function renderBlock(b) {
  switch (b.type) {
    case "heading":
      return `<h${b.level} class="h-${b.level}">${renderInline(b.text)}</h${b.level}>`;
    case "paragraph":
      return `<p>${renderInline(b.text)}</p>`;
    case "quote":
      return `<blockquote>${b.text.split("\n\n").map(p => `<p>${renderInline(p)}</p>`).join("")}</blockquote>`;
    case "code":
      return `<pre><code>${escapeHtml(b.text)}</code></pre>`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      const items = b.items.map(it => `<li>${renderInline(it)}</li>`).join("");
      return `<${tag}>${items}</${tag}>`;
    }
    case "image":
      return `<figure><img src="${b.src}" alt="${escapeHtml(b.alt)}"/></figure>`;
    default:
      return "";
  }
}

// 测量用：把 data-idx 注入到 renderBlock 输出的根元素上
function renderBlockWithIdx(b, idx) {
  const html = renderBlock(b);
  return html.replace(/^<(\w+)/, `<$1 data-idx="${idx}"`);
}

// ======================== 真浏览器测量 ========================

async function measureBlockHeights(blocks) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: PAGE_W, height: PAGE_H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();

  // 关键：直接在根标签加 data-idx，不外包 div
  // 否则 CSS 选择器 `.measure-area > p` 不生效，P 测出来只有默认行高 22px
  // 关键：直接在根标签加 data-idx，不外包 div
  // 否则 CSS 选择器 `.measure-area > p` 不生效，块测出来都只有默认行高
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head>
<body><div class="measure-area">
${blocks.map((b, i) => renderBlockWithIdx(b, i)).join("\n")}
</div></body></html>`;

  // setContent 的 file:// 协议下 waitUntil 不可靠，改成写临时文件再 goto
  const { tmpdir } = await import("node:os");
  const tmpHtmlPath = join(tmpdir(), `md-to-xhs-measure-${Date.now()}.html`);
  writeFileSync(tmpHtmlPath, html, "utf8");
  await page.goto("file://" + tmpHtmlPath, { waitUntil: "load" });

  // 再显式等所有图片 complete=true
  await page.evaluate(async () => {
    await Promise.all(Array.from(document.images).map(img =>
      img.complete ? Promise.resolve() :
      new Promise(r => { img.onload = r; img.onerror = r; })
    ));
  });

  const heights = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".measure-area [data-idx]"));
    return items.map(el => Math.ceil(el.getBoundingClientRect().height));
  });

  await browser.close();
  return heights;
}

// ======================== 按真实高度切页 ========================

function paginateByRealHeights(blocks, heights) {
  const pages = [];
  let current = [];
  let used = 0;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const h = heights[i];
    const gap = current.length === 0 ? 0 : BLOCK_GAP;

    if (h > CONTENT_H) {
      if (current.length) { pages.push(current); current = []; used = 0; }
      pages.push([b]);
      continue;
    }

    if (used + gap + h > CONTENT_H && current.length) {
      pages.push(current);
      current = [b];
      used = h;
    } else {
      current.push(b);
      used += gap + h;
    }
  }

  if (current.length) pages.push(current);
  return pages;
}

// ======================== 渲染 HTML ========================

function renderScreenshotHtml(pages) {
  const total = pages.length;
  const pagesHtml = pages.map((blocks, idx) => `
    <section class="page" id="page-${idx + 1}">
      <div class="content">
        ${blocks.map(renderBlock).join("\n")}
      </div>
      <footer>
        <span class="brand">${escapeHtml(FOOTER_LABEL)}</span>
        <span class="pageno">${idx + 1} / ${total}</span>
      </footer>
    </section>
  `).join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    color: #1a1a1a;
  }
  .page {
    width: ${PAGE_W}px;
    height: ${PAGE_H}px;
    background: #ffffff;
    position: relative;
    display: flex;
    flex-direction: column;
    box-shadow: 0 4px 24px rgba(0,0,0,0.08);
  }
  .content {
    flex: 1;
    padding: ${PADDING_TOP}px ${PADDING_X}px ${PADDING_BOTTOM}px ${PADDING_X}px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
  }
  .content > * + * { margin-top: 32px; }
  .content > h1 + *, .content > h2 + *, .content > h3 + * { margin-top: 24px; }

  h1.h-1, h2.h-2, h3.h-3, h4.h-4, h5.h-5, h6.h-6 {
    font-size: ${FONT_SIZE_BODY}px;
    line-height: 1.45;
    font-weight: 700;
    color: #000;
  }
  h1.h-1 { font-size: 46px; line-height: 1.35; }
  h2.h-2 { font-size: 42px; line-height: 1.4; }

  p {
    font-size: ${FONT_SIZE_BODY}px;
    line-height: ${LINE_HEIGHT_BODY};
    color: #1a1a1a;
    word-break: break-word;
  }
  p strong { font-weight: 700; color: #000; }
  p em { font-style: italic; color: #444; }

  blockquote {
    border-left: 6px solid #d0d0d0;
    padding: 8px 0 8px 28px;
    color: #444;
  }
  blockquote p { font-size: ${FONT_SIZE_BODY}px; line-height: ${LINE_HEIGHT_BODY}; }
  blockquote p + p { margin-top: 16px; }

  ul, ol { padding-left: 1.6em; }
  li {
    font-size: ${FONT_SIZE_BODY}px;
    line-height: ${LINE_HEIGHT_BODY};
    color: #1a1a1a;
    margin-bottom: 12px;
  }
  li::marker { color: #555; }

  code.inline {
    background: #f1f1f1;
    border-radius: 6px;
    padding: 2px 8px;
    font-family: "SF Mono", "Menlo", "Consolas", "Roboto Mono", monospace;
    font-size: 32px;
    color: #333;
  }

  pre {
    background: #f5f5f5;
    border-radius: 12px;
    padding: 24px 28px;
    overflow: hidden;
  }
  pre code {
    font-family: "SF Mono", "Menlo", "Consolas", "Roboto Mono", monospace;
    font-size: 28px;
    line-height: 1.6;
    color: #333;
    white-space: pre-wrap;
    word-break: break-word;
  }

  figure { margin: 0; }
  figure img {
    width: 100%;
    max-height: 750px;
    object-fit: contain;
    border-radius: 8px;
    display: block;
  }

  footer {
    height: ${FOOTER_H}px;
    border-top: 1px solid #ececec;
    padding: 0 ${PADDING_X}px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: #999;
    font-size: ${FOOTER_FONT}px;
    background: #fff;
  }
  footer .brand { font-weight: 600; color: #444; }
  footer .pageno { color: #888; }
</style>
</head>
<body>
${pagesHtml}
</body>
</html>`;
}

// ======================== Playwright 截图 ========================

async function screenshotAll(htmlPath, total, outDir, slug) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: PAGE_W, height: PAGE_H },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto("file://" + htmlPath, { waitUntil: "networkidle" });

  for (let i = 1; i <= total; i++) {
    const handle = await page.locator(`#page-${i}`);
    const file = join(outDir, `${slug}-${String(i).padStart(2, "0")}.png`);
    await handle.screenshot({ path: file });
    console.log(`  → ${file}`);
  }

  await browser.close();
}
