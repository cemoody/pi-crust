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
  /** When true, every editable text node carries `data-deck-path` (RFC6902
   *  JSON pointer) + `contenteditable="plaintext-only"`, and a wrapper
   *  script forwards `input` events to `window.parent` via postMessage as
   *  `{ type: "pi-deck-edit", path, value, deckId }`. */
  readonly editable?: boolean;
}

export type TemplatePackResolver = (
  packId: string,
  layoutKey: string,
  slots: Record<string, string | number | null | undefined>,
) => string | Promise<string>;

export function compileRevealHtml(deck: PresentationDeck, options: CompilePresentationOptions = {}): string {
  const start = Math.max(0, Math.min(deck.slides.length - 1, options.startSlide ?? 0));
  const title = options.title ?? deck.title;
  const editable = options.editable === true;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${presentationCss(deck)}${editable ? editableCss() : ""}</style>
</head>
<body data-start-slide="${start}"${editable ? ` data-editable="true" data-deck-id="${escapeAttr(deck.id ?? "")}"` : ""}>
<main class="deck" aria-label="${escapeHtml(deck.title)}">
${deck.slides.map((slide, index) => renderSlide(deck, slide, index, false, options.assetResolver, editable)).join("\n")}
</main>
<nav class="deck-controls" aria-label="Slide controls">
  <button type="button" data-prev aria-label="Previous slide">‹</button>
  <span data-counter></span>
  <button type="button" data-next aria-label="Next slide">›</button>
</nav>
<script>${presentationScript()}${editable ? editableScript() : ""}</script>
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
  return `<div class="presentation-static"><style>${presentationCss(deck)}</style>${renderSlide(deck, slide, slideIndex, true, options.assetResolver, options.editable === true)}</div>`;
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
  const template = slide.template ?? "html";
  return `<section class="slide slide-${escapeAttr(template)}${forceActive || index === 0 ? " active" : ""}" data-slide-index="${index}" data-template="${escapeAttr(template)}" data-non-editable="templated">\n  <div class="slide-inner slide-html">${slide.html}</div>\n  ${slide.notes ? `<aside class="notes">${escapeHtml(slide.notes)}</aside>` : ""}\n</section>`;
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

function presentationCss(deck: PresentationDeck): string {
  const dark = deck.theme === "dark";
  return `:root{--bg:${dark ? "#111827" : "#f9fafb"};--fg:${dark ? "#f9fafb" : "#111827"};--muted:${dark ? "#cbd5e1" : "#6b7280"};--accent:#2563eb;--card:${dark ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.86)"};font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:#111;color:var(--fg);overflow:hidden}.deck{width:100vw;height:100vh;background:var(--bg)}.deck>.slide{position:absolute;inset:0;display:none;background:radial-gradient(circle at 8% 8%,rgba(255,90,31,.13),transparent 32%),var(--bg);padding:5.2vw 5.8vw 4.2vw}.deck>.slide.active{display:block}.slide-title{background:var(--bg);padding:0}.slide-title .title-block{position:absolute;left:6.25vw;top:42.5vh;margin:0;font-size:5vw;line-height:.90625;letter-spacing:-.037em;font-weight:400}.slide-title .title-primary{display:block;color:var(--muted)}.slide-title .title-secondary{display:block;color:var(--fg)}.slide-title .title-date{position:absolute;left:61.35vw;top:43.98vh;font-size:1.25vw;line-height:1.125;letter-spacing:-.01em;font-weight:400}.slide-title .title-client{position:absolute;left:90.16vw;top:43.98vh;font-size:1.25vw;line-height:1.125;letter-spacing:-.01em;font-weight:400}.slide-title .title-summary{position:absolute;left:61.77vw;top:51.57vh;width:29.95vw;margin:0;font-size:1.25vw;line-height:1.125;letter-spacing:-.01em;font-weight:400;color:var(--fg)}.slide-inner{height:100%;display:flex;flex-direction:column}.eyebrow{margin:0 0 1rem;color:var(--accent);font-size:1.3vw;font-weight:700;letter-spacing:.08em;text-transform:uppercase}h1{font-size:4.3vw;line-height:.98;margin:0 0 1.2vw;letter-spacing:-.055em;max-width:78%}.subtitle{font-size:1.65vw;line-height:1.25;color:var(--muted);margin:0 0 2.4vw;max-width:62%}.body{font-size:1.55vw;line-height:1.45;max-width:58%;color:var(--muted)}.content{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:3vw;align-items:center;flex:1}.bullets{list-style:none;margin:0;padding:0;display:grid;gap:1.15vw}.bullets li{font-size:1.58vw;line-height:1.25;padding-left:1.9vw;position:relative}.bullets li:before{content:"";position:absolute;left:0;top:.45em;width:.62vw;height:.62vw;border-radius:999px;background:var(--accent)}.bullets small{display:block;color:var(--muted);font-size:1.05vw;margin-top:.38vw;line-height:1.35}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(11vw,1fr));gap:1.3vw}.stat{background:var(--card);border:1px solid rgba(17,24,39,.09);border-radius:1.3vw;padding:1.5vw}.stat strong{display:block;font-size:4.8vw;line-height:1;color:var(--accent);letter-spacing:-.06em}.stat span{display:block;margin-top:.8vw;color:var(--muted);font-size:1.15vw}.columns{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(16vw,1fr));gap:1.2vw}.column-card{background:var(--card);border-radius:1.3vw;padding:1.6vw;min-height:13vw}.column-card h2{margin:0 0 .8vw;font-size:1.45vw}.column-card p{color:var(--muted);font-size:1.05vw;line-height:1.45}.slide-image{margin:0;align-self:stretch;height:100%;min-height:22vw;border-radius:1.4vw;overflow:hidden;background:#e5e7eb}.slide-image img{width:100%;height:100%;object-fit:cover;display:block}.slide-quote .slide-inner{justify-content:center}.slide-quote blockquote{font-size:3.25vw;line-height:1.16;letter-spacing:-.035em;max-width:78%;margin:0}.slide-quote cite{margin-top:2vw;color:var(--accent);font-style:normal;font-weight:700;font-size:1.35vw}.fragments{font-size:1.3vw;color:var(--muted)}.brand-rule{position:absolute;height:1px;background:var(--fg);opacity:.96}.brand-rule-top{left:61.77vw;right:6.2vw;top:43.52vh}.brand-rule-footer{left:6.25vw;right:6.2vw;bottom:5.56vh}.brand-logo{position:absolute;left:6.2vw;bottom:3.05vh;width:4.17vw;height:auto;display:block}footer{position:absolute;left:22.92vw;right:6.2vw;bottom:3.17vh;display:flex;justify-content:space-between;color:var(--fg);font-size:.625vw;line-height:1.1667}.deck-controls{position:fixed;right:1rem;bottom:1rem;display:flex;gap:.5rem;align-items:center;background:rgba(0,0,0,.45);color:white;border-radius:999px;padding:.4rem .65rem;font:14px system-ui}.deck-controls button{border:0;border-radius:999px;background:rgba(255,255,255,.15);color:white;width:2rem;height:2rem;font-size:1.4rem}.notes{display:none}@media print{body{overflow:visible}.deck{height:auto}.deck>.slide{position:relative;display:block;page-break-after:always;width:100vw;height:56.25vw}.deck-controls{display:none}}`;
}

function presentationScript(): string {
  // Note: keyboard nav is disabled while the focused element is
  // contenteditable so editable slides don't lose space/arrow keystrokes
  // to the slide-advance handler.
  return `(()=>{const slides=[...document.querySelectorAll('.deck>.slide')];let i=Number(document.body.dataset.startSlide)||0;const counter=document.querySelector('[data-counter]');function post(){try{window.parent&&window.parent.postMessage({type:'pi-deck-state',index:i,total:slides.length},'*');}catch(_){}}function show(n){i=Math.max(0,Math.min(slides.length-1,n));slides.forEach((s,idx)=>s.classList.toggle('active',idx===i));if(counter)counter.textContent=(i+1)+' / '+slides.length;post();}document.querySelector('[data-prev]')?.addEventListener('click',()=>show(i-1));document.querySelector('[data-next]')?.addEventListener('click',()=>show(i+1));addEventListener('keydown',e=>{const t=e.target;if(t&&(t.isContentEditable||(t.tagName==='INPUT'||t.tagName==='TEXTAREA')))return;if(['ArrowRight','PageDown',' '].includes(e.key)){e.preventDefault();show(i+1)}if(['ArrowLeft','PageUp'].includes(e.key)){e.preventDefault();show(i-1)}});addEventListener('message',e=>{const d=e.data;if(!d||typeof d!=='object'||d.type!=='pi-deck-nav')return;if(d.dir==='next')show(i+1);else if(d.dir==='prev')show(i-1);else if(d.dir==='first')show(0);else if(d.dir==='last')show(slides.length-1);else if(typeof d.index==='number')show(d.index);});let sx=0,sy=0,st=0,sa=false;addEventListener('touchstart',e=>{if(e.touches.length!==1){sa=false;return;}const t=e.target;if(t&&(t.isContentEditable||t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='BUTTON'||t.closest&&t.closest('.deck-controls')))return;sa=true;sx=e.touches[0].clientX;sy=e.touches[0].clientY;st=Date.now();},{passive:true});addEventListener('touchend',e=>{if(!sa)return;sa=false;const t=e.changedTouches[0];if(!t)return;const dx=t.clientX-sx,dy=t.clientY-sy,dt=Date.now()-st;if(dt>600)return;if(Math.abs(dx)<50||Math.abs(dx)<Math.abs(dy)*1.2)return;if(dx<0)show(i+1);else show(i-1);},{passive:true});show(i);})();`;
}

/** Returns an attribute-emitting helper. When `editable` is true, the
 *  helper produces ` data-deck-path="…" contenteditable="plaintext-only"`.
 *  Otherwise it returns the empty string. */
function editableAttrs(editable: boolean): (path: string) => string {
  if (!editable) return () => "";
  return (path) => ` data-deck-path="${escapeAttr(path)}" contenteditable="plaintext-only"`;
}

function editableCss(): string {
  return `[data-editable="true"] [contenteditable]{outline:1px dashed rgba(37,99,235,.4);outline-offset:.2vw;border-radius:.25vw;transition:outline-color .15s ease}[data-editable="true"] [contenteditable]:hover{outline-color:rgba(37,99,235,.7)}[data-editable="true"] [contenteditable]:focus{outline:2px solid var(--accent);outline-offset:.2vw;background:rgba(37,99,235,.06)}`;
}

function editableScript(): string {
  // Forwards every input on a [data-deck-path] node to window.parent as
  // `{ type: 'pi-deck-edit', deckId, path, value }`. Plain-text only because
  // contenteditable is `plaintext-only`. Keep this script byte-cheap; it's
  // inlined into every editable iframe.
  return `;(()=>{const id=document.body.dataset.deckId||'';document.body.addEventListener('input',e=>{const t=e.target;if(!t||!t.getAttribute)return;const p=t.getAttribute('data-deck-path');if(!p)return;const v=t.innerText.replace(/\\n+$/,'');try{window.parent&&window.parent.postMessage({type:'pi-deck-edit',deckId:id,path:p,value:v},'*');}catch(_){}});})();`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
