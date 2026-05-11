import React from "react";
import { createRoot } from "react-dom/client";
import { HttpSessionDashboardApi } from "./api/http-session-api.js";
import { SessionDashboard } from "./components/SessionDashboard.js";

const api = new HttpSessionDashboardApi();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <React.StrictMode>
    <SessionDashboard api={api} />
  </React.StrictMode>,
);
