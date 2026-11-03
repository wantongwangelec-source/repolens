import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { desktop } from "./lib/desktop";
import "./index.css";

if (desktop) document.documentElement.dataset["desktop"] = desktop.platform;

const container = document.getElementById("root");
if (!container) throw new Error("找不到 #root 挂载点");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
