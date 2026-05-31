import { expect, test } from "@playwright/test";
import {
  bootstrapSession,
  DENIAL_NEEDLES,
  testImageBase64,
} from "./fixtures/session.js";

// End-to-end verification of Claude image input through the LiteLLM-backed
// `litellm/claude-opus-4-8` model via the API ATTACHMENT path (as opposed to
// the clipboard-paste path covered by image-paste-e2e.spec.ts).
//
// This is a SELF-CONTAINED fixture: it creates its own session and seeds it
// with a prompt that carries the test image (blue bg, yellow circle, "42") as
// an attachment, then opens the session in the UI and asserts:
//   (a) the UI renders the image (served 200 with real bytes), and
//   (b) the model's correct description appears in the transcript
//       (and it does not deny seeing the image).
//
// Guards the same regression as the paste fixture from the API side: if the
// model config lacks "image" input, the image is stripped to
// "(image omitted: model does not support images)" before reaching the model.

test("image input (API attachment): UI renders image + model describes it", async ({
  page,
  request,
}) => {
  const sessionId = await bootstrapSession(request, {
    sessionName: "image-input-e2e-fixture",
    seedText:
      "Look at the attached image and tell me: background color, the center shape and its color, and any number/text.",
    attachments: [
      {
        type: "image",
        name: "test-image-input.png",
        mimeType: "image/png",
        data: testImageBase64(),
      },
    ],
  });

  const imageResponses: { url: string; status: number; bytes: number }[] = [];
  page.on("response", async (resp) => {
    if (resp.url().includes("/images/") || resp.url().includes("/artifacts/")) {
      let bytes = -1;
      try {
        bytes = (await resp.body()).length;
      } catch {
        /* ignore */
      }
      imageResponses.push({ url: resp.url(), status: resp.status(), bytes });
    }
  });

  await page.goto(`/?session=${sessionId}`, { waitUntil: "networkidle" });

  // Find any rendered <img> whose src points at the session image endpoint.
  const imgs = page.locator(
    'img[src*="/images/"], img[src*="/messages/"], img.artifact-image',
  );
  await expect.poll(async () => imgs.count(), { timeout: 20000 }).toBeGreaterThan(0);

  const count = await imgs.count();
  let loadedOk = 0;
  for (let i = 0; i < count; i++) {
    const nw = await imgs
      .nth(i)
      .evaluate((el) => (el as HTMLImageElement).naturalWidth)
      .catch(() => -1);
    const src = await imgs.nth(i).getAttribute("src");
    console.log(`img[${i}] naturalWidth=${nw} src=${src}`);
    if (nw > 0) loadedOk++;
  }

  const bodyText = (await page.locator("body").innerText()).toLowerCase();
  const sawDescription =
    bodyText.includes("yellow") && bodyText.includes("42");
  const deniedImage = DENIAL_NEEDLES.some((n) => bodyText.includes(n));

  await page.screenshot({ path: "tests/repro/image-input-e2e.png", fullPage: true });

  console.log("=== IMAGE INPUT E2E RESULT ===");
  console.log("sessionId:", sessionId);
  console.log("image responses:", JSON.stringify(imageResponses));
  console.log("model described (yellow+42):", sawDescription, "| denied:", deniedImage);

  // (a) at least one session image loaded with real bytes, served 200
  expect(loadedOk).toBeGreaterThan(0);
  expect(imageResponses.some((r) => r.status === 200 && r.bytes > 0)).toBe(true);
  // (b) the model described it and did not deny seeing it
  expect(deniedImage).toBe(false);
  expect(sawDescription).toBe(true);
});
