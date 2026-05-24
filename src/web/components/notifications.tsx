/**
 * Unified notification system for pi-crust.
 *
 * Why this exists
 * ---------------
 * Before this module the UI had ~10 different ways to surface transient
 * messages: `dashboard-notice`, sidebar `<p role="alert">`, per-session
 * `prompt-error-banner`, two parallel cron banners, the composer's paste
 * warning, the tool/turn "copied" pill, ExtensionUiHost inline notify
 * blocks, and more. They had inconsistent styles, dismiss affordances,
 * auto-dismiss behavior, and accessibility roles.
 *
 * This module centralizes all *floating* informational notifications into
 * a single toast region. Every kind auto-dismisses by default, including
 * errors — pi-crust's design choice is a uniform toast UX with a longer
 * timeout for errors so users still have time to read them. Callers that
 * need a sticky toast can opt in via `persistent: true` or
 * `durationMs: Infinity`.
 *
 * Inline field-level alerts (e.g. form validation, fork-dialog errors)
 * are intentionally NOT moved here — they belong next to the failing
 * control. A future PR can introduce an `<InlineAlert>` primitive to
 * standardize their markup too.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./notifications.css";

export type NotificationKind = "info" | "success" | "warning" | "error";

export interface NotificationInput {
  readonly kind?: NotificationKind;
  readonly message: string;
  /**
   * Stable identifier. When provided, a later notify() with the same id
   * replaces the existing notification in place. Useful for things like
   * extension-protocol notify requests whose id is the request id.
   */
  readonly id?: string;
  /** Override auto-dismiss timeout (ms). Use Infinity / `persistent: true` for manual. */
  readonly durationMs?: number;
  /** If true, do not auto-dismiss. */
  readonly persistent?: boolean;
}

export interface NotificationRecord {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly message: string;
  readonly durationMs: number;
  readonly createdAt: number;
}

interface NotificationsContextValue {
  readonly notifications: readonly NotificationRecord[];
  readonly notify: (input: NotificationInput) => string;
  readonly dismiss: (id: string) => void;
  readonly clear: () => void;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

/** Default auto-dismiss in ms by kind. Errors stay longer than the rest
 *  so users have time to read them, but they still auto-dismiss for a
 *  consistent toast experience. Pass `persistent: true` to opt out. */
const DEFAULT_DURATION_MS: Record<NotificationKind, number> = {
  info: 4_000,
  success: 4_000,
  warning: 6_000,
  error: 8_000,
};

let notificationCounter = 0;
function nextId(): string {
  notificationCounter += 1;
  return `notif-${notificationCounter}-${Date.now()}`;
}

/**
 * Wrap your app in this provider. Renders a single floating toast region
 * at the bottom-right of the viewport.
 */
export function NotificationsProvider({ children }: { readonly children: ReactNode }) {
  const [notifications, setNotifications] = useState<readonly NotificationRecord[]>([]);

  // Track which ids are currently hovered so we can pause their dismiss timers.
  const hoveredIds = useRef<Set<string>>(new Set());

  const dismiss = useCallback((id: string) => {
    setNotifications((current) => current.filter((n) => n.id !== id));
  }, []);

  const clear = useCallback(() => setNotifications([]), []);

  const notify = useCallback((input: NotificationInput): string => {
    const kind = input.kind ?? "info";
    const id = input.id ?? nextId();
    const durationMs = input.persistent
      ? Number.POSITIVE_INFINITY
      : (input.durationMs ?? DEFAULT_DURATION_MS[kind]);
    const record: NotificationRecord = { id, kind, message: input.message, durationMs, createdAt: Date.now() };
    setNotifications((current) => {
      const existing = current.findIndex((n) => n.id === id);
      if (existing >= 0) {
        const next = current.slice();
        next[existing] = record;
        return next;
      }
      return [...current, record];
    });
    return id;
  }, []);

  // Auto-dismiss timers. We re-create timers whenever the notifications array
  // changes so that replaced (same-id) toasts reset their countdown.
  useEffect(() => {
    const timers: number[] = [];
    for (const n of notifications) {
      if (!Number.isFinite(n.durationMs)) continue;
      if (hoveredIds.current.has(n.id)) continue;
      const t = window.setTimeout(() => dismiss(n.id), n.durationMs);
      timers.push(t);
    }
    return () => { for (const t of timers) window.clearTimeout(t); };
  }, [notifications, dismiss]);

  const value = useMemo<NotificationsContextValue>(() => ({ notifications, notify, dismiss, clear }), [notifications, notify, dismiss, clear]);

  return (
    <NotificationsContext.Provider value={value}>
      {children}
      <NotificationsRegion
        notifications={notifications}
        onDismiss={dismiss}
        onHoverStart={(id) => { hoveredIds.current.add(id); }}
        onHoverEnd={(id) => { hoveredIds.current.delete(id); }}
      />
    </NotificationsContext.Provider>
  );
}

/**
 * Returns the live notify/dismiss API. Throws if used outside a provider —
 * call sites should always be inside `<NotificationsProvider>` (mounted by
 * SessionDashboard).
 */
export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications() must be used within <NotificationsProvider>");
  return ctx;
}

/**
 * Optional variant that returns a no-op API if no provider is mounted. Useful
 * for components that may be rendered standalone (e.g. in unit tests) and
 * should not crash when toasts have nowhere to land.
 */
export function useOptionalNotifications(): NotificationsContextValue | null {
  return useContext(NotificationsContext);
}

interface RegionProps {
  readonly notifications: readonly NotificationRecord[];
  readonly onDismiss: (id: string) => void;
  readonly onHoverStart: (id: string) => void;
  readonly onHoverEnd: (id: string) => void;
}

function NotificationsRegion({ notifications, onDismiss, onHoverStart, onHoverEnd }: RegionProps) {
  if (notifications.length === 0) return null;
  return (
    <div className="notifications-region" aria-label="Notifications" aria-live="polite">
      {notifications.map((n) => (
        <div
          key={n.id}
          className={`notification notification-${n.kind}`}
          role={n.kind === "error" ? "alert" : "status"}
          onMouseEnter={() => onHoverStart(n.id)}
          onMouseLeave={() => onHoverEnd(n.id)}
        >
          <span className="notification-message">{n.message}</span>
          <button
            type="button"
            className="notification-dismiss"
            onClick={() => onDismiss(n.id)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
