// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PromptComposer } from "../../src/web/components/PromptComposer.js";

function renderComposer(overrides = {}) {
  const handlers = {
    onPrompt: vi.fn(),
    onSteer: vi.fn(),
    onFollowUp: vi.fn(),
    onAbort: vi.fn(),
    onBash: vi.fn(),
    onAbortBash: vi.fn(),
  };
  render(<PromptComposer
    sessionId="s1"
    isStreaming={false}
    steeringQueue={[]}
    followUpQueue={[]}
    fileSuggestions={["src/app.ts", "README.md"]}
    commandSuggestions={["model", "settings"]}
    {...handlers}
    {...overrides}
  />);
  return handlers;
}

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => store.set(key, value)),
      removeItem: vi.fn((key: string) => store.delete(key)),
      clear: vi.fn(() => store.clear()),
    },
  });
  URL.createObjectURL = vi.fn(() => "blob://preview");
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

describe("PromptComposer", () => {
  it("submits prompt when idle", () => {
    const handlers = renderComposer();
    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(handlers.onPrompt).toHaveBeenCalledWith("hello", []);
  });

  it("sends a follow-up when submitting while streaming", () => {
    const handlers = renderComposer({ isStreaming: true });
    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: "later" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(handlers.onFollowUp).toHaveBeenCalledWith("later");
    expect(handlers.onSteer).not.toHaveBeenCalled();
  });

  it("renders steering and follow-up queues", () => {
    renderComposer({ steeringQueue: ["stop"], followUpQueue: ["then test"] });
    expect(screen.getByLabelText("Message queues")).toHaveTextContent("Steer: stop");
    expect(screen.getByLabelText("Message queues")).toHaveTextContent("Follow-up: then test");
  });

  it("persists draft per session and recalls prompt history", () => {
    renderComposer();
    const draft = screen.getByLabelText("Prompt draft");
    fireEvent.change(draft, { target: { value: "remember me" } });
    expect(localStorage.getItem("draft:s1")).toBe("remember me");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.keyDown(draft, { key: "ArrowUp", altKey: true });
    expect(screen.getByLabelText("Prompt draft")).toHaveValue("remember me");
  });

  it("hides Abort and Follow-up while idle", () => {
    renderComposer();
    expect(screen.queryByRole("button", { name: "Abort" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Follow-up" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Large editor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abort bash" })).not.toBeInTheDocument();
  });

  it("handles file autocomplete and tab path completion", () => {
    renderComposer();
    const draft = screen.getByLabelText("Prompt draft");
    fireEvent.change(draft, { target: { value: "check @src" } });
    fireEvent.click(screen.getByRole("button", { name: "src/app.ts" }));
    expect(draft).toHaveValue("check @src/app.ts");

    fireEvent.change(draft, { target: { value: "READ" } });
    fireEvent.keyDown(draft, { key: "Tab" });
    expect(draft).toHaveValue("@README.md");
  });

  it("handles slash-command autocomplete", () => {
    renderComposer();
    const draft = screen.getByLabelText("Prompt draft");
    fireEvent.change(draft, { target: { value: "/mod" } });
    fireEvent.click(screen.getByRole("button", { name: "model" }));
    expect(draft).toHaveValue("/model");
  });

  it("uploads/removes attachments", async () => {
    renderComposer();
    const file = new File(["abc"], "photo.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [file] } });
    expect(await screen.findByText("photo.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByText("photo.png")).not.toBeInTheDocument();
  });

  it("submits pasted image data with the prompt", async () => {
    const handlers = renderComposer();
    const file = new File(["abc"], "photo.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [file] } });
    await screen.findByText("photo.png");

    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: "what is this?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(handlers.onPrompt).toHaveBeenCalledWith("what is this?", [expect.objectContaining({
      name: "photo.png",
      type: "image",
      mimeType: "image/png",
      data: "YWJj",
    })]);
  });

  it("submits non-image files as file attachments with base64 data", async () => {
    const handlers = renderComposer();
    const file = new File(["zipbytes"], "archive.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [file] } });
    await screen.findByText("archive.zip");

    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: "inspect this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(handlers.onPrompt).toHaveBeenCalledWith("inspect this", [expect.objectContaining({
      name: "archive.zip",
      type: "file",
      mimeType: "application/zip",
      data: "emlwYnl0ZXM=",
    })]);
  });

  it("can submit an image attachment without typed text", async () => {
    const handlers = renderComposer();
    const file = new File(["abc"], "photo.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [file] } });
    await screen.findByText("photo.png");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(handlers.onPrompt).toHaveBeenCalledWith("", [expect.objectContaining({
      name: "photo.png",
      type: "image",
      mimeType: "image/png",
      data: "YWJj",
    })]);
  });

  it("attaches images when crypto.randomUUID is unavailable", async () => {
    const originalRandomUUID = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
    try {
      const handlers = renderComposer();
      const file = new File(["abc"], "photo.png", { type: "image/png" });

      fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [file] } });
      await screen.findByText("photo.png");
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      expect(handlers.onPrompt).toHaveBeenCalledWith("", [expect.objectContaining({
        id: expect.stringMatching(/^attachment-/),
        name: "photo.png",
        type: "image",
        data: "YWJj",
      })]);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { configurable: true, value: originalRandomUUID });
    }
  });

  it("attaches pasted data-url images instead of inserting them as text", async () => {
    renderComposer();
    const draft = screen.getByLabelText("Prompt draft");
    const payload = `data:image/png;base64,iVBORw0KGgo${"A".repeat(80)}`;
    const clipboardData = {
      files: { length: 0 } as unknown as FileList,
      items: { length: 0 } as unknown as DataTransferItemList,
      types: [] as readonly string[],
      getData: (kind: string) => (kind === "text" ? payload : ""),
    };

    fireEvent.paste(draft, { clipboardData });

    expect(draft).toHaveValue("");
    expect(await screen.findByText("pasted image")).toBeInTheDocument();
    expect(screen.queryByText("Attached pasted image.")).not.toBeInTheDocument();
  });

  it("handles screenshot paste even when the prompt textarea is not focused", async () => {
    renderComposer();
    const file = new File(["abc"], "screenshot.png", { type: "image/png" });
    const clipboardData = {
      files: [file] as unknown as FileList,
      items: { length: 0 } as unknown as DataTransferItemList,
      types: ["Files"] as readonly string[],
      getData: () => "",
    };

    fireEvent.paste(document, { clipboardData });

    expect(await screen.findByText("screenshot.png")).toBeInTheDocument();
    expect(screen.queryByText("Attached pasted image.")).not.toBeInTheDocument();
  });

  it("pastes text into the prompt when no editable element is focused", () => {
    renderComposer();
    const clipboardData = {
      files: { length: 0 } as unknown as FileList,
      items: { length: 0 } as unknown as DataTransferItemList,
      types: ["text/plain"] as readonly string[],
      getData: (kind: string) => kind === "text" || kind === "text/plain" ? "hello from clipboard" : "",
    };

    fireEvent.paste(document, { clipboardData });

    expect(screen.getByLabelText("Prompt draft")).toHaveValue("hello from clipboard");
  });

  it("routes ! and !! shell commands", () => {
    const handlers = renderComposer();
    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: "!echo hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(handlers.onBash).toHaveBeenCalledWith("echo hi", true);

    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: "!!secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(handlers.onBash).toHaveBeenCalledWith("secret", false);
  });

  it("exposes Abort only while streaming with an empty draft", () => {
    const handlers = renderComposer({ isStreaming: true });
    fireEvent.click(screen.getByRole("button", { name: "Abort" }));
    expect(handlers.onAbort).toHaveBeenCalled();
  });

  it("hides Abort once the user starts typing while streaming", () => {
    renderComposer({ isStreaming: true });
    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: "draft" } });
    expect(screen.queryByRole("button", { name: "Abort" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("submits with Enter and Shift+Enter inserts a newline", () => {
    const handlers = renderComposer();
    const draft = screen.getByLabelText("Prompt draft");
    fireEvent.change(draft, { target: { value: "line 1" } });
    fireEvent.keyDown(draft, { key: "Enter" });
    expect(handlers.onPrompt).toHaveBeenCalledWith("line 1", []);
  });

  it("submits with Cmd/Ctrl+Enter as an alias for Enter", () => {
    const handlers = renderComposer();
    const draft = screen.getByLabelText("Prompt draft");
    fireEvent.change(draft, { target: { value: "command enter" } });
    fireEvent.keyDown(draft, { key: "Enter", metaKey: true });
    expect(handlers.onPrompt).toHaveBeenCalledWith("command enter", []);
  });

  it("queues a follow-up with Alt+Enter", () => {
    const handlers = renderComposer();
    const draft = screen.getByLabelText("Prompt draft");
    fireEvent.change(draft, { target: { value: "do this later" } });
    fireEvent.keyDown(draft, { key: "Enter", altKey: true });
    expect(handlers.onFollowUp).toHaveBeenCalledWith("do this later");
    expect(handlers.onPrompt).not.toHaveBeenCalled();
  });

  it("aborts with Escape while streaming", () => {
    const handlers = renderComposer({ isStreaming: true });
    const draft = screen.getByLabelText("Prompt draft");
    fireEvent.keyDown(draft, { key: "Escape" });
    expect(handlers.onAbort).toHaveBeenCalled();
  });

  it("blocks pastes that look like raw image data and shows a warning", () => {
    renderComposer();
    const draft = screen.getByLabelText("Prompt draft");
    const payload = `{"type":"image","source":{"type":"base64","mediaType":"image/png","data":"iVBORw0KGgo${"A".repeat(2000)}"}}`;
    const clipboardData = {
      files: { length: 0, item: () => null } as unknown as FileList,
      items: { length: 0 } as unknown as DataTransferItemList,
      getData: (kind: string) => (kind === "text" ? payload : ""),
    };
    fireEvent.paste(draft, { clipboardData });
    expect(draft).toHaveValue("");
    expect(screen.getByText(/Clipboard looks like raw image data/i)).toBeInTheDocument();
  });

  it("truncates a long cwd and model with leading ellipsis", () => {
    renderComposer({
      statusCwd: "/Users/chris/code/pi-crust-html-extension",
      statusModel: "anthropic/claude-opus-4-7",
      onSlashCommand: vi.fn(),
    });
    expect(screen.getByTitle("/Users/chris/code/pi-crust-html-extension")).toHaveTextContent(/^…/);
    expect(screen.getByRole("button", { name: /claude-opus-4-7/ })).toBeInTheDocument();
  });

  it("opens the model picker when the status model chip is clicked", () => {
    const onSlashCommand = vi.fn();
    renderComposer({ statusModel: "anthropic/claude-opus-4-7", onSlashCommand });
    fireEvent.click(screen.getByRole("button", { name: /claude-opus-4-7/ }));
    expect(onSlashCommand).toHaveBeenCalledWith("model", "");
  });

  it("falls back to a non-clickable model chip when onSlashCommand is absent", () => {
    renderComposer({ statusModel: "anthropic/claude-opus-4-7" });
    expect(screen.queryByRole("button", { name: /claude-opus-4-7/ })).not.toBeInTheDocument();
  });

  it("Shift+Tab from the prompt textarea moves focus to the previous tabbable element (no pathComplete swallow)", () => {
    // The composer's prompt textarea binds Tab to @-path completion. That
    // handler used to also catch Shift+Tab — trapping focus inside the
    // composer. We want Shift+Tab to behave like a normal back-tab so the
    // user can quickly hop up to the inline 'name this session' input
    // above the composer.
    renderComposer();
    const draft = screen.getByLabelText("Prompt draft");
    // fireEvent.keyDown returns false when the React handler calls
    // event.preventDefault() (i.e. the default action is cancelled).
    const shiftTabPropagated = fireEvent.keyDown(draft, { key: "Tab", shiftKey: true });
    expect(shiftTabPropagated, "Shift+Tab on the prompt textarea must NOT preventDefault (browser native back-tab needs to run)").toBe(true);
    // Forward Tab still triggers pathComplete and must preventDefault.
    const forwardTabPropagated = fireEvent.keyDown(draft, { key: "Tab", shiftKey: false });
    expect(forwardTabPropagated).toBe(false);
  });

  it("paperclip attach button is skipped in tab order so Shift+Tab lands on the previous control directly", () => {
    renderComposer();
    const paperclip = screen.getByRole("button", { name: "Add attachment" });
    expect(paperclip.tabIndex).toBe(-1);
  });

  it("ignores Escape when idle (does not clear or abort)", () => {
    const handlers = renderComposer();
    const draft = screen.getByLabelText("Prompt draft");
    fireEvent.change(draft, { target: { value: "keep me" } });
    fireEvent.keyDown(draft, { key: "Escape" });
    expect(handlers.onAbort).not.toHaveBeenCalled();
    expect(draft).toHaveValue("keep me");
  });

  // ---------------------------------------------------------------------------
  // Bug report (PR backlog): attaching an image, submitting, and then switching
  // sessions leaves the image still 'attached' in the composer; the user has
  // to click Remove to make it go away.
  //
  // The four tests below pin down each variant so we can both repro and
  // regression-guard the fix.
  // ---------------------------------------------------------------------------

  it("clears attachments after a successful submit while idle", async () => {
    renderComposer();
    const file = new File(["abc"], "photo.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [file] } });
    await screen.findByText("photo.png");
    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: "look" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.queryByText("photo.png")).not.toBeInTheDocument());
  });

  it("clears attachments after a streaming submit (follow-up path)", async () => {
    // Reproduces the production case: while the agent is streaming the
    // composer routes Send into onFollowUp. The follow-up handler takes
    // text but not attachments; submit() still needs to clear the
    // attachment state from the local composer so the user doesn't see
    // the image stuck under the textarea.
    const handlers = renderComposer({ isStreaming: true });
    const file = new File(["abc"], "photo.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [file] } });
    await screen.findByText("photo.png");
    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: "and this too" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(handlers.onFollowUp).toHaveBeenCalledWith("and this too"));
    await waitFor(() => expect(screen.queryByText("photo.png")).not.toBeInTheDocument());
  });

  it("clears attachments when the active session changes", async () => {
    // The user said "the image stays 'attached' even i change sessions and
    // go elsewhere". PromptComposer keeps its `attachments` state across
    // sessionId-prop changes today; this test pins that scope.
    const handlers = {
      onPrompt: vi.fn(),
      onSteer: vi.fn(),
      onFollowUp: vi.fn(),
      onAbort: vi.fn(),
      onBash: vi.fn(),
      onAbortBash: vi.fn(),
    };
    function Harness({ id }: { readonly id: string }) {
      return (
        <PromptComposer
          sessionId={id}
          isStreaming={false}
          steeringQueue={[]}
          followUpQueue={[]}
          fileSuggestions={[]}
          commandSuggestions={[]}
          {...handlers}
        />
      );
    }
    const { rerender } = render(<Harness id="s1" />);
    const file = new File(["abc"], "photo.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [file] } });
    await screen.findByText("photo.png");
    // Switch to a different session — the composer should not carry the
    // previous session's attachment over.
    rerender(<Harness id="s2" />);
    await waitFor(() => expect(screen.queryByText("photo.png")).not.toBeInTheDocument());
  });

  it("does not re-attach a late-resolving paste after a successful submit", async () => {
    // Race: user attaches image A (committed), starts attaching image B via
    // paste, then hits Send before B's downscale resolves. submit() clears
    // attachments to []. The async addAttachments resolver should NOT then
    // append B to the empty state — otherwise B 'pops back' into the
    // composer after the user thought they were sent.
    //
    // We simulate the race by triggering a synchronous addFiles call (which
    // returns a Promise we don't wait on) for B, then immediately clicking
    // Send. The submitted prompt should not include B and the composer
    // should not show B once everything settles.
    const handlers = renderComposer();
    const a = new File(["a-bytes"], "a.png", { type: "image/png" });
    const b = new File(["b-bytes"], "b.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [a] } });
    await screen.findByText("a.png");

    // Start B (no await) and immediately Send.
    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [b] } });
    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // Let the in-flight addAttachments resolve. After everything settles
    // there should be no leftover attachments visible in the composer.
    await waitFor(() => expect(handlers.onPrompt).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("a.png")).not.toBeInTheDocument();
    expect(screen.queryByText("b.png")).not.toBeInTheDocument();
  });
});
