/**
 * Which projects' .vigent.toml may run commands.
 *
 * A project config can set the theme, templates, keys and worktree layout
 * freely. The parts that run programs (hooks, engine arguments, custom
 * engine commands, shell commands under [commands], Claude Code
 * permission rules) only count once you trust that file, like direnv's
 * `allow`: `:trust` in vigent, or `vigent trust` in the project. Trust is
 * for the file as it is now; if it changes, vigent asks again.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { App } from "./app.js";
import { type Config, loadConfig, PROJECT_CONFIG } from "./config.js";
import { type EngineId, quickEngines } from "./engines.js";
import { parse as parseToml } from "smol-toml";

function stateFile(): string {
	const xdg = process.env.XDG_STATE_HOME;
	return path.join(xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local", "state"), "vigent", "trusted.json");
}

const digest = (content: string) => createHash("sha256").update(content).digest("hex");

function read(): Record<string, string> {
	try {
		const v = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
		return v && typeof v === "object" ? v : {};
	} catch {
		return {};
	}
}

/** Whether this file, with exactly this content, is trusted. */
export function isTrusted(file: string, content: string): boolean {
	return read()[path.resolve(file)] === digest(content);
}

/** Trust this file as it is now. */
export function trustFile(file: string, content: string): void {
	const all = read();
	all[path.resolve(file)] = digest(content);
	const f = stateFile();
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, `${JSON.stringify(all, null, 2)}\n`);
}

export interface TrustSyncContext {
	app: App;
	config: Config;
	projectFile?: string;
	reloadPermissions?: () => void;
}

/**
 * Execute trust approval for a project's .vigent.toml:
 * 1. Validates that the file exists and is readable/valid.
 * 2. Persists trust via trustFile().
 * 3. Reloads and merges trusted configuration into config.
 * 4. Synchronizes all runtime components: hooks, layout, styles, commands,
 *    engineOptions, permissions, new-agent model/effort defaults, and engine discovery.
 */
export function executeProjectTrust(ctx: TrustSyncContext): string {
	const { app, config, projectFile, reloadPermissions } = ctx;
	if (!projectFile || !fs.existsSync(projectFile)) {
		return `no ${PROJECT_CONFIG} in this project`;
	}

	let content: string;
	try {
		content = fs.readFileSync(projectFile, "utf8");
	} catch (err) {
		return `can't read ${PROJECT_CONFIG}: ${(err as Error).message}`;
	}

	// Only a file that doesn't parse is refused. Other warnings, like an unknown key, start with
	// the same `.vigent.toml:` prefix but never stopped a file from being trusted.
	try {
		parseToml(content);
	} catch (err) {
		return `can't trust ${PROJECT_CONFIG}: ${(err as Error).message.split("\n")[0]}`;
	}
	const { gated } = loadConfig(projectFile, { trusted: false, label: PROJECT_CONFIG });

	trustFile(projectFile, content);
	loadConfig(projectFile, { base: config, trusted: true, label: PROJECT_CONFIG });

	app.hooks = config.hooks;
	app.layout = config.layout;
	app.styleConfig = config.style;
	app.commands = config.commands;
	app.engineOptions = config.engines;

	if (reloadPermissions) {
		reloadPermissions();
	}

	// Apply model and effort defaults for engines that don't have an explicit user selection
	for (const [id, opts] of Object.entries(config.engines)) {
		if (opts?.model && !app.newAgentModel[id as EngineId]) {
			app.newAgentModel[id as EngineId] = opts.model;
		}
		if (opts?.effort && !app.newAgentEffort[id as EngineId]) {
			app.newAgentEffort[id as EngineId] = opts.effort;
		}
	}

	// Refresh available engines so newly trusted custom engines appear immediately
	app.setEngines(quickEngines());
	app.detectEngines?.()
		.then((engines) => app.setEngines(engines))
		.catch(() => {});

	return `trusted ${PROJECT_CONFIG}${gated.length ? `: ${gated.join(", ")} now run` : ""}`;
}
