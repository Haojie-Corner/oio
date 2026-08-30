import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { seedDatabase } from "./db";
import "./styles.css";

async function start() {
  window.addEventListener("error", (event) => {
    const pre = document.createElement("pre");
    pre.style.cssText = "position:fixed;inset:auto 0 0 0;z-index:9999;background:#fff;color:#c00;padding:8px;white-space:pre-wrap;font-size:12px";
    pre.textContent = `渲染错误: ${event.message}\n${event.error?.stack ?? ""}`;
    document.body.appendChild(pre);
  });
  try {
    await seedDatabase();
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (error) {
    document.body.textContent = `启动失败: ${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`;
  }
}

void start();
