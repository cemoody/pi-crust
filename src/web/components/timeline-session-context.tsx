/**
 * Tiny React context that carries the current session id down the timeline
 * subtree. Extracted into its own file so subcomponents (notably
 * PresentationArtifactCard) can consume it without depending on the
 * MessageTimeline module — which would create a cycle when those
 * subcomponents are imported back by MessageTimeline.
 */
import { createContext } from "react";

export const TimelineSessionContext = createContext<string | undefined>(undefined);
