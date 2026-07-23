import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "dist");
const requiredFiles = [
  "index.html",
  "styles.css",
  "config.js",
  "models.js",
  "mock-api.js",
  "api.js",
  "garden-service.js",
  "focus-timer.js",
  "admin-workspace.js",
  "exercise-guide.js",
  "markdown-renderer.js",
  "app.js",
];

for (const relativePath of requiredFiles) {
  if (!existsSync(join(root, relativePath))) {
    throw new Error(`缺少 Web 发布文件：${relativePath}`);
  }
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && [".html", ".css", ".js"].includes(extname(entry.name))) {
    cpSync(join(root, entry.name), join(output, entry.name));
  }
}

if (existsSync(join(root, "exercise"))) {
  cpSync(join(root, "exercise"), join(output, "exercise"), { recursive: true });
}

console.log(`SpineGuard Web build complete: ${output}`);
