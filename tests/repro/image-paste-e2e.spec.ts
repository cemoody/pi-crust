import { expect, test } from "@playwright/test";
import { bootstrapSession, DENIAL_NEEDLES, testImageBase64 } from "./fixtures/session.js";

// Regression fixture for the "pasted image renders but the model can't see it"
// bug. The real user flow is copy/paste into the composer (NOT the API
// attachment path), so we dispatch a genuine ClipboardEvent carrying a test
// PNG as a File, submit, and assert that (a) the image renders in the
// transcript AND (b) the model actually sees it (describes blue background /
// yellow circle / "42") rather than denying it.
//
// Root cause this guards against: when the model config's `input` capability
// lacks "image" (e.g. LiteLLM's /model/info reports supports_vision: null and
// discovery defaults to text-only), pi-ai's transform-messages strips the
// image to "(image omitted: model does not support images)". The UI still
// renders the bytes locally, so the symptom is "renders but LM denies it".
//
// This fixture is SELF-CONTAINED: it bootstraps its own session via the API
// (create -> seed one prompt so the jsonl is persisted and the SPA's session
// list picks it up), so there is no hardcoded session UUID to maintain. It
// targets the already-running live dev server (no webServer in the config).
//
// The test PNG (tests/repro/test-image-input.png) is a distinctive blue
// background with a yellow circle and the number "42" so recognition is
// unambiguous.

const pngBase64 = testImageBase64();

test("paste an image into the composer -> renders + model sees it", async ({ page, request }) => {
  // Bootstrap with a bare seed prompt; the paste itself exercises the image path.
  const sessionId = await bootstrapSession(request, {
    sessionName: "image-paste-e2e-fixture",
    seedText: "Reply with just: ready",
  });

  // Capture the outgoing /prompt request so we can prove the image bytes
  // actually left the browser as an attachment.
  const promptRequests: { hasImage: boolean; imgBytes: number }[] = [];
  page.on("request", (req) => {
    if (!(req.url().includes("/prompt") && req.method() === "POST")) return;
    let hasImage = false;
    let imgBytes = 0;
    try {
      const parsed = JSON.parse(req.postData() ?? "") as {
        attachments?: { type?: string; data?: string }[];
      };
      const img = (parsed.attachments ?? []).find((a) => a.type === "image" && a.data);
      if (img?.data) {
        hasImage = true;
        imgBytes = Buffer.from(img.data, "base64").length;
      }
    } catch {
      /* non-JSON / unrelated request */
    }
    promptRequests.push({ hasImage, imgBytes });
  });

  // 1) Open the bootstrapped session so the composer is mounted.
  await page.goto(`/?session=${sessionId}`, { waitUntil: "networkidle" });

  const composer = page.locator('textarea[aria-label="Prompt draft"]');
  await composer.waitFor({ state: "visible", timeout: 20000 });

  // 2) Simulate the paste: build a DataTransfer with the PNG as a File and
  //    dispatch a real ClipboardEvent on the textarea (the path users hit).
  await composer.click();
  await page.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], "pasted.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ta = document.querySelector(
      'textarea[aria-label="Prompt draft"]',
    ) as HTMLTextAreaElement;
    ta.focus();
    const evt = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(evt);
  }, pngBase64);

  // 3) Wait for the attachment to be ingested, then type the question.
  await page.waitForTimeout(1500);
  await composer.fill(
    "Look at the pasted image and tell me: background color, the center shape and its color, and any number/text.",
  );

  // 4) Submit.
  await page.locator('button[aria-label="Send"]').click();

  // 5) Poll the transcript until the model answers (or denies seeing it).
  let bodyText = "";
  await expect
    .poll(
      async () => {
        bodyText = (await page.locator("body").innerText()).toLowerCase();
        return bodyText.includes("yellow") || DENIAL_NEEDLES.some((n) => bodyText.includes(n));
      },
      { timeout: 90000, intervals: [2000] },
    )
    .toBe(true);

  // 6) Inspect rendered <img> elements (the UI-renders-locally half). The
  //    image bubble can mount slightly after the assistant text appears, so
  //    poll until at least one session image has actually loaded (naturalWidth
  //    > 0) rather than reading the count once.
  const imgs = page.locator('img[src*="/images/"], img[src*="/messages/"]');
  let loadedOk = 0;
  await expect
    .poll(
      async () => {
        const count = await imgs.count();
        loadedOk = 0;
        for (let i = 0; i < count; i++) {
          const nw = await imgs
            .nth(i)
            .evaluate((el) => (el as HTMLImageElement).naturalWidth)
            .catch(() => -1);
          if (nw > 0) loadedOk++;
        }
        return loadedOk;
      },
      { timeout: 15000, intervals: [500, 1000] },
    )
    .toBeGreaterThan(0);

  const sawImage = bodyText.includes("yellow") && bodyText.includes("42");
  const deniedImage = DENIAL_NEEDLES.some((n) => bodyText.includes(n));

  await page.screenshot({ path: "tests/repro/image-paste-e2e.png", fullPage: true });

  console.log("=== PASTE E2E RESULT ===");
  console.log("sessionId:", sessionId);
  console.log("prompt requests:", JSON.stringify(promptRequests));
  console.log("rendered <img> loaded:", loadedOk);
  console.log("model saw image (yellow+42):", sawImage, "| denied:", deniedImage);

  // (a) The image bytes actually left the browser as an attachment.
  expect(promptRequests.some((r) => r.hasImage && r.imgBytes > 0)).toBe(true);
  // (b) The UI rendered the image locally.
  expect(loadedOk).toBeGreaterThan(0);
  // (c) The model did NOT claim it couldn't see the image...
  expect(deniedImage).toBe(false);
  // (d) ...and positively described it.
  expect(sawImage).toBe(true);
});
