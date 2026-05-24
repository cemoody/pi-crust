/**
 * Side-effect-only entrypoint: install the PI_REMOTE_* -> PI_CRUST_* compat
 * shim against process.env on import. Imported at the top of every
 * entrypoint that reads env vars (HTTP API server, CLI launchers, etc.).
 *
 * Kept separate from env-compat.ts so tests can import installEnvCompat()
 * without firing it against the real process.env on import.
 */
import { installEnvCompat } from "./env-compat.js";

installEnvCompat();
