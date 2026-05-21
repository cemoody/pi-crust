import { resolvePresentationAssetSrc, type PresentationAssetResolver } from "./assets.js";
import type { PresentationBullet, PresentationDeck, PresentationSlide } from "./schema.js";

export interface CompilePresentationOptions {
  readonly startSlide?: number;
  readonly title?: string;
  readonly assetResolver?: PresentationAssetResolver;
  /** Optional resolver for template-pack layouts. When the deck has a
   *  `templatePack` and a slide has a `layout`, the compiler calls this
   *  function with (packId, layoutKey, slots) and uses the returned HTML
   *  as the slide body (equivalent to setting `slide.html`). */
  readonly templatePackResolver?: TemplatePackResolver;
}

export type TemplatePackResolver = (
  packId: string,
  layoutKey: string,
  slots: Record<string, string | number | null | undefined>,
) => string | Promise<string>;

export function compileRevealHtml(deck: PresentationDeck, options: CompilePresentationOptions = {}): string {
  const start = Math.max(0, Math.min(deck.slides.length - 1, options.startSlide ?? 0));
  const title = options.title ?? deck.title;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${presentationCss(deck)}</style>
</head>
<body data-start-slide="${start}">
<main class="deck" aria-label="${escapeHtml(deck.title)}">
${deck.slides.map((slide, index) => renderSlide(deck, slide, index, false, options.assetResolver)).join("\n")}
</main>
<nav class="deck-controls" aria-label="Slide controls">
  <button type="button" data-prev aria-label="Previous slide">‹</button>
  <span data-counter></span>
  <button type="button" data-next aria-label="Next slide">›</button>
</nav>
<script>${presentationScript()}</script>
</body>
</html>`;
}

/**
 * Async compile path that resolves template-pack layouts before rendering.
 * Use this when the deck has `templatePack` and slides have `layout`.
 */
export async function compileRevealHtmlAsync(
  deck: PresentationDeck,
  options: CompilePresentationOptions = {},
): Promise<string> {
  const resolved = await resolveLayoutHtml(deck, options.templatePackResolver);
  return compileRevealHtml(resolved, options);
}

async function resolveLayoutHtml(
  deck: PresentationDeck,
  resolver: TemplatePackResolver | undefined,
): Promise<PresentationDeck> {
  if (!resolver || !deck.templatePack) return deck;
  const out = await Promise.all(
    deck.slides.map(async (slide, index) => {
      if (slide.html || !slide.layout) return slide;
      const slots = { page: index + 1, ...(slide.slots ?? {}) } as Record<string, string | number | null | undefined>;
      const html = await resolver(deck.templatePack as string, slide.layout, slots);
      return { ...slide, html };
    }),
  );
  return { ...deck, slides: out };
}

export function renderStaticSlideHtml(deck: PresentationDeck, slideIndex = 0, options: CompilePresentationOptions = {}): string {
  const slide = deck.slides[Math.max(0, Math.min(deck.slides.length - 1, slideIndex))];
  if (!slide) return "";
  return `<div class="presentation-static"><style>${presentationCss(deck)}</style>${renderSlide(deck, slide, slideIndex, true, options.assetResolver)}</div>`;
}

function renderSlide(deck: PresentationDeck, slide: PresentationSlide, index: number, forceActive = false, assetResolver?: PresentationAssetResolver): string {
  const template = slide.template ?? inferTemplate(slide);
  if (typeof slide.html === "string" && slide.html.length > 0) return renderHtmlSlide(deck, slide, index, forceActive);
  if (template === "title") return renderTitleSlide(deck, slide, index, forceActive, assetResolver);
  return `<section class="slide slide-${escapeAttr(template)}${forceActive || index === 0 ? " active" : ""}" data-slide-index="${index}" data-template="${escapeAttr(template)}">
  <div class="slide-inner">
    ${slide.eyebrow ? `<p class="eyebrow">${escapeHtml(slide.eyebrow)}</p>` : ""}
    ${slide.title ? `<h1>${escapeHtml(slide.title)}</h1>` : ""}
    ${slide.subtitle ? `<p class="subtitle">${escapeHtml(slide.subtitle)}</p>` : ""}
    ${renderMainContent(slide, template, assetResolver)}
  </div>
  ${renderBrandChrome(deck, index, assetResolver)}
  ${slide.notes ? `<aside class="notes">${escapeHtml(slide.notes)}</aside>` : ""}
</section>`;
}

function renderHtmlSlide(deck: PresentationDeck, slide: PresentationSlide, index: number, forceActive = false): string {
  // Pass-through for template-pack extensions that ship pre-rendered HTML.
  // No escaping: callers (other extensions) are trusted to produce safe HTML.
  const template = slide.template ?? "html";
  return `<section class="slide slide-${escapeAttr(template)}${forceActive || index === 0 ? " active" : ""}" data-slide-index="${index}" data-template="${escapeAttr(template)}">\n  <div class="slide-inner slide-html">${slide.html}</div>\n  ${slide.notes ? `<aside class="notes">${escapeHtml(slide.notes)}</aside>` : ""}\n</section>`;
}

function renderTitleSlide(deck: PresentationDeck, slide: PresentationSlide, index: number, forceActive = false, assetResolver?: PresentationAssetResolver): string {
  const rawLines = (slide.title ?? deck.title).split(/\r?\n/).filter(Boolean);
  const lines = rawLines.length > 0 ? rawLines : [deck.title, deck.subtitle ?? ""].filter(Boolean);
  const primary = lines[0] ?? "";
  const secondary = lines.slice(1).join("\n") || slide.subtitle || deck.subtitle || "";
  return `<section class="slide slide-title${forceActive || index === 0 ? " active" : ""}" data-slide-index="${index}" data-template="title">
  <div class="title-block" aria-label="${escapeAttr([primary, secondary].filter(Boolean).join(" "))}">
    <span class="title-primary">${escapeHtml(primary)}</span>${secondary ? `<span class="title-secondary">${escapeHtml(secondary)}</span>` : ""}
  </div>
  <div class="title-date">${escapeHtml(deck.date ?? "[Date]")}</div>
  <div class="title-client">${escapeHtml(deck.client ?? "[Client]")}</div>
  ${slide.body ? `<p class="title-summary">${escapeHtml(slide.body)}</p>` : ""}
  ${renderBrandChrome(deck, index, assetResolver)}
  ${slide.notes ? `<aside class="notes">${escapeHtml(slide.notes)}</aside>` : ""}
</section>`;
}

function renderMainContent(slide: PresentationSlide, template: string, assetResolver?: PresentationAssetResolver): string {
  if (template === "quote") {
    return `<blockquote>${escapeHtml(slide.quote ?? slide.body ?? "")}</blockquote>${slide.attribution ? `<cite>${escapeHtml(slide.attribution)}</cite>` : ""}`;
  }
  const parts: string[] = [];
  if (slide.body) parts.push(`<p class="body">${escapeHtml(slide.body)}</p>`);
  if (slide.bullets?.length) parts.push(renderBullets(slide.bullets));
  if (slide.stats?.length) parts.push(`<div class="stats">${slide.stats.map((stat) => `<div class="stat"><strong>${escapeHtml(stat.value)}</strong>${stat.label ? `<span>${escapeHtml(stat.label)}</span>` : ""}</div>`).join("")}</div>`);
  if (slide.columns?.length) parts.push(`<div class="columns">${slide.columns.map((column) => `<article class="column-card">${column.title ? `<h2>${escapeHtml(column.title)}</h2>` : ""}${column.body ? `<p>${escapeHtml(column.body)}</p>` : ""}${column.bullets?.length ? renderBullets(column.bullets) : ""}</article>`).join("")}</div>`);
  if (slide.image) parts.push(`<figure class="slide-image"><img src="${escapeAttr(resolvePresentationAssetSrc(slide.image.src, assetResolver))}" alt="${escapeAttr(slide.image.alt ?? slide.title ?? "slide image")}" /></figure>`);
  if (slide.fragments?.length) parts.push(`<ol class="fragments">${slide.fragments.map((fragment) => `<li>${escapeHtml(fragment)}</li>`).join("")}</ol>`);
  return `<div class="content">${parts.join("\n")}</div>`;
}

function renderBrandChrome(deck: PresentationDeck, index: number, assetResolver?: PresentationAssetResolver): string {
  const logo = deck.logo
    ? `<img class="brand-logo" src="${escapeAttr(resolvePresentationAssetSrc(deck.logo.src, assetResolver))}" alt="${escapeAttr(deck.logo.alt ?? "Brand logo")}" />`
    : "";
  return `<div class="brand-rule brand-rule-top" aria-hidden="true"></div>${logo}<div class="brand-rule brand-rule-footer" aria-hidden="true"></div><footer><span>${escapeHtml(deck.confidential ?? "Confidential and Proprietary")}</span><span>${index + 1}</span></footer>`;
}

function renderBullets(bullets: readonly (string | PresentationBullet)[]): string {
  return `<ul class="bullets">${bullets.map((bullet) => {
    if (typeof bullet === "string") return `<li>${escapeHtml(bullet)}</li>`;
    return `<li><span>${escapeHtml(bullet.text)}</span>${bullet.detail ? `<small>${escapeHtml(bullet.detail)}</small>` : ""}</li>`;
  }).join("")}</ul>`;
}

function inferTemplate(slide: PresentationSlide): string {
  if (slide.quote) return "quote";
  if (slide.stats?.length) return "metric";
  if (slide.columns?.length) return "columns";
  if (slide.image) return "image-split";
  return "title-bullets";
}

function presentationCss(deck: PresentationDeck): string {
  const dark = deck.theme === "dark";
  return `:root{--bg:${dark ? "#111827" : "#f9fafb"};--fg:${dark ? "#f9fafb" : "#111827"};--muted:${dark ? "#cbd5e1" : "#6b7280"};--accent:#2563eb;--card:${dark ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.86)"};font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:#111;color:var(--fg);overflow:hidden}.deck{width:100vw;height:100vh;background:var(--bg)}.slide{position:absolute;inset:0;display:none;background:radial-gradient(circle at 8% 8%,rgba(255,90,31,.13),transparent 32%),var(--bg);padding:5.2vw 5.8vw 4.2vw}.slide.active{display:block}.slide-title{background:var(--bg);padding:0}.slide-title .title-block{position:absolute;left:6.25vw;top:42.5vh;margin:0;font-size:5vw;line-height:.90625;letter-spacing:-.037em;font-weight:400}.slide-title .title-primary{display:block;color:var(--muted)}.slide-title .title-secondary{display:block;color:var(--fg)}.slide-title .title-date{position:absolute;left:61.35vw;top:43.98vh;font-size:1.25vw;line-height:1.125;letter-spacing:-.01em;font-weight:400}.slide-title .title-client{position:absolute;left:90.16vw;top:43.98vh;font-size:1.25vw;line-height:1.125;letter-spacing:-.01em;font-weight:400}.slide-title .title-summary{position:absolute;left:61.77vw;top:51.57vh;width:29.95vw;margin:0;font-size:1.25vw;line-height:1.125;letter-spacing:-.01em;font-weight:400;color:var(--fg)}.slide-inner{height:100%;display:flex;flex-direction:column}.eyebrow{margin:0 0 1rem;color:var(--accent);font-size:1.3vw;font-weight:700;letter-spacing:.08em;text-transform:uppercase}h1{font-size:4.3vw;line-height:.98;margin:0 0 1.2vw;letter-spacing:-.055em;max-width:78%}.subtitle{font-size:1.65vw;line-height:1.25;color:var(--muted);margin:0 0 2.4vw;max-width:62%}.body{font-size:1.55vw;line-height:1.45;max-width:58%;color:var(--muted)}.content{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:3vw;align-items:center;flex:1}.bullets{list-style:none;margin:0;padding:0;display:grid;gap:1.15vw}.bullets li{font-size:1.58vw;line-height:1.25;padding-left:1.9vw;position:relative}.bullets li:before{content:"";position:absolute;left:0;top:.45em;width:.62vw;height:.62vw;border-radius:999px;background:var(--accent)}.bullets small{display:block;color:var(--muted);font-size:1.05vw;margin-top:.38vw;line-height:1.35}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(11vw,1fr));gap:1.3vw}.stat{background:var(--card);border:1px solid rgba(17,24,39,.09);border-radius:1.3vw;padding:1.5vw}.stat strong{display:block;font-size:4.8vw;line-height:1;color:var(--accent);letter-spacing:-.06em}.stat span{display:block;margin-top:.8vw;color:var(--muted);font-size:1.15vw}.columns{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(16vw,1fr));gap:1.2vw}.column-card{background:var(--card);border-radius:1.3vw;padding:1.6vw;min-height:13vw}.column-card h2{margin:0 0 .8vw;font-size:1.45vw}.column-card p{color:var(--muted);font-size:1.05vw;line-height:1.45}.slide-image{margin:0;align-self:stretch;height:100%;min-height:22vw;border-radius:1.4vw;overflow:hidden;background:#e5e7eb}.slide-image img{width:100%;height:100%;object-fit:cover;display:block}.slide-quote .slide-inner{justify-content:center}.slide-quote blockquote{font-size:3.25vw;line-height:1.16;letter-spacing:-.035em;max-width:78%;margin:0}.slide-quote cite{margin-top:2vw;color:var(--accent);font-style:normal;font-weight:700;font-size:1.35vw}.fragments{font-size:1.3vw;color:var(--muted)}.brand-rule{position:absolute;height:1px;background:var(--fg);opacity:.96}.brand-rule-top{left:61.77vw;right:6.2vw;top:43.52vh}.brand-rule-footer{left:6.25vw;right:6.2vw;bottom:5.56vh}.brand-logo{position:absolute;left:6.2vw;bottom:3.05vh;width:4.17vw;height:auto;display:block}footer{position:absolute;left:22.92vw;right:6.2vw;bottom:3.17vh;display:flex;justify-content:space-between;color:var(--fg);font-size:.625vw;line-height:1.1667}.deck-controls{position:fixed;right:1rem;bottom:1rem;display:flex;gap:.5rem;align-items:center;background:rgba(0,0,0,.45);color:white;border-radius:999px;padding:.4rem .65rem;font:14px system-ui}.deck-controls button{border:0;border-radius:999px;background:rgba(255,255,255,.15);color:white;width:2rem;height:2rem;font-size:1.4rem}.notes{display:none}@media print{body{overflow:visible}.deck{height:auto}.slide{position:relative;display:block;page-break-after:always;width:100vw;height:56.25vw}.deck-controls{display:none}}`;
}

function presentationScript(): string {
  return `(()=>{const slides=[...document.querySelectorAll('.slide')];let i=Number(document.body.dataset.startSlide)||0;const counter=document.querySelector('[data-counter]');function show(n){i=Math.max(0,Math.min(slides.length-1,n));slides.forEach((s,idx)=>s.classList.toggle('active',idx===i));if(counter)counter.textContent=(i+1)+' / '+slides.length;}document.querySelector('[data-prev]')?.addEventListener('click',()=>show(i-1));document.querySelector('[data-next]')?.addEventListener('click',()=>show(i+1));addEventListener('keydown',e=>{if(['ArrowRight','PageDown',' '].includes(e.key)){e.preventDefault();show(i+1)}if(['ArrowLeft','PageUp'].includes(e.key)){e.preventDefault();show(i-1)}});show(i);})();`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
