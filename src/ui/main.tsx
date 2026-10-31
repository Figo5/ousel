/**
 * Client entry point. Mounts the React app and imports the single stylesheet.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./theme.css";

const container = document.getElementById("root");
if (!container)
  throw new Error("Ousel UI: #root container is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
