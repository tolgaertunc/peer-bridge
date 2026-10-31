// Everything that differs between Windows, macOS and Linux lives here: where
// the apps keep their config, where their bundled CLIs are, and how to open a
// deep link. macOS locations were checked on a Mac (ChatGPT 26.1027, Claude
// Code 2.1.309 bundled with Claude Desktop). Each lookup has an env override
// for odd installs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const IS_WIN = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";

const home = os.homedir();
const winAppData = () => process.env.APPDATA || path.join(home, "AppData", "Roaming");
const winLocalAppData = () => process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
const macAppSupport = path.join(home, "Library", "Application Support");

// Broker state shared by both apps' servers (one per user, not per checkout)
export function dataDir() {
  if (process.env.PEER_BRIDGE_DIR) return process.env.PEER_BRIDGE_DIR;
  if (IS_WIN) return path.join(winLocalAppData(), "peer-bridge");
  if (IS_MAC) return path.join(macAppSupport, "peer-bridge");
  return path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), "peer-bridge");
}

// The user's own settings for the bridge (rules.md), apart from its state
export function configDir() {
  if (process.env.PEER_BRIDGE_CONFIG_DIR) return process.env.PEER_BRIDGE_CONFIG_DIR;
  if (IS_WIN) return path.join(winAppData(), "peer-bridge");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "peer-bridge");
}
export const rulesFile = () => path.join(configDir(), "rules.md");

export const codexHome = () => process.env.CODEX_HOME || path.join(home, ".codex");
export const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");

// Legacy: Claude Desktop's own MCP config (servers there are proxied into the
// Code tab without request _meta, so the bridge no longer registers there)
export function claudeDesktopConfig() {
  if (IS_WIN) return path.join(winAppData(), "Claude", "claude_desktop_config.json");
  if (IS_MAC) return path.join(macAppSupport, "Claude", "claude_desktop_config.json");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude", "claude_desktop_config.json");
}

const exe = (name) => (IS_WIN ? `${name}.exe` : name);

function onPath(name) {
  const exts = IS_WIN ? (process.env.PATHEXT || ".EXE;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext.toLowerCase());
      if (dir && fs.existsSync(p)) return p;
    }
  }
  return null;
}

// <root>/<version>/<hash>/<file> layouts: newest file wins
function newestIn(root, depth, file) {
  let dirs = [root];
  for (let i = 0; i < depth; i++) {
    dirs = dirs.flatMap((d) => {
      try {
        return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name));
      } catch {
        return [];
      }
    });
  }
  return (
    dirs
      .map((d) => path.join(d, file))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null
  );
}

const firstExisting = (paths) => paths.find((p) => p && fs.existsSync(p)) ?? null;

// Claude Code CLI: a standalone install, or the copy bundled with Claude
// Desktop (<version>/<hash>/claude.exe on Windows, .../claude.app on macOS)
export function findClaudeCli() {
  if (process.env.PEER_BRIDGE_CLAUDE_BIN) return process.env.PEER_BRIDGE_CLAUDE_BIN;
  const bundled = IS_WIN ? path.join(winAppData(), "Claude", "claude-code") : IS_MAC ? path.join(macAppSupport, "Claude", "claude-code") : null;
  const file = IS_MAC ? path.join("claude.app", "Contents", "MacOS", "claude") : exe("claude");
  return onPath("claude") ?? (bundled && newestIn(bundled, 2, file)) ?? process.env.CLAUDE_CODE_EXECPATH ?? null;
}

// Codex CLI bundled with ChatGPT Desktop (the app server API we drive), and
// where it came from: "override" (PEER_BRIDGE_CODEX_BIN), "app", or "path". A
// codex on PATH is a separate install whose version can differ from the app's.
export function locateCodexCli() {
  if (process.env.PEER_BRIDGE_CODEX_BIN) return { path: process.env.PEER_BRIDGE_CODEX_BIN, source: "override" };
  const app = IS_WIN
    ? newestIn(path.join(winLocalAppData(), "OpenAI", "Codex", "bin"), 1, "codex.exe")
    : IS_MAC
      ? codexInMacApps(["/Applications", path.join(home, "Applications")])
      : null;
  if (app) return { path: app, source: "app" };
  const found = onPath("codex");
  return found ? { path: found, source: "path" } : null;
}

export const findCodexCli = () => locateCodexCli()?.path ?? null;

// ChatGPT.app first: the queue we drive is ChatGPT Desktop's. Current builds
// ship the CLI in Resources/codex-cli, described by codex-package.json; older
// ones as Resources/codex.
export function codexInMacApps(dirs) {
  const resources = ["ChatGPT.app", "Codex.app"].flatMap((app) => dirs.map((d) => path.join(d, app, "Contents", "Resources")));
  return firstExisting(resources.flatMap((r) => [codexEntrypoint(path.join(r, "codex-cli")), path.join(r, "codex")]));
}

function codexEntrypoint(dir) {
  try {
    const entry = JSON.parse(fs.readFileSync(path.join(dir, "codex-package.json"), "utf8")).entrypoint;
    if (typeof entry === "string" && entry) return path.join(dir, entry);
  } catch {
    // no manifest: fall back to the layout it describes today
  }
  return path.join(dir, "bin", "codex");
}

// Hand a URL (codex://…) to the OS protocol handler
export function openUrl(url) {
  // empty title arg so `start` doesn't take the URL as the window title
  if (IS_WIN) execFileSync("cmd.exe", ["/d", "/c", "start", "", url], { stdio: "ignore" });
  else if (IS_MAC) execFileSync("open", ["-g", url], { stdio: "ignore" }); // -g: don't bring the app to the front
  else execFileSync("xdg-open", [url], { stdio: "ignore" });
}
