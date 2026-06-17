/**
 * Hard cap on raw prompt text (~250 KB of ASCII). Pasted base64 screenshots
 * routinely run >100 KB and bloat the agent's context window; the cap keeps
 * egregious blobs out and the session JSONL replay-safe, while still allowing
 * large legitimate text pastes (logs, multi-file dumps).
 *
 * Images should be sent as attachments via the paperclip / paste-as-image path.
 */
export const MAX_PROMPT_CHARS = 256_000;
