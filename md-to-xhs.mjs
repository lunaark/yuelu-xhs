#!/usr/bin/env node
// Markdown/HTML/URL → 小红书图文（Notion Exporter 风格）
// 用法：node tools/md-to-xhs.mjs <markdown/html文件或URL> [输出目录]

import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, resolve, join } from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir, homedir } from "node:os";
import { pathToFileURL } from "node:url";

const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
const require = createRequire(import.meta.url);
const { chromium } = require(`${globalRoot}/playwright`);

const args = process.argv.slice(2);
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const WECHAT_UA = "Mozilla/5.0 (Linux; Android 13; V2148A) AppleWebKit/537.36 Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.49.2600 WeChat/arm64 Weixin NetType/WIFI Language/zh_CN";
const NAVIGATION_MAX_ATTEMPTS = 3;

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

const IMAGE_ERROR_CSS = `
  .image-error {
    border: 3px dashed #d8d8d8;
    background: #fafafa;
    border-radius: 12px;
    padding: 42px 36px;
  }
  .image-error .title {
    font-size: 34px;
    line-height: 1.5;
    font-weight: 700;
    color: #555;
    margin-bottom: 12px;
  }
  .image-error .desc {
    font-size: 28px;
    line-height: 1.6;
    color: #777;
  }
  .image-error code {
    display: block;
    margin-top: 20px;
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 22px;
    line-height: 1.5;
    color: #999;
    word-break: break-all;
  }
`;

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
  figure.img-long img { max-height: 1100px; }
  figure.img-tall { display: flex; justify-content: center; }
  figure.img-tall img { width: auto; max-width: 100%; max-height: 1300px; }
  ${IMAGE_ERROR_CSS}
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
  console.error("用法：node md-to-xhs.mjs <markdown/html文件或URL> [输出目录] [--footer \"品牌名\"]");
  process.exit(1);
}

const input = resolveInput(positional[0]);
const slug = input.slug;
const outDir = resolve(positional[1] || input.defaultOutDir);
mkdirSync(outDir, { recursive: true });

const { frontmatter, blocks, assets, filtered = [], sourceHtml } = await parseInput(input, outDir);
if (sourceHtml) writeFileSync(join(outDir, "source.html"), sourceHtml, "utf8");
if (blocks.length === 0) {
  console.error("没有解析到可转换的正文内容，请确认输入文件或链接能正常打开。");
  process.exit(1);
}

// 页脚优先级：CLI > frontmatter > config > 默认空
const FOOTER_LABEL = cliFooter ?? frontmatter.footer ?? readConfigFooter() ?? DEFAULT_FOOTER;

console.log(`解析得 ${blocks.length} 个块`);
console.log(`开始用浏览器测量真实块高度...`);
const heights = await measureBlockHeights(blocks);
console.log(`测量完成：[${heights.slice(0, 5).join(", ")}...]`);

const pages = paginateByRealHeights(blocks, heights);
console.log(`真实切页完成：${pages.length} 页`);
writeAssetManifest(outDir, input, assets, blocks, pages.length, filtered);
logFilteredSummary(filtered);

const html = renderScreenshotHtml(pages);
const tmpHtmlPath = join(tmpdir(), `md-to-xhs-${Date.now()}.html`);
writeFileSync(tmpHtmlPath, html, "utf8");

await screenshotAll(tmpHtmlPath, pages.length, outDir, slug);
try { unlinkSync(tmpHtmlPath); } catch {}

console.log(`完成：${outDir}`);
try { execSync(`open ${JSON.stringify(outDir)}`); } catch {}

// ======================== 输入解析 ========================

function resolveInput(rawArg) {
  if (isHttpUrl(rawArg)) {
    const slug = slugFromUrl(rawArg);
    return {
      kind: "url",
      url: rawArg,
      ext: ".html",
      slug,
      label: rawArg,
      defaultOutDir: join(process.cwd(), `${slug}-xhs`),
    };
  }

  const path = resolve(rawArg);
  if (!existsSync(path)) {
    console.error(`文件不存在：${path}`);
    process.exit(1);
  }

  const ext = extname(path).toLowerCase();
  const slug = basename(path, extname(path));
  return {
    kind: "file",
    path,
    ext,
    slug,
    label: path,
    defaultOutDir: join(dirname(path), `${slug}-xhs`),
  };
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

function slugFromUrl(url) {
  const u = new URL(url);
  const pathname = safeDecodeURIComponent(u.pathname);
  const parts = [u.hostname, ...pathname.split("/").filter(Boolean)]
    .join("-")
    .replace(/^mp-weixin-qq-com-/, "wechat-");
  return sanitizeSlug(parts || "remote-article").slice(0, 80);
}

function safeDecodeURIComponent(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function sanitizeSlug(value) {
  return String(value)
    .replace(/[^A-Za-z0-9\u4e00-\u9fff_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "article";
}

async function parseInput(input, outDir) {
  if (input.kind === "url") {
    const { blocks, html, filtered } = await parseHtmlWithBrowser(input.url);
    const assets = await cacheRemoteImages(blocks, outDir);
    return { frontmatter: {}, blocks, assets, filtered, sourceHtml: html };
  }

  if (input.ext === ".html" || input.ext === ".htm") {
    const { blocks, filtered } = await parseHtmlWithBrowser(pathToFileURL(input.path).href);
    const assets = await cacheRemoteImages(blocks, outDir);
    return { frontmatter: {}, blocks, assets, filtered };
  }

  const raw = readFileSync(input.path, "utf8");
  const { frontmatter, body: md } = stripFrontmatter(raw);
  const blocks = parseMarkdown(md, dirname(input.path));
  const assets = await cacheRemoteImages(blocks, outDir);
  return { frontmatter, blocks, assets, filtered: [] };
}

async function parseHtmlWithBrowser(targetUrl) {
  let lastError = null;
  for (let attempt = 1; attempt <= NAVIGATION_MAX_ATTEMPTS; attempt++) {
    try {
      return await parseHtmlWithBrowserOnce(targetUrl, attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= NAVIGATION_MAX_ATTEMPTS) break;
      const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
      const delay = 1200 * attempt;
      console.warn(`页面打开失败，${delay}ms 后重试 ${attempt + 1}/${NAVIGATION_MAX_ATTEMPTS}：${reason}`);
      await sleep(delay);
    }
  }
  throw lastError;
}

async function parseHtmlWithBrowserOnce(targetUrl, attempt = 1) {
  const isWechatArticle = /^https?:\/\/mp\.weixin\.qq\.com\//i.test(targetUrl);
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({
      viewport: { width: PAGE_W, height: PAGE_H },
      deviceScaleFactor: 1,
      userAgent: userAgentForAttempt(isWechatArticle, attempt),
      extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    });
    const page = await ctx.newPage();
    const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (isHttpUrl(targetUrl) && response && response.status() >= 400) {
      throw new Error(`页面打开失败：HTTP ${response.status()} ${targetUrl}`);
    }
    await page.waitForTimeout(500);

    const result = await page.evaluate(() => {
    const out = [];
    const filtered = [];
    const seenImages = new Set();
    const title = document.querySelector('meta[property="og:title"]')?.content
      || document.querySelector(".rich_media_title")?.textContent
      || document.querySelector("title")?.textContent
      || "";
    const coverImage = document.querySelector('meta[property="og:image"]')?.content
      || document.querySelector('meta[property="twitter:image"]')?.content
      || "";
    const root = document.querySelector("#js_content") || document.body;

    function textOf(el) {
      return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    }

    function imageSrc(img) {
      return img.getAttribute("data-src")
        || img.getAttribute("data-original")
        || img.getAttribute("data-backsrc")
        || img.currentSrc
        || img.src
        || "";
    }

    function pushImage(img) {
      const src = imageSrc(img);
      if (!src) return;
      const filterReason = imageFilterReason(img, src);
      if (filterReason) {
        recordFiltered("image", filterReason, { src, text: nearbyTextOf(img) });
        return;
      }
      if (seenImages.has(src)) return;
      seenImages.add(src);
      out.push({ type: "image", src, alt: img.alt || "" });
    }

    function recordFiltered(type, reason, payload = {}) {
      filtered.push({
        type,
        reason,
        text: payload.text ? trimPreview(payload.text, 120) : undefined,
        src: payload.src || undefined,
      });
    }

    function imageFilterReason(img, src) {
      if (isTrackingPixel(img, src)) return "tracking_pixel";
      if (isWechatNoiseImage(img)) return "wechat_noise_image";
      return null;
    }

    function isTrackingPixel(img, src) {
      if (src.startsWith("data:image/svg+xml") && /width=['"]?1px|height=['"]?1px/i.test(src)) return true;
      const widthAttr = Number(img.getAttribute("width") || 0);
      const heightAttr = Number(img.getAttribute("height") || 0);
      if (widthAttr > 0 && heightAttr > 0) {
        return widthAttr <= 2 && heightAttr <= 2;
      }
      if (/^https?:\/\//i.test(src)) return false;
      const width = Number(img.naturalWidth || 0);
      const height = Number(img.naturalHeight || 0);
      return width > 0 && height > 0 && width <= 2 && height <= 2;
    }

    function isWechatNoiseImage(img) {
      const nearbyText = nearbyTextOf(img);
      if (isInteractionNoiseText(nearbyText)) return true;
      if (isQrOrFollowNoiseText(nearbyText)) return true;
      if (isRelatedReadingNoiseText(nearbyText)) return true;
      return false;
    }

    function nearbyTextOf(img) {
      const container = img.closest("p, section, div");
      return [
        container && textOf(container),
        ...siblingTexts(container, -1, 4),
        ...siblingTexts(container, 1, 4),
        ...siblingTexts(container?.parentElement, -1, 3),
        ...siblingTexts(container?.parentElement, 1, 3),
        followingArticleText(container, 24),
      ].filter(Boolean).join(" ");
    }

    function siblingTexts(el, direction, maxCount) {
      const texts = [];
      let node = direction < 0 ? el?.previousElementSibling : el?.nextElementSibling;
      for (let i = 0; node && i < maxCount; i++) {
        texts.push(textOf(node));
        node = direction < 0 ? node.previousElementSibling : node.nextElementSibling;
      }
      return texts;
    }

    function followingArticleText(el, maxCount) {
      if (!el) return "";
      const nodes = Array.from(root.querySelectorAll("p, section, div"));
      const index = nodes.findIndex(node => node === el || node.contains(el));
      if (index < 0) return "";
      return nodes.slice(index + 1, index + 1 + maxCount).map(textOf).filter(Boolean).join(" ");
    }

    function textFilterReason(text) {
      if (isInteractionNoiseText(text)) return "interaction_prompt";
      if (isBylineNoiseText(text)) return "byline";
      if (isQrOrFollowNoiseText(text)) return "follow_prompt";
      if (isRelatedReadingNoiseText(text)) return "related_reading";
      return null;
    }

    function isInteractionNoiseText(text) {
      const normalized = text.replace(/\s+/g, "");
      if (normalized.length > 90) return false;
      return /觉得好看|请点这里|点这里|点个在看|点赞|分享|转发|在看|↓↓↓|↓\s*↓\s*↓|👇/.test(text);
    }

    function isBylineNoiseText(text) {
      const normalized = text.replace(/\s+/g, "");
      if (normalized.length > 90) return false;
      return /^(来源|本期编辑|责任编辑|编辑|审核|责编|校对|内容编辑|内容审核|出品|策划|作者|撰文|排版)[丨|:：]/.test(normalized)
        || /^(本文)?(来源|作者|编辑|审核|责编|校对)[：:]/.test(normalized);
    }

    function isQrOrFollowNoiseText(text) {
      return /关注我们|关注公众号|扫码关注|长按识别|识别二维码|点击下方名片|设为星标|星标我们|加星标|点击蓝字关注/.test(text);
    }

    function isRelatedReadingNoiseText(text) {
      const normalized = text.replace(/\s+/g, "");
      if (normalized.length > 120) return false;
      return /^(推荐阅读|往期推荐|往期回顾|你可能还喜欢|延伸阅读|相关阅读|阅读原文|点击阅读原文)/.test(normalized);
    }

    function trimPreview(text, maxLength) {
      const value = String(text || "").replace(/\s+/g, " ").trim();
      return value.length > maxLength ? value.slice(0, maxLength) + "..." : value;
    }

    function hasMeaningfulText(el) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll("script, style, img, svg").forEach(n => n.remove());
      return textOf(clone).length > 0;
    }

    function walk(node) {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      const tag = el.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript") return;

      if (tag === "img") {
        pushImage(el);
        return;
      }

      const headingMatch = tag.match(/^h([1-6])$/);
      if (headingMatch) {
        const text = textOf(el);
        if (text) out.push({ type: "heading", level: Number(headingMatch[1]), text });
        return;
      }

      if (tag === "blockquote") {
        const text = textOf(el);
        if (text) out.push({ type: "quote", text });
        return;
      }

      if (tag === "ul" || tag === "ol") {
        const items = Array.from(el.children)
          .filter(child => child.tagName && child.tagName.toLowerCase() === "li")
          .map(textOf)
          .filter(Boolean);
        if (items.length) out.push({ type: "list", ordered: tag === "ol", items });
        return;
      }

      if (tag === "p") {
        if (hasMeaningfulText(el)) {
          const text = textOf(el);
          const reason = text && textFilterReason(text);
          if (reason) {
            recordFiltered("paragraph", reason, { text });
          } else if (text) {
            out.push({ type: "paragraph", text });
          }
        }
        el.querySelectorAll("img").forEach(pushImage);
        return;
      }

      for (const child of Array.from(el.children)) walk(child);
    }

    walk(root);
    return { title: title.trim(), coverImage: coverImage.trim(), blocks: out, filtered };
    });

    const html = isHttpUrl(targetUrl) ? await page.content() : null;
    await browser.close();
    const baseUrl = targetUrl;
    const blocks = result.blocks.map(b => {
      if (b.type !== "image") return b;
      return { ...b, src: absolutizeSrc(b.src, baseUrl) };
    });
    const coverImage = absolutizeSrc(result.coverImage, baseUrl);
    if (result.title && !isDuplicateTitle(result.title, blocks[0])) {
      blocks.unshift({ type: "heading", level: 1, text: result.title });
    }
    if (coverImage && !hasImage(blocks, coverImage)) {
      blocks.unshift({ type: "image", src: coverImage, alt: result.title || "封面图", role: "cover" });
    }
    dedupeAdjacentCoverImages(blocks);
    return { title: result.title, coverImage, blocks, filtered: result.filtered || [], html };
  } catch (err) {
    try { await browser.close(); } catch {}
    throw err;
  }
}

function userAgentForAttempt(isWechatArticle, attempt) {
  if (!isWechatArticle) return DESKTOP_UA;
  return attempt >= 3 ? DESKTOP_UA : WECHAT_UA;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function absolutizeSrc(src, baseUrl) {
  if (!src || /^(https?:|data:|file:)/.test(src)) return src;
  return new URL(src, baseUrl).href;
}

function hasImage(blocks, src) {
  const target = comparableImageSrc(src);
  return blocks.some(block => block.type === "image" && comparableImageSrc(block.src) === target);
}

function comparableImageSrc(src) {
  try {
    const url = new URL(src);
    const path = url.pathname.replace(/\/(?:0|640)$/, "");
    return `${url.hostname}${path}`;
  } catch {
    return src;
  }
}

// Why: 公众号常见模式 — 作者上传"封面图 + 正文头图"两张视觉相似但 URL 不同的图，
// 加上 og:image，会在第 1 页造成视觉重复。
// How to apply: 仅在 blocks 头部检查（前 4 项内），若出现 image -> [heading?] -> image 且
// 两张 mmbiz 图上传 token 前缀相同（同作者同批上传），删掉第二张。
function dedupeAdjacentCoverImages(blocks) {
  const HEAD_WINDOW = 4;
  for (let i = 0; i < Math.min(HEAD_WINDOW, blocks.length); i++) {
    if (blocks[i]?.type !== "image") continue;
    let j = i + 1;
    if (blocks[j]?.type === "heading") j++;
    if (blocks[j]?.type !== "image") continue;
    const a = mmbizUploadToken(blocks[i].src);
    const b = mmbizUploadToken(blocks[j].src);
    if (a && b && a.slice(0, 11) === b.slice(0, 11)) {
      blocks.splice(j, 1);
      return;
    }
  }
}

function mmbizUploadToken(src) {
  if (!src) return null;
  const m = String(src).match(/\/(?:sz_)?mmbiz_(?:png|jpg|jpeg|gif)\/([^/]+)\//);
  return m ? m[1] : null;
}

function isDuplicateTitle(title, firstBlock) {
  if (!firstBlock || firstBlock.type !== "heading") return false;
  return normalizeText(firstBlock.text) === normalizeText(title);
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, "").trim();
}

async function cacheRemoteImages(blocks, outDir) {
  const assetDir = join(outDir, "assets");
  let index = 1;
  const assets = [];

  for (const block of blocks) {
    if (!hasImageSrc(block)) continue;

    if (!/^https?:\/\//.test(block.src)) {
      assets.push({
        kind: block.role || block.type,
        original: block.originalSrc || block.src,
        local: block.src.startsWith("file://") ? fileUrlToPath(block.src) : null,
        status: block.src.startsWith("file://") ? "local" : "embedded",
      });
      continue;
    }

    mkdirSync(assetDir, { recursive: true });
    const originalSrc = block.src;
    const record = { kind: block.role || block.type, original: originalSrc, local: null, status: "pending" };
    assets.push(record);
    try {
      const res = await fetch(originalSrc, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Referer": "https://mp.weixin.qq.com/",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = res.headers.get("content-type") || "";
      // Why: 公众号正文偶尔出现 <img src> 指向文章自身链接（返回 HTML），不能当图片用。
      if (!/^image\//i.test(contentType) && !contentType.includes("octet-stream")) {
        throw new Error(`非图片 content-type: ${contentType.split(";")[0]}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = inferImageExt(originalSrc, contentType);
      const file = join(assetDir, `image-${String(index++).padStart(2, "0")}${ext}`);
      writeFileSync(file, buffer);
      block.src = "file://" + file;
      block.originalSrc = originalSrc;
      record.local = file;
      record.status = "ok";
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`图片缓存失败，生成占位图：${originalSrc} (${reason})`);
      block.type = "image-error";
      block.originalSrc = originalSrc;
      block.reason = reason;
      record.status = "failed";
      record.reason = reason;
    }
  }

  return assets;
}

function hasImageSrc(block) {
  return block.type === "image" && Boolean(block.src);
}

function fileUrlToPath(url) {
  try { return new URL(url).pathname; } catch { return null; }
}

function writeAssetManifest(outDir, input, assets, blocks, pageCount, filtered = []) {
  const manifest = {
    generated_at: new Date().toISOString(),
    source: input.kind === "url" ? { type: "url", url: input.url } : { type: "file", path: input.path },
    output: {
      pages: pageCount,
      page_size: { width: PAGE_W * 2, height: PAGE_H * 2 },
    },
    blocks: blocks.reduce((acc, block) => {
      acc[block.type] = (acc[block.type] || 0) + 1;
      return acc;
    }, {}),
    images: assets.map((asset, idx) => ({
      index: idx + 1,
      kind: asset.kind || "image",
      original: asset.original,
      local: asset.local ? relativePath(outDir, asset.local) : null,
      status: asset.status,
      reason: asset.reason || null,
    })),
    filtered: filtered.map((item, idx) => ({
      index: idx + 1,
      type: item.type,
      reason: item.reason,
      text: item.text || null,
      src: item.src || null,
    })),
  };
  writeFileSync(join(outDir, "assets-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

function relativePath(baseDir, path) {
  if (!path) return null;
  return path.startsWith(baseDir + "/") ? path.slice(baseDir.length + 1) : path;
}

function logFilteredSummary(filtered) {
  if (!filtered || filtered.length === 0) {
    console.log("过滤：无（正文无公众号噪音）");
    return;
  }
  const reasonLabel = {
    tracking_pixel: "追踪像素",
    wechat_noise_image: "互动/装饰图",
    interaction_prompt: "点赞分享引导",
    byline: "署名/编辑",
    follow_prompt: "关注/扫码引导",
    related_reading: "推荐阅读",
  };
  const counts = {};
  for (const item of filtered) {
    const key = `${item.type}:${item.reason}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  const parts = Object.entries(counts).map(([key, n]) => {
    const [type, reason] = key.split(":");
    const label = reasonLabel[reason] || reason;
    return `${n} ${type === "image" ? "张图" : "段文字"}（${label}）`;
  });
  console.log(`过滤：${parts.join("、")}，详情见 assets-manifest.json`);
}

function inferImageExt(src, contentType) {
  const wxFmt = src.match(/[?&]wx_fmt=([a-z0-9]+)/i)?.[1];
  if (wxFmt) return "." + wxFmt.toLowerCase().replace("jpeg", "jpg");
  const fromPath = new URL(src).pathname.match(/\.(png|jpe?g|gif|webp|avif)$/i)?.[0];
  if (fromPath) return fromPath.toLowerCase().replace(".jpeg", ".jpg");
  if (contentType?.includes("gif")) return ".gif";
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("jpeg")) return ".jpg";
  if (contentType?.includes("png")) return ".png";
  return ".png";
}

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
        src = resolveImageSrc(src, baseDir);
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

function resolveImageSrc(src, baseDir) {
  if (/^(https?:|data:|file:)/.test(src)) return src;
  const imagePath = resolve(baseDir, src);
  return existsSync(imagePath) ? "file://" + imagePath : src;
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
      return `<figure class="img-${b.imageScale || "normal"}"><img src="${b.src}" alt="${escapeHtml(b.alt)}"/></figure>`;
    case "image-error":
      return `<section class="image-error">
        <div class="title">图片加载失败</div>
        <div class="desc">原图链接已记录在 assets-manifest.json，可稍后重新下载或手动替换。</div>
        <code>${escapeHtml(b.originalSrc || "")}</code>
      </section>`;
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

  const measurements = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".measure-area [data-idx]"));
    return items.map(el => {
      const img = el.tagName === "FIGURE" ? el.querySelector("img") : null;
      return {
        height: Math.ceil(el.getBoundingClientRect().height),
        naturalWidth: img?.naturalWidth || 0,
        naturalHeight: img?.naturalHeight || 0,
      };
    });
  });

  await browser.close();

  // Why: 测量阶段拿到图片真实像素后，按宽高比给 image block 分三档（normal/long/tall），
  // 渲染时按档套不同 max-height，避免长图被压扁、独占一页还偏小。
  // How to apply: 直接 mutate blocks，渲染逻辑读 b.imageScale 决定 figure 的 class。
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type !== "image") continue;
    const { naturalWidth: w, naturalHeight: h } = measurements[i];
    blocks[i].imageScale = classifyImageScale(w, h);
  }

  // 长图被打成 long/tall 后，CSS max-height 会变（750 → 1100 / 1300），
  // 测量出来的高度作废，需要按新 CSS 再量一次。
  const needRemeasure = blocks.some(b => b.type === "image" && b.imageScale && b.imageScale !== "normal");
  if (!needRemeasure) {
    return measurements.map(m => m.height);
  }
  return await remeasureWithImageScale(blocks);
}

function classifyImageScale(w, h) {
  if (!w || !h) return "normal";
  const ratio = w / h;
  if (ratio < 0.3) return "tall";
  if (ratio < 0.6) return "long";
  return "normal";
}

async function remeasureWithImageScale(blocks) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: PAGE_W, height: PAGE_H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head>
<body><div class="measure-area">
${blocks.map((b, i) => renderBlockWithIdx(b, i)).join("\n")}
</div></body></html>`;
  const tmpHtmlPath = join(tmpdir(), `md-to-xhs-measure2-${Date.now()}.html`);
  writeFileSync(tmpHtmlPath, html, "utf8");
  await page.goto("file://" + tmpHtmlPath, { waitUntil: "load" });
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
  try { unlinkSync(tmpHtmlPath); } catch {}
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
  figure.img-long img { max-height: 1100px; }
  figure.img-tall { display: flex; justify-content: center; }
  figure.img-tall img { width: auto; max-width: 100%; max-height: 1300px; }
  ${IMAGE_ERROR_CSS}

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
