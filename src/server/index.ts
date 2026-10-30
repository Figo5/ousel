import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createApp } from "./app.js";
import { resolveConfig } from "./config.js";
import { acquireLock } from "./security.js";

process.umask(0o077);
const config = resolveConfig({
  env: process.env,
  home: os.homedir(),
  exists: existsSync,
});
const { dataDir, port } = config;
if (config.notice) console.log(config.notice);
const unlock = acquireLock(dataDir);
const app = createApp({ dbPath: config.dbPath, port });
try {
  await app.listen();
  console.log(
    `Ousel http://127.0.0.1:${port}\nLocal data: ${dataDir} (${path.basename(config.dbPath)})`,
  );
} catch (error) {
  unlock();
  throw error;
}
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  try {
    await app.close();
  } finally {
    unlock();
    process.exit(0);
  }
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
