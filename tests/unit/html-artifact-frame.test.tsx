// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HtmlArtifactFrame } from "../../src/web/components/HtmlArtifactFrame.js";

describe("<HtmlArtifactFrame />", () => {
  it("renders an iframe with sandbox=\"allow-scripts\" only", () => {
    const { container } = render(
      <HtmlArtifactFrame
        artifactGroupId="g1"
        representation={{ mime: "text/html", html: "<p>hello</p>" }}
      />,
    );
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    // We must NEVER include allow-same-origin alongside allow-scripts.
    expect(iframe?.getAttribute("sandbox")).not.toMatch(/allow-same-origin/);
  });

  it("uses srcDoc for inline HTML representations", () => {
    const { container } = render(
      <HtmlArtifactFrame
        artifactGroupId="g1"
        representation={{ mime: "text/html", html: "<p>inline</p>" }}
      />,
    );
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("srcdoc")).toBe("<p>inline</p>");
    expect(iframe?.getAttribute("src")).toBeNull();
  });

  it("uses src for URL representations and resolves through apiBaseUrl", () => {
    const { container } = render(
      <HtmlArtifactFrame
        artifactGroupId="g1"
        representation={{ mime: "text/html", src: { kind: "url", url: "/api/sessions/s/artifacts/g1.html" } }}
        apiBaseUrl="http://localhost:8787"
      />,
    );
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toBe("http://localhost:8787/api/sessions/s/artifacts/g1.html");
    expect(iframe?.getAttribute("srcdoc")).toBeNull();
  });

  it("updates height on a matching artifact:resize postMessage", () => {
    const { container } = render(
      <HtmlArtifactFrame
        artifactGroupId="g1"
        representation={{ mime: "text/html", html: "<p>x</p>", height: 100 }}
      />,
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.style.height).toBe("100px");

    act(() => {
      // The component filters messages by event.source === iframe.contentWindow.
      // jsdom iframes expose a contentWindow we can spoof in the event init.
      const messageEvent = new MessageEvent("message", {
        data: { type: "artifact:resize", artifactGroupId: "g1", height: 350 },
        source: iframe.contentWindow ?? null,
      });
      window.dispatchEvent(messageEvent);
    });
    expect(iframe.style.height).toBe("350px");
  });

  it("ignores resize messages with mismatched artifactGroupId", () => {
    const { container } = render(
      <HtmlArtifactFrame
        artifactGroupId="mine"
        representation={{ mime: "text/html", html: "<p>x</p>", height: 100 }}
      />,
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    act(() => {
      const e = new MessageEvent("message", {
        data: { type: "artifact:resize", artifactGroupId: "different", height: 999 },
        source: iframe.contentWindow ?? null,
      });
      window.dispatchEvent(e);
    });
    expect(iframe.style.height).toBe("100px");
  });

  it("ignores resize messages whose source is not this frame's contentWindow", () => {
    const { container } = render(
      <HtmlArtifactFrame
        artifactGroupId="g1"
        representation={{ mime: "text/html", html: "<p>x</p>", height: 100 }}
      />,
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    act(() => {
      const e = new MessageEvent("message", {
        data: { type: "artifact:resize", artifactGroupId: "g1", height: 999 },
        source: window, // wrong source
      });
      window.dispatchEvent(e);
    });
    expect(iframe.style.height).toBe("100px");
  });

  it("clamps height to the configured maxHeight", () => {
    const { container } = render(
      <HtmlArtifactFrame
        artifactGroupId="g1"
        representation={{ mime: "text/html", html: "<p>x</p>" }}
        maxHeight={400}
      />,
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    act(() => {
      const e = new MessageEvent("message", {
        data: { type: "artifact:resize", artifactGroupId: "g1", height: 100000 },
        source: iframe.contentWindow ?? null,
      });
      window.dispatchEvent(e);
    });
    expect(iframe.style.height).toBe("400px");
  });

  it("has a Fullscreen toggle", () => {
    render(
      <HtmlArtifactFrame
        artifactGroupId="g1"
        representation={{ mime: "text/html", html: "<p>x</p>" }}
      />,
    );
    expect(screen.getByRole("button", { name: /Fullscreen/i })).toBeTruthy();
  });
});
