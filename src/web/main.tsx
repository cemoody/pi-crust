// Import side-effect modules FIRST so they install their listeners before
// any other module attempts an HMR-driving import. In particular, hmr-tame
// must register its `vite:beforeFullReload` handler before the first HMR
// event can fire — otherwise the inaugural Vite-server-restart reload races
// the listener registration and slips past our suppression.
import "./utils/hmr-tame.js";
import React from "react";
import { createRoot } from "react-dom/client";
import "./design-system.css";
import { HttpSessionDashboardApi } from "./api/http-session-api.js";
import { SessionDashboard } from "./components/SessionDashboard.js";
import { installClientTelemetry } from "./utils/client-telemetry.js";

installClientTelemetry();
const api = new HttpSessionDashboardApi();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <React.StrictMode>
    <SessionDashboard api={api} />
  </React.StrictMode>,
);
