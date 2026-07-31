/**
 * @deprecated Import presentation compiler APIs from `./compiler/index.js`.
 * This facade preserves the public entry point used by existing extensions.
 */
export {
  compileRevealHtml,
  compileRevealHtmlAsync,
  renderStaticSlideHtml,
  type CompilePresentationOptions,
  type TemplatePackResolver,
} from "./compiler/index.js";
