import { resolvePresentationAssetSrc, type PresentationAssetResolver } from "./assets.js";
import type { PresentationBullet, PresentationDeck, PresentationSlide } from "./schema.js";

export interface SlideRenderOptions {
  readonly assetResolver?: PresentationAssetResolver | undefined;
  readonly editable?: boolean | undefined;
}

export function renderDeckSlide(
  deck: PresentationDeck,
  slide: PresentationSlide,
  index: number,
  forceActive = false,
  options: SlideRenderOptions = {},
): string {
  return renderSlide(deck, slide, index, forceActive, options.assetResolver, options.editable === true);
}

function renderSlide(deck: PresentationDeck, slide: PresentationSlide, index: number, forceActive = false, assetResolver?: PresentationAssetResolver, editable = false): string {
  const template = slide.template ?? inferTemplate(slide);
  if (typeof slide.html === "string" && slide.html.length > 0) return renderHtmlSlide(deck, slide, index, forceActive);
  if (template === "title") return renderTitleSlide(deck, slide, index, forceActive, assetResolver, editable);
  const ce = editableAttrs(editable);
  return `<section class="slide slide-${escapeAttr(template)}${forceActive || index === 0 ? " active" : ""}" data-slide-index="${index}" data-template="${escapeAttr(template)}">
  <div class="slide-inner">
    ${slide.eyebrow ? `<p class="eyebrow"${ce(`/slides/${index}/eyebrow`)}>${escapeHtml(slide.eyebrow)}</p>` : ""}
    ${slide.title ? `<h1${ce(`/slides/${index}/title`)}>${escapeHtml(slide.title)}</h1>` : ""}
    ${slide.subtitle ? `<p class="subtitle"${ce(`/slides/${index}/subtitle`)}>${escapeHtml(slide.subtitle)}</p>` : ""}
    ${renderMainContent(slide, template, index, assetResolver, editable)}
  </div>
  ${renderBrandChrome(deck, index, assetResolver)}
  ${slide.notes ? `<aside class="notes"${ce(`/slides/${index}/notes`)}>${escapeHtml(slide.notes)}</aside>` : ""}
</section>`;
}

function renderHtmlSlide(deck: PresentationDeck, slide: PresentationSlide, index: number, forceActive = false): string {
  // Pass-through for template-pack extensions that ship pre-rendered HTML.
  // No escaping: callers (other extensions) are trusted to produce safe HTML.
  //
  // Layout payloads in the wild (e.g. BrainCo) ship a *full* HTML document
  // — <!doctype html><html><head>...</head><body class="light"><div
  // class="slide">...</div></body></html>. When that lands inside an
  // existing <body>, the browser quietly drops the inner <html>/<body>
  // tags but keeps everything else, including <style> blocks and the
  // <body class="light"> attribute (which is lost). To make the pack's
  // theme classes (`light` / `dark`) reach its CSS selectors anyway, we
  // sniff <body class="..."> out of the payload and re-apply those
  // classes to the outer .slide wrapper so rules like `.light .title`
  // continue to match.
  const template = slide.template ?? "html";
  const rawHtml = slide.html ?? "";
  const bodyClassMatch = rawHtml.match(/<body[^>]*class=["']([^"']+)["'][^>]*>/i);
  const themeClass = bodyClassMatch ? ` ${escapeAttr(bodyClassMatch[1] as string)}` : "";
  // Template-pack layouts (e.g. BrainCo) ship a *fixed* px canvas — html,body
  // and .slide are pinned to e.g. 1920x1080. Without scaling, that canvas
  // overflows any viewport smaller than the canvas (footer clipped) and never
  // shrinks inside an embedded iframe. Detect the canvas size and wrap the
  // payload in a scaler whose `transform: scale(--deck-scale)` is computed at
  // runtime as min(deckW/canvasW, deckH/canvasH) so the whole slide fits.
  const canvas = detectFixedCanvas(rawHtml);
  const dims = canvas ? ` data-canvas-w="${canvas.w}" data-canvas-h="${canvas.h}"` : "";
  const inner = canvas
    ? `<div class="slide-scaler" style="width:${canvas.w}px;height:${canvas.h}px">${rawHtml}</div>`
    : rawHtml;
  return `<section class="slide slide-${escapeAttr(template)}${themeClass}${forceActive || index === 0 ? " active" : ""}" data-slide-index="${index}" data-template="${escapeAttr(template)}" data-non-editable="templated"${dims}>\n  <div class="slide-inner slide-html">${inner}</div>\n  ${slide.notes ? `<aside class="notes">${escapeHtml(slide.notes)}</aside>` : ""}\n</section>`;
}

/**
 * Detect a fixed px canvas in a template-pack payload by scanning every
 * `html` / `body` / `.slide` style rule for an explicit `width:<n>px` +
 * `height:<n>px` pair and returning the largest one. Template packs pin their
 * artboard this way (BrainCo => 1920x1080). Returns null for fluid payloads.
 */
function detectFixedCanvas(rawHtml: string): { w: number; h: number } | null {
  const re = /(?:^|[\s,{}])(?:html|body|\.slide)\b[^{}]*\{[^{}]*?\bwidth:\s*(\d+(?:\.\d+)?)px[^{}]*?\bheight:\s*(\d+(?:\.\d+)?)px/gi;
  let best: { w: number; h: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawHtml)) !== null) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    // Ignore decorative rules (rules, logos) — a real artboard is large.
    if (!(w >= 320 && h >= 320)) continue;
    if (!best || w * h > best.w * best.h) best = { w, h };
  }
  return best;
}

function renderTitleSlide(deck: PresentationDeck, slide: PresentationSlide, index: number, forceActive = false, assetResolver?: PresentationAssetResolver, editable = false): string {
  const rawLines = (slide.title ?? deck.title).split(/\r?\n/).filter(Boolean);
  const lines = rawLines.length > 0 ? rawLines : [deck.title, deck.subtitle ?? ""].filter(Boolean);
  const primary = lines[0] ?? "";
  const secondary = lines.slice(1).join("\n") || slide.subtitle || deck.subtitle || "";
  const ce = editableAttrs(editable);
  return `<section class="slide slide-title${forceActive || index === 0 ? " active" : ""}" data-slide-index="${index}" data-template="title">
  <div class="title-block" aria-label="${escapeAttr([primary, secondary].filter(Boolean).join(" "))}">
    <span class="title-primary"${ce(`/slides/${index}/title`)}>${escapeHtml(primary)}</span>${secondary ? `<span class="title-secondary"${ce(`/slides/${index}/subtitle`)}>${escapeHtml(secondary)}</span>` : ""}
  </div>
  <div class="title-date">${escapeHtml(deck.date ?? "[Date]")}</div>
  <div class="title-client">${escapeHtml(deck.client ?? "[Client]")}</div>
  ${slide.body ? `<p class="title-summary"${ce(`/slides/${index}/body`)}>${escapeHtml(slide.body)}</p>` : ""}
  ${renderBrandChrome(deck, index, assetResolver)}
  ${slide.notes ? `<aside class="notes"${ce(`/slides/${index}/notes`)}>${escapeHtml(slide.notes)}</aside>` : ""}
</section>`;
}

function renderMainContent(slide: PresentationSlide, template: string, slideIndex: number, assetResolver?: PresentationAssetResolver, editable = false): string {
  const ce = editableAttrs(editable);
  if (template === "quote") {
    return `<blockquote${ce(`/slides/${slideIndex}/quote`)}>${escapeHtml(slide.quote ?? slide.body ?? "")}</blockquote>${slide.attribution ? `<cite${ce(`/slides/${slideIndex}/attribution`)}>${escapeHtml(slide.attribution)}</cite>` : ""}`;
  }
  const parts: string[] = [];
  if (slide.body) parts.push(`<p class="body"${ce(`/slides/${slideIndex}/body`)}>${escapeHtml(slide.body)}</p>`);
  if (slide.bullets?.length) parts.push(renderBullets(slide.bullets, `/slides/${slideIndex}/bullets`, editable));
  if (slide.stats?.length) parts.push(`<div class="stats">${slide.stats.map((stat, m) => `<div class="stat"><strong${ce(`/slides/${slideIndex}/stats/${m}/value`)}>${escapeHtml(stat.value)}</strong>${stat.label ? `<span${ce(`/slides/${slideIndex}/stats/${m}/label`)}>${escapeHtml(stat.label)}</span>` : ""}</div>`).join("")}</div>`);
  if (slide.columns?.length) parts.push(`<div class="columns">${slide.columns.map((column, m) => `<article class="column-card">${column.title ? `<h2${ce(`/slides/${slideIndex}/columns/${m}/title`)}>${escapeHtml(column.title)}</h2>` : ""}${column.body ? `<p${ce(`/slides/${slideIndex}/columns/${m}/body`)}>${escapeHtml(column.body)}</p>` : ""}${column.bullets?.length ? renderBullets(column.bullets, `/slides/${slideIndex}/columns/${m}/bullets`, editable) : ""}</article>`).join("")}</div>`);
  if (slide.image) parts.push(`<figure class="slide-image"><img src="${escapeAttr(resolvePresentationAssetSrc(slide.image.src, assetResolver))}" alt="${escapeAttr(slide.image.alt ?? slide.title ?? "slide image")}" /></figure>`);
  if (slide.fragments?.length) parts.push(`<ol class="fragments">${slide.fragments.map((fragment, m) => `<li${ce(`/slides/${slideIndex}/fragments/${m}`)}>${escapeHtml(fragment)}</li>`).join("")}</ol>`);
  return `<div class="content">${parts.join("\n")}</div>`;
}

function renderBrandChrome(deck: PresentationDeck, index: number, assetResolver?: PresentationAssetResolver): string {
  const logo = deck.logo
    ? `<img class="brand-logo" src="${escapeAttr(resolvePresentationAssetSrc(deck.logo.src, assetResolver))}" alt="${escapeAttr(deck.logo.alt ?? "Brand logo")}" />`
    : "";
  return `<div class="brand-rule brand-rule-top" aria-hidden="true"></div>${logo}<div class="brand-rule brand-rule-footer" aria-hidden="true"></div><footer><span>${escapeHtml(deck.confidential ?? "Confidential and Proprietary")}</span><span>${index + 1}</span></footer>`;
}

function renderBullets(bullets: readonly (string | PresentationBullet)[], basePath: string, editable = false): string {
  const ce = editableAttrs(editable);
  return `<ul class="bullets">${bullets.map((bullet, m) => {
    if (typeof bullet === "string") return `<li${ce(`${basePath}/${m}`)}>${escapeHtml(bullet)}</li>`;
    return `<li><span${ce(`${basePath}/${m}/text`)}>${escapeHtml(bullet.text)}</span>${bullet.detail ? `<small${ce(`${basePath}/${m}/detail`)}>${escapeHtml(bullet.detail)}</small>` : ""}</li>`;
  }).join("")}</ul>`;
}

function inferTemplate(slide: PresentationSlide): string {
  if (slide.quote) return "quote";
  if (slide.stats?.length) return "metric";
  if (slide.columns?.length) return "columns";
  if (slide.image) return "image-split";
  return "title-bullets";
}

function editableAttrs(editable: boolean): (path: string) => string {
  if (!editable) return () => "";
  return (path) => ` data-deck-path="${escapeAttr(path)}" contenteditable="plaintext-only"`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
