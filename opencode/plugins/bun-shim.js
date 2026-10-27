import { spawn as nodeSpawn } from "node:child_process";
import { Readable } from "node:stream";
import { writeFile } from "node:fs/promises";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), ".opencode-pets");
const LOG_FILE = join(LOG_DIR, "shim.log");

function note(message) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, "utf-8");
  } catch {
    /* logging must never break plugin loading */
  }
}

function toWebStderr(stderr) {
  if (!stderr) return undefined;
  try {
    return Readable.toWeb(stderr);
  } catch {
    return undefined;
  }
}

function bunSpawn(cmd, opts = {}) {
  const argv = Array.isArray(cmd) ? cmd : [cmd];
  const file = argv[0];
  const args = argv.slice(1);

  const stderrMode =
    opts.stderr === "pipe" ? "pipe" : opts.stderr === "ignore" ? "ignore" : "inherit";
  const stdoutMode = opts.stdout === "pipe" ? "pipe" : "ignore";

  const child = nodeSpawn(file, args, {
    cwd: opts.cwd,
    stdio: ["ignore", stdoutMode, stderrMode],
    windowsHide: true,
  });

  child.exited = new Promise((resolve) => {
    child.once("error", (err) => {
      note(`spawn error: ${file} -> ${err.message}`);
      resolve(-1);
    });
    child.once("exit", (code, signal) => {
      resolve(code === null ? (signal ? 128 : 0) : code);
    });
  });

  if (stderrMode === "pipe") {
    const web = toWebStderr(child.stderr);
    if (web) child.stderr = web;
  }

  return child;
}

function bunSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bunWrite(path, data) {
  const buffer = data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(String(data));
  await writeFile(path, buffer);
  return buffer.length;
}

function bunConnect() {
  throw new Error("Bun shim: Bun.connect is not implemented (only needed on Unix)");
}

if (typeof globalThis.Bun === "undefined") {
  Object.defineProperty(globalThis, "Bun", {
    value: { spawn: bunSpawn, sleep: bunSleep, write: bunWrite, connect: bunConnect },
    writable: true,
    configurable: true,
    enumerable: false,
  });
  note("Bun shim installed (Node runtime detected)");
} else {
  note("Bun already present — shim skipped");
}

export const BunShimPlugin = async () => {
  note("plugin factory invoked");
  return {};
};
