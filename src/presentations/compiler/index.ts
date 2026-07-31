/**
 * Presentation compilation boundary.
 *
 * Consumers that need compiled deck HTML should import from this directory.
 * The legacy `presentations/reveal` entry point remains a compatibility facade.
 */
export {
  compileRevealHtml,
  compileRevealHtmlAsync,
  renderStaticSlideHtml,
  type CompilePresentationOptions,
  type TemplatePackResolver,
} from "./reveal-compiler.js";
