import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const companionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const aisbRoot = isAbsolute(process.env.AISB_REPO_PATH ?? "")
  ? process.env.AISB_REPO_PATH
  : resolve(companionRoot, process.env.AISB_REPO_PATH ?? "../aisb");
const stateRoot = await mkdtemp(join(tmpdir(), "aisb-companion-production-smoke-"));

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a local smoke-test port");
  }
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

async function waitForResponse(url, validate, child, deadline) {
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("The packaged server exited before it became ready");
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && (await validate(response))) return;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function waitForShutdown(url, deadline) {
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("The packaged server did not stop within five seconds");
}

function signalProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

const port = await availablePort();
const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) throw new Error("npm_execpath is unavailable; run this smoke through npm");

let stdout = "";
let stderr = "";
let spawnError;
const child = spawn(process.execPath, [npmExecPath, "start", "--silent"], {
  cwd: companionRoot,
  detached: process.platform !== "win32",
  env: {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    AISB_REPO_PATH: aisbRoot,
    AISB_COMPANION_STATE_PATH: stateRoot,
    AISB_COMPANION_ALLOW_TEMPORARY_STATE: "true",
    PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout = (stdout + chunk).slice(-16_384);
});
child.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-16_384);
});
child.once("error", (error) => {
  spawnError = error;
});

try {
  const deadline = Date.now() + 15_000;
  if (spawnError) throw spawnError;
  await waitForResponse(
    `http://127.0.0.1:${port}/api/health`,
    async (response) => (await response.json()).status === "ok",
    child,
    deadline,
  );
  await waitForResponse(
    `http://127.0.0.1:${port}/`,
    async (response) => (await response.text()).includes('<div id="root"></div>'),
    child,
    deadline,
  );
  process.stdout.write("Packaged production server and static shell are reachable.\n");
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(`${detail}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
} finally {
  try {
    signalProcessGroup(child, "SIGTERM");
    await waitForShutdown(`http://127.0.0.1:${port}/api/health`, Date.now() + 5_000);
  } finally {
    signalProcessGroup(child, "SIGKILL");
    await rm(stateRoot, { recursive: true, force: true });
  }
}
