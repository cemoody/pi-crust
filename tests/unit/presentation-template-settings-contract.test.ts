import { describe, it } from "vitest";

// TDD contract for the next implementation step. These are intentionally
// pending until pi-crust grows extension-contributed Settings sections and the
// presentations extension wires template-directory configuration through them.
describe.todo("presentation template settings contribution", () => {
  it("lets core.presentations register a Settings section without adding a sidebar activity");
  it("persists templateDirs, defaultTemplatePack, and defaultTheme through extension-owned routes");
  it("discovers template-pack.json files from configured directories and reports diagnostics");
  it("rejects unsafe template paths and assets outside configured template directories");
  it("surfaces configured template packs/layouts to the presentation tools without dumping large files into the prompt");
});
