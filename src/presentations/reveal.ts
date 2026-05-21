import type { PresentationBullet, PresentationDeck, PresentationSlide } from "./schema.js";

export interface CompilePresentationOptions {
  readonly startSlide?: number;
  readonly title?: string;
}

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
${deck.slides.map((slide, index) => renderSlide(deck, slide, index)).join("\n")}
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

export function renderStaticSlideHtml(deck: PresentationDeck, slideIndex = 0): string {
  const slide = deck.slides[Math.max(0, Math.min(deck.slides.length - 1, slideIndex))];
  if (!slide) return "";
  return `<div class="presentation-static"><style>${presentationCss(deck)}</style>${renderSlide(deck, slide, slideIndex, true)}</div>`;
}

function renderSlide(deck: PresentationDeck, slide: PresentationSlide, index: number, forceActive = false): string {
  const template = slide.template ?? inferTemplate(slide);
  return `<section class="slide slide-${escapeAttr(template)}${forceActive || index === 0 ? " active" : ""}" data-slide-index="${index}" data-template="${escapeAttr(template)}">
  <div class="slide-inner">
    ${slide.eyebrow ? `<p class="eyebrow">${escapeHtml(slide.eyebrow)}</p>` : ""}
    ${slide.title ? `<h1>${escapeHtml(slide.title)}</h1>` : ""}
    ${slide.subtitle ? `<p class="subtitle">${escapeHtml(slide.subtitle)}</p>` : ""}
    ${renderMainContent(slide, template)}
  </div>
  <footer><span>${escapeHtml(deck.confidential ?? "Confidential and Proprietary")}</span><span>${index + 1}</span></footer>
  ${slide.notes ? `<aside class="notes">${escapeHtml(slide.notes)}</aside>` : ""}
</section>`;
}

function renderMainContent(slide: PresentationSlide, template: string): string {
  if (template === "quote") {
    return `<blockquote>${escapeHtml(slide.quote ?? slide.body ?? "")}</blockquote>${slide.attribution ? `<cite>${escapeHtml(slide.attribution)}</cite>` : ""}`;
  }
  const parts: string[] = [];
  if (slide.body) parts.push(`<p class="body">${escapeHtml(slide.body)}</p>`);
  if (slide.bullets?.length) parts.push(renderBullets(slide.bullets));
  if (slide.stats?.length) parts.push(`<div class="stats">${slide.stats.map((stat) => `<div class="stat"><strong>${escapeHtml(stat.value)}</strong>${stat.label ? `<span>${escapeHtml(stat.label)}</span>` : ""}</div>`).join("")}</div>`);
  if (slide.columns?.length) parts.push(`<div class="columns">${slide.columns.map((column) => `<article class="column-card">${column.title ? `<h2>${escapeHtml(column.title)}</h2>` : ""}${column.body ? `<p>${escapeHtml(column.body)}</p>` : ""}${column.bullets?.length ? renderBullets(column.bullets) : ""}</article>`).join("")}</div>`);
  if (slide.image) parts.push(`<figure class="slide-image"><img src="${escapeAttr(slide.image.src)}" alt="${escapeAttr(slide.image.alt ?? slide.title ?? "slide image")}" /></figure>`);
  if (slide.fragments?.length) parts.push(`<ol class="fragments">${slide.fragments.map((fragment) => `<li>${escapeHtml(fragment)}</li>`).join("")}</ol>`);
  return `<div class="content">${parts.join("\n")}</div>`;
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
  return `:root{--bg:${dark ? "#111827" : "#f7f3ec"};--fg:${dark ? "#f9fafb" : "#111827"};--muted:${dark ? "#cbd5e1" : "#4b5563"};--accent:#ff5a1f;--card:${dark ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.72)"};font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:#111;color:var(--fg);overflow:hidden}.deck{width:100vw;height:100vh;background:var(--bg)}.slide{position:absolute;inset:0;display:none;background:radial-gradient(circle at 8% 8%,rgba(255,90,31,.13),transparent 32%),var(--bg);padding:5.2vw 5.8vw 4.2vw}.slide.active{display:block}.slide-inner{height:100%;display:flex;flex-direction:column}.eyebrow{margin:0 0 1rem;color:var(--accent);font-size:1.3vw;font-weight:700;letter-spacing:.08em;text-transform:uppercase}h1{font-size:4.3vw;line-height:.98;margin:0 0 1.2vw;letter-spacing:-.055em;max-width:78%}.subtitle{font-size:1.65vw;line-height:1.25;color:var(--muted);margin:0 0 2.4vw;max-width:62%}.body{font-size:1.55vw;line-height:1.45;max-width:58%;color:var(--muted)}.content{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:3vw;align-items:center;flex:1}.bullets{list-style:none;margin:0;padding:0;display:grid;gap:1.15vw}.bullets li{font-size:1.58vw;line-height:1.25;padding-left:1.9vw;position:relative}.bullets li:before{content:"";position:absolute;left:0;top:.45em;width:.62vw;height:.62vw;border-radius:999px;background:var(--accent)}.bullets small{display:block;color:var(--muted);font-size:1.05vw;margin-top:.38vw;line-height:1.35}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(11vw,1fr));gap:1.3vw}.stat{background:var(--card);border:1px solid rgba(17,24,39,.09);border-radius:1.3vw;padding:1.5vw}.stat strong{display:block;font-size:4.8vw;line-height:1;color:var(--accent);letter-spacing:-.06em}.stat span{display:block;margin-top:.8vw;color:var(--muted);font-size:1.15vw}.columns{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(16vw,1fr));gap:1.2vw}.column-card{background:var(--card);border-radius:1.3vw;padding:1.6vw;min-height:13vw}.column-card h2{margin:0 0 .8vw;font-size:1.45vw}.column-card p{color:var(--muted);font-size:1.05vw;line-height:1.45}.slide-image{margin:0;align-self:stretch;height:100%;min-height:22vw;border-radius:1.4vw;overflow:hidden;background:#e5e7eb}.slide-image img{width:100%;height:100%;object-fit:cover;display:block}.slide-quote .slide-inner{justify-content:center}.slide-quote blockquote{font-size:3.25vw;line-height:1.16;letter-spacing:-.035em;max-width:78%;margin:0}.slide-quote cite{margin-top:2vw;color:var(--accent);font-style:normal;font-weight:700;font-size:1.35vw}.fragments{font-size:1.3vw;color:var(--muted)}footer{position:absolute;left:5.8vw;right:5.8vw;bottom:2.1vw;display:flex;justify-content:space-between;color:var(--muted);font-size:.9vw}.deck-controls{position:fixed;right:1rem;bottom:1rem;display:flex;gap:.5rem;align-items:center;background:rgba(0,0,0,.45);color:white;border-radius:999px;padding:.4rem .65rem;font:14px system-ui}.deck-controls button{border:0;border-radius:999px;background:rgba(255,255,255,.15);color:white;width:2rem;height:2rem;font-size:1.4rem}.notes{display:none}@media print{body{overflow:visible}.deck{height:auto}.slide{position:relative;display:block;page-break-after:always;width:100vw;height:56.25vw}.deck-controls{display:none}}`;
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
