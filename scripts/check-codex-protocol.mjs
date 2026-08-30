import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const companionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedRoot = join(companionRoot, "src", "server", "codex", "generated");
const codexExecutable = join(companionRoot, "node_modules", ".bin", "codex");
const expectedVersion = "0.151.0";

async function filesBelow(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(root, path));
    }
  }
  await visit(root);
  return files.sort();
}

async function main() {
  const packageJson = JSON.parse(await readFile(join(companionRoot, "package.json"), "utf8"));
  if (packageJson.dependencies?.["@openai/codex"] !== expectedVersion) {
    throw new Error(`@openai/codex must remain exactly pinned to ${expectedVersion}`);
  }

  const { stdout } = await execFileAsync(codexExecutable, ["--version"], {
    cwd: companionRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  if (stdout.trim() !== `codex-cli ${expectedVersion}`) {
    throw new Error(`Expected codex-cli ${expectedVersion}; received ${stdout.trim() || "no version"}`);
  }

  const scratchRoot = await mkdtemp(join(tmpdir(), "aisb-codex-protocol-"));
  const regeneratedRoot = join(scratchRoot, "generated");
  try {
    await execFileAsync(
      codexExecutable,
      ["app-server", "generate-ts", "--experimental", "--out", regeneratedRoot],
      { cwd: companionRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    await execFileAsync(
      codexExecutable,
      [
        "app-server",
        "generate-json-schema",
        "--experimental",
        "--out",
        join(regeneratedRoot, "schema"),
      ],
      { cwd: companionRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );

    const [tracked, regenerated] = await Promise.all([
      filesBelow(generatedRoot),
      filesBelow(regeneratedRoot),
    ]);
    const trackedSet = new Set(tracked);
    const regeneratedSet = new Set(regenerated);
    const missing = regenerated.filter((path) => !trackedSet.has(path));
    const extra = tracked.filter((path) => !regeneratedSet.has(path));
    const changed = [];
    for (const path of regenerated.filter((candidate) => trackedSet.has(candidate))) {
      const [expected, actual] = await Promise.all([
        readFile(join(regeneratedRoot, path)),
        readFile(join(generatedRoot, path)),
      ]);
      if (!expected.equals(actual)) changed.push(path);
    }
    if (missing.length > 0 || extra.length > 0 || changed.length > 0) {
      const lines = ["Pinned Codex App Server bindings have drifted. Regenerate and review them."];
      if (missing.length > 0) lines.push(`Missing: ${missing.join(", ")}`);
      if (extra.length > 0) lines.push(`Extra: ${extra.join(", ")}`);
      if (changed.length > 0) lines.push(`Changed: ${changed.join(", ")}`);
      throw new Error(lines.join("\n"));
    }
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
