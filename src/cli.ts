#!/usr/bin/env node
/** vigent — a vim-native screen for the coding agents you have installed. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ProcessTerminal, TUI } from "./tui.js";
import { type AgentMeta, loadAgentMeta, reopenableAgents, saveAgentMeta, sessionDir } from "./agents.js";
import { PI_BIN } from "./pi-cli.js";
import { App } from "./app.js";
import { FOCUS_REPORTING_OFF, FOCUS_REPORTING_ON } from "./notify.js";
import { staleBuild, VERSION_TEXT } from "./version.js";
import { CliSession } from "./cli-engines.js";
import { CUSTOM_ENGINES, defaultEngine, detectEngines, ENGINE_BINS, ENGINE_NAMES, type EngineId, isEngineId, onPath, piConnected, quickEngines, engineEnv } from "./engines.js";
import { CONFIG_TEMPLATE, configPath, loadConfig, PROJECT_CONFIG } from "./config.js";
import { executeProjectTrust, isTrusted, trustFile } from "./trust.js";
import { setTomlValue } from "./config-edit.js";
import { createDemoSessions } from "./demo.js";
import { buildKeymap, KEY_MODES } from "./keys.js";
import { backendName, formatBytes, prepareViews, riftriBackends, riftriGc, riftriHealth, riftriStateDir } from "./riftri.js";
import { PiSession } from "./pi-session.js";
import { DemoSession, type Session } from "./session.js";
import { followedColorscheme, followTheme, isFollow, refreshFollow } from "./follow.js";
import { BUILTIN_THEMES, listThemes, loadTheme, Painter, themesDir } from "./theme.js";
import { themeNewTemplate } from "./theme-new.js";
import {
	branchName,
	addWorktree,
	planWorktree,
	findWorktree,
	listWorktrees,
	removeWorktree,
	repoRoot,
	type WorktreeInfo,
	worktreesDir,
} from "./worktree.js";

const HELP = `vigent — a vim-native orchestrator for coding-agent harnesses (the agent CLIs you have installed)

usage:
  vigent --version                           which vigent this is (and the commit, from a clone)
  vigent [folder] [--demo] [--theme <name>] [--model <id>] [--engine <id>]
  vigent --serve [--local]                   also follow your agents from your phone (:serve)

engines (what runs new agents; :checkhealth shows which are signed in):
  claude    your installed Claude Code CLI, with its own login
  codex     your installed Codex CLI, with its own login
  opencode  your installed OpenCode CLI, with its own login
  gemini    your installed Gemini CLI, with its own login
  cursor    your installed Cursor CLI (cursor-agent), with its own login
  pi        your installed pi (pi --mode rpc), with its keys or login
  <id>      any agent CLI from [engines.<id>] in config.toml

themes:
  vigent theme list                          built-in and installed themes
  vigent theme import                        import the colorscheme your nvim/vim uses now
  vigent theme import <name> [--as <name>]   import any colorscheme nvim/vim can load
  vigent theme import ./theme.vim            import a colorscheme file (no editor needed)
      --vim | --nvim      use this editor     --light | --dark   set 'background' first
      --clean             skip your editor config
  vigent theme new <name> [--from <theme>]   create a theme file to customize, pre-filled with that theme's colors
      --palette           build it from a palette only     --transparent   use the terminal's background
  vigent theme path                          show where themes and config live
  vigent worktree list                       agent worktrees in this repo
  vigent worktree remove <branch> [--force]  delete one (safe unless --force)
  vigent worktree prune                      forget worktrees whose folder is gone
  vigent worktree gc                         free riftri storage no worktree uses
  vigent config init                         write a commented config.toml
  vigent config check                        validate config.toml (theme, options, keys)

keys (NORMAL mode):
  i            prompt the focused agent        :new <task>     agent in its own worktree
  j/k gg G     scroll transcript               :kill[!]        stop it (! removes worktree)
  ctrl+d/u     half-page scroll                :colorscheme    pick a theme (live preview)
  ]s [s gt     switch sessions                 :hi Group ...   change a highlight group
  za zM zR     fold/unfold tool output         :set nonumber   toggle ui options
  /pattern ?   search transcript               :diff           what the agent changed
  V y  yy yib  select and copy, last reply     :merge  :pr     land the agent's work
  {  }         previous / next message         :dash           all agents at a glance
  dd           kill agent (asks first)         :queue <text>   follow-up after this run
  :worktrees   list agent worktrees            :attach <branch> reopen a kept agent
  :diff split  side-by-side diff               :tree           go back to any point and branch
  <Space>u     the conversation tree           :nmap <lhs> <rhs> map keys (see :help)
  :help        every key, including yours      :q              quit
  :checkhealth engines: installed? signed in?  :new <task> --engine codex

Runs in demo mode (scripted sessions, no network) when --demo is passed,
or when pi has no API key and none of claude / codex / opencode is installed.
Config: ~/.config/vigent/config.toml   Themes: ~/.config/vigent/themes/
`;

function flag(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

async function themeCommand(argv: string[]): Promise<number> {
	const sub = argv[0];
	if (sub === "list") {
		const builtins = new Set(Object.keys(BUILTIN_THEMES));
		for (const t of listThemes()) console.log(builtins.has(t) ? `${t}  (built-in)` : t);
		return 0;
	}
	if (sub === "path") {
		console.log(`themes: ${themesDir()}`);
		console.log(`config: ${configPath()}`);
		return 0;
	}
	if (sub === "new") {
		const name = argv[1];
		if (!name || name.startsWith("-")) {
			console.error("usage: vigent theme new <name> [--from <theme>] [--palette] [--transparent | --no-transparent]");
			return 1;
		}
		const from = flag(argv, "--from") ?? "default";
		loadTheme(from); // fail early on a typo
		const file = path.join(themesDir(), `${name}.toml`);
		if (fs.existsSync(file)) {
			console.error(`${file} already exists`);
			return 1;
		}
		fs.mkdirSync(themesDir(), { recursive: true });
		fs.writeFileSync(
			file,
			themeNewTemplate(name, from, {
				palette: argv.includes("--palette"),
				transparent: argv.includes("--transparent") ? true : argv.includes("--no-transparent") ? false : undefined,
			}),
		);
		console.log(`created ${file}`);
		console.log(`use it with: vigent --theme ${name}  (or :colorscheme ${name})`);
		return 0;
	}
	if (sub === "import") {
		const { importTheme } = await import("./import.js");
		const rest = argv.slice(1);
		const positional = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--as" && a !== "as");
		const legacyAs = rest.indexOf("as");
		const result = importTheme({
			source: positional[0],
			as: flag(rest, "--as") ?? (legacyAs >= 0 ? rest[legacyAs + 1] : undefined),
			editor: rest.includes("--vim") ? "vim" : rest.includes("--nvim") ? "nvim" : undefined,
			background: rest.includes("--light") ? "light" : rest.includes("--dark") ? "dark" : undefined,
			clean: rest.includes("--clean"),
		});
		console.log(`imported '${result.name}' (${result.groups} highlight groups, via ${result.via})`);
		console.log(`  -> ${result.file}`);
		console.log(`use it with: vigent --theme ${result.name}  (or :colorscheme ${result.name})`);
		return 0;
	}
	console.error("usage: vigent theme list | import [name|file] | new <name> | path");
	return 1;
}

function worktreeCommand(argv: string[]): number {
	const root = repoRoot(process.cwd());
	if (!root) {
		console.error("vigent: not inside a git repository");
		return 1;
	}
	const { config } = loadConfig();
	const sub = argv[0];
	if (sub === "list" || sub === undefined) {
		const all = listWorktrees(root, config.worktree);
		if (all.length === 0) console.log(`no agent worktrees (they go in ${worktreesDir(root, config.worktree)})`);
		const backends = riftriBackends(root, all.map((w) => w.path));
		for (const w of all) {
			const b = backends.get(w.path);
			console.log(`${(w.branch ?? `(detached ${w.head})`).padEnd(36)} ${(b ? backendName(b) : "full copy").padEnd(16)} ${w.path}`);
		}
		return 0;
	}
	if (sub === "remove" || sub === "rm") {
		const query = argv[1];
		if (!query) {
			console.error("usage: vigent worktree remove <branch> [--force]");
			return 1;
		}
		const w = findWorktree(root, query, config.worktree);
		if (!w) {
			console.error(`vigent: no agent worktree '${query}' (see: vigent worktree list)`);
			return 1;
		}
		const r = removeWorktree(root, w, argv.includes("--force"));
		console.log(r.message);
		return r.removed ? 0 : 1;
	}
	if (sub === "prune") {
		execFileSync("git", ["worktree", "prune", "-v"], { cwd: root, stdio: "inherit" });
		return 0;
	}
	if (sub === "gc") {
		if (!riftriStateDir(root)) {
			console.log("no shared worktree storage in this repository");
			return 0;
		}
		const r = riftriGc(root);
		if (!r.ok) {
			console.error(`vigent: freeing worktree storage failed: ${r.message}`);
			return 1;
		}
		console.log(`freed ${formatBytes(r.report?.removed_allocated_bytes ?? 0)}`);
		return 0;
	}
	console.error("usage: vigent worktree list | remove <branch> [--force] | prune | gc");
	return 1;
}

async function main(): Promise<number | undefined> {
	const argv = process.argv.slice(2);

	if (argv.includes("--version") || argv.includes("-v") || argv[0] === "version") {
		console.log(`vigent ${VERSION_TEXT}`);
		const stale = staleBuild();
		if (stale) console.log(`warning: ${stale}`);
		return 0;
	}
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(HELP);
		return 0;
	}
	if (argv[0] === "theme" || argv[0] === "themes") return themeCommand(argv.slice(1));
	if (argv[0] === "worktree" || argv[0] === "worktrees" || argv[0] === "wt") return worktreeCommand(argv.slice(1));
	if (argv[0] === "config" && argv[1] === "check") {
		const file = configPath();
		if (!fs.existsSync(file)) {
			console.log(`no config at ${file} (defaults in use). Create one with: vigent config init`);
			return 0;
		}
		const { config, warnings } = loadConfig(file);
		const keys = buildKeymap(config.leader, config.keys);
		warnings.push(...keys.warnings);
		try {
			if (isFollow(config.theme)) followTheme(config.theme);
			else if (config.theme) loadTheme(config.theme);
		} catch (err) {
			warnings.push((err as Error).message);
		}
		const mappings = KEY_MODES.reduce((n, m) => n + keys.keymap.bindings(m).filter((b) => b.user).length, 0);
		for (const w of warnings) console.log(`warning: ${w}`);
		console.log(
			`${file}: ${warnings.length === 0 ? "ok" : `${warnings.length} problem(s)`} · theme ${config.theme ?? "default"} · leader ${config.leader ?? "\\"} · ${mappings} mapping(s) · ${Object.keys(config.highlights).length} highlight override(s)`,
		);
		return warnings.length === 0 ? 0 : 1;
	}
	if (argv[0] === "trust") {
		const root = repoRoot(process.cwd());
		const file = root ? path.join(root, PROJECT_CONFIG) : undefined;
		if (!file || !fs.existsSync(file)) {
			console.error(`vigent: no ${PROJECT_CONFIG} here${root ? ` (looked in ${root})` : " (not in a git repository)"}`);
			return 1;
		}
		const content = fs.readFileSync(file, "utf8");
		const { gated } = loadConfig(file, { trusted: false, label: PROJECT_CONFIG });
		trustFile(file, content);
		console.log(`trusted ${file}${gated.length ? `: ${gated.join(", ")} will run` : ""}`);
		return 0;
	}
	if (argv[0] === "config" && argv[1] === "init") {
		const file = configPath();
		if (fs.existsSync(file)) {
			console.error(`${file} already exists`);
			return 1;
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, CONFIG_TEMPLATE);
		console.log(`created ${file}`);
		return 0;
	}

	// `vigent <folder>` (like `code .` or `nvim .`) opens that folder; with none, the current one.
	const VALUE_FLAGS = ["--theme", "--model", "--engine"];
	const folder = argv.find((a, i) => !a.startsWith("-") && !VALUE_FLAGS.includes(argv[i - 1]));
	if (folder !== undefined) {
		const dir = path.resolve(folder);
		if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
			console.error(`vigent: '${folder}' is not a folder (usage: vigent [folder])`);
			return 1;
		}
		process.chdir(dir);
	}

	const { config, warnings } = loadConfig();
	// the project's own .vigent.toml, over yours; what runs programs waits for :trust
	const root = repoRoot(process.cwd());
	const projectFile = root ? path.join(root, PROJECT_CONFIG) : undefined;
	if (projectFile && fs.existsSync(projectFile)) {
		const content = fs.readFileSync(projectFile, "utf8");
		const project = loadConfig(projectFile, { base: config, trusted: isTrusted(projectFile, content), label: PROJECT_CONFIG });
		warnings.push(...project.warnings);
		if (project.gated.length) warnings.push(`${PROJECT_CONFIG} wants to run commands (${project.gated.join(", ")}): :trust allows them`);
	}
	const stale = staleBuild();
	if (stale) warnings.push(stale);
	const { keymap, warnings: keyWarnings } = buildKeymap(config.leader, config.keys);
	warnings.push(...keyWarnings);

	const engineArg = flag(argv, "--engine");
	if (engineArg && !isEngineId(engineArg)) {
		console.error(`vigent: unknown engine '${engineArg}' (pi, claude, codex or opencode)`);
		return 1;
	}
	const chosenEngine = (engineArg ?? (config.engine === "auto" ? undefined : config.engine)) as EngineId | undefined;
	const anyCli = (["claude", "codex", "opencode"] as const).some((id) => onPath(ENGINE_BINS[id])) || [...CUSTOM_ENGINES.values()].some((e) => onPath(e.command[0]));
	const demo = argv.includes("--demo") || (!chosenEngine && !piConnected() && !anyCli);
	const modelArg = flag(argv, "--model");
	const model = modelArg ?? config.model ?? "claude-sonnet-4-5";

	const themeName = flag(argv, "--theme") ?? config.theme ?? "default";
	let theme = BUILTIN_THEMES.default;
	try {
		// theme = "nvim" / "vim": your editor's colorscheme (kept up to date below)
		theme = isFollow(themeName) ? followTheme(themeName) : loadTheme(themeName);
	} catch (err) {
		if (flag(argv, "--theme")) {
			console.error(`vigent: ${(err as Error).message}`);
			return 1;
		}
		warnings.push(`${(err as Error).message} (from config); using default`);
	}

	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal, false);
	const app = new App(tui, terminal, new Painter(theme, config.highlights), config.ui, keymap, {
		root,
		config: config.worktree,
	});
	// can agent worktrees be copy-on-write here? (riftri; runs in the background)
	app.checkStorage = () => riftriHealth(root, root ? worktreesDir(root, config.worktree) : undefined, config.worktree.backend);
	if (!demo && root && config.worktree.enabled) {
		app
			.checkStorage()
			.then((h) => {
				app.storage = h;
			})
			.catch(() => {});
	}
	app.preferredEngine = chosenEngine ?? "auto";
	app.defaultEngine = () => (app.preferredEngine === "auto" ? defaultEngine(app.engines) : app.preferredEngine);
	app.detectEngines = () => detectEngines();
	// installed? signed in? What's on PATH shows at once; the CLIs' sign-in checks take a moment
	app.setEngines(quickEngines());
	detectEngines()
		.then((engines) => app.setEngines(engines))
		.catch(() => {});

	/**
	 * Permissions as they're saved now, read the way startup reads them. Another vigent may have
	 * changed them since this one started, and saving this one's old copy would undo that.
	 */
	const savedPermissions = () => {
		const saved = loadConfig().config;
		if (projectFile && fs.existsSync(projectFile)) {
			const content = fs.readFileSync(projectFile, "utf8");
			loadConfig(projectFile, { base: saved, trusted: isTrusted(projectFile, content), label: PROJECT_CONFIG });
		}
		for (const id of new Set([...Object.keys(config.engines), ...Object.keys(saved.engines)]) as Set<EngineId>) {
			const now = (config.engines[id] ??= {});
			for (const k of ["args", "allow", "ask"] as const) {
				const v = saved.engines[id]?.[k];
				if (v === undefined) delete now[k];
				else (now as Record<string, unknown>)[k] = v;
			}
		}
	};
	app.reloadPermissions = savedPermissions;

	/** "always allow": add the rules to [engines.<id>] allow, here and in config.toml. Returns why it couldn't save. */
	const alwaysAllow = (engine: Exclude<EngineId, "pi">, rules: string[]): string | undefined => {
		savedPermissions();
		const e = (config.engines[engine] ??= {});
		e.allow = [...new Set([...(e.allow ?? []), ...rules])];
		const file = configPath();
		try {
			const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : CONFIG_TEMPLATE;
			const list = `[${e.allow.map((r) => JSON.stringify(r)).join(", ")}]`;
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, setTomlValue(text, `engines.${engine}`, "allow", list));
			return undefined;
		} catch (err) {
			return `allowed for now, but couldn't save to ${file}: ${(err as Error).message}`;
		}
	};

	/** A pi agent: your pi in RPC mode; its conversation is kept in the worktree's session folder. */
	const piModel = modelArg && (!engineArg || engineArg === "pi") ? modelArg : (config.engines.pi?.model ?? config.model ?? "default");
	const piSession = (name: string, m: string, o: { cwd: string; worktree?: WorktreeInfo; sessionDir?: string; effort?: string; after?: Promise<unknown> }) =>
		// the same object, not a copy: a worktree made in the background fills in sessionDir before pi starts
		new PiSession(name, m, Object.assign(o, { extraArgs: config.engines.pi?.args }));

	/** A Claude Code / Codex / OpenCode agent; its conversation id is saved so it survives a restart. */
	const cliSession = (name: string, engine: Exclude<EngineId, "pi">, requested: string | undefined, cwd: string, wt?: WorktreeInfo, resumeId?: string, effort?: string, fork?: { at?: string }) =>
		new CliSession(name, engine, requested, {
			cwd,
			worktree: wt,
			resumeId,
			fork: Boolean(fork),
			forkAt: fork?.at,
			effort,
			// read at each prompt: :permissions changes them while agents are open
			extraArgs: () => config.engines[engine]?.args,
			// e.g. Claude Code without ANTHROPIC_API_KEY when it has a Claude account (see detectClaude)
			env: () => engineEnv(app.engines?.find((e) => e.id === engine)),
			// Claude Code's permission rules: [engines.claude] allow, and ask (opt-in) to allow a refused tool and retry
			allow: () => config.engines[engine]?.allow,
			ask: () => config.engines[engine]?.ask,
			onAlwaysAllow: (rules) => {
				const why = alwaysAllow(engine, rules);
				if (why) app.notify(why);
			},
			onResumeId: (id) => {
				if (!wt?.path) return;
				const meta = loadAgentMeta(wt.path);
				if (meta) saveAgentMeta(wt.path, { ...meta, resumeId: id });
			},
		});

	// model and effort for new agents, per engine, from [engines.<id>]
	app.templates = config.templates;
	app.hooks = config.hooks;
	app.layout = config.layout;
	app.engineOptions = config.engines;
	app.styleConfig = config.style;
	app.commands = config.commands;
	// :trust: let this project's .vigent.toml run its commands, from now on
	app.trustProject = () =>
		executeProjectTrust({
			app,
			config,
			projectFile,
			reloadPermissions: savedPermissions,
		});
	for (const [id, opts] of Object.entries(config.engines)) {
		if (opts?.model) app.newAgentModel[id as EngineId] = opts.model;
		if (opts?.effort) app.newAgentEffort[id as EngineId] = opts.effort;
	}
	// an agent's model and effort, changed with :model / :effort, survive a restart
	app.persist = (s) => {
		const wt = s.worktree?.path;
		if (!wt) return;
		const meta = loadAgentMeta(wt);
		if (!meta) return;
		const requested = s instanceof CliSession ? s.chosenModel : undefined;
		saveAgentMeta(wt, {
			...meta,
			model: s instanceof CliSession ? (requested ?? "") : s.model,
			...(s instanceof CliSession ? { requestedModel: requested, usage: { tokens: s.tokens, ...(s.cost !== undefined ? { cost: s.cost } : {}) } } : {}),
			effort: s.effort,
		});
	};

	app.newSession = (name, { worktree, model: perAgent, engine = app.defaultEngine(), effort }): Session => {
		if (demo) {
			// demo mode never touches your repo: the worktree is only shown, not created
			const shown = worktree ? { branch: branchName(name, config.worktree.branch) } : undefined;
			return new DemoSession(name, perAgent ?? model, shown);
		}
		// a CLI uses its own default model unless one is asked for
		const requested = engine === "pi" ? undefined : (perAgent ?? config.engines[engine]?.model ?? (modelArg && engineArg === engine ? modelArg : undefined));
		const m = engine === "pi" ? (perAgent ?? piModel) : (requested ?? "");
		// the branch and folder are picked now, so the agent shows up at once; the worktree is made in the background
		const wt = worktree && root ? planWorktree(root, name, config.worktree) : undefined;
		const pi: { cwd: string; worktree?: WorktreeInfo; sessionDir?: string; effort?: string; after?: Promise<unknown> } = { cwd: wt?.path ?? process.cwd(), worktree: wt, effort };
		const setup =
			wt?.path && root
				? addWorktree(root, wt, config.worktree).then((made) => {
						Object.assign(wt, made);
						saveAgentMeta(wt.path!, {
							name,
							model: m,
							base: wt.base,
							createdAt: new Date().toISOString(),
							...(engine === "pi" ? {} : { engine, ...(requested ? { requestedModel: requested } : {}) }),
							...(effort ? { effort } : {}),
						});
						pi.sessionDir = sessionDir(wt.path!);
					})
				: undefined;
		if (setup) pi.after = setup;
		const s = engine !== "pi" ? cliSession(name, engine, requested, pi.cwd, wt, undefined, effort) : piSession(name, m, pi);
		if (setup) s.setup = setup;
		return s;
	};
	/** Saved on pi (agents from before vigent recorded engines are too), and pi isn't here. */
	const stranded = (meta: AgentMeta) => (!meta.engine || !isEngineId(meta.engine) || meta.engine === "pi") && !onPath(PI_BIN);
	/** A pi agent can never answer without pi: the record that moves it to the engine you do have, if there is one. */
	const movedOffPi = (meta: AgentMeta): AgentMeta | undefined => {
		const engine = app.defaultEngine();
		if (!stranded(meta) || engine === "pi" || !app.engines?.find((e) => e.id === engine)?.installed) return undefined;
		// pi's model and thinking level mean nothing to another engine
		return { ...meta, engine, model: "", requestedModel: config.engines[engine]?.model, effort: undefined, resumeId: undefined, detached: undefined };
	};
	/** Reopen a saved agent with the engine it was started with (or, without pi, the one it moved to). */
	const reopen = (saved: AgentMeta, worktree: WorktreeInfo): Session => {
		const moved = movedOffPi(saved);
		if (moved) saveAgentMeta(worktree.path!, moved);
		const meta = moved ?? saved;
		const engine = meta.engine && isEngineId(meta.engine) ? meta.engine : "pi";
		if (engine !== "pi") {
			const s = cliSession(meta.name, engine, meta.requestedModel, worktree.path!, worktree, meta.resumeId, meta.effort);
			// the CLI keeps the conversation; vigent keeps the running totals
			s.tokens = meta.usage?.tokens ?? 0;
			s.cost = meta.usage?.cost;
			return s;
		}
		return piSession(meta.name, meta.model, { cwd: worktree.path!, worktree, sessionDir: sessionDir(worktree.path!), effort: meta.effort });
	};
	/**
	 * A split's new agent: a copy of the conversation that goes its own way.
	 * It runs in the same folder, because the conversation's paths point there,
	 * and holds no worktree of its own, so :kill! and :merge can't reach the original's.
	 */
	app.forkSession = (s) => {
		const taken = new Set(app.sessions.map((x) => x.name));
		const base = `${s.name} (fork)`;
		let name = base;
		for (let n = 2; taken.has(name); n++) name = `${base.slice(0, -1)} ${n})`;
		let fork: Session;
		if (demo) fork = new DemoSession(name, s.model);
		// forked where the original is now: what it's told after the split stays out of the fork
		else if (s instanceof CliSession && s.canFork) {
			const at = s.forkPoint();
			if (s.engine === "claude" && s.resumeId && !at) throw new Error(`couldn't find where '${s.name}''s Claude Code conversation is up to, so it can't be forked. :vsplit <agent> shows another agent beside this one.`);
			fork = cliSession(name, s.engine as Exclude<EngineId, "pi">, s.requestedModel, s.cwd, undefined, s.resumeId, s.effort, { at });
		}
		else throw new Error(`${ENGINE_NAMES[s.engine]} can't fork a conversation yet. :vsplit <agent> shows another agent beside this one.`);
		fork.items = structuredClone(s.items);
		fork.version++;
		return fork;
	};
	app.attachSession = (wt) => {
		if (demo || !wt.path) throw new Error("attaching needs a real agent (not --demo)");
		const meta = loadAgentMeta(wt.path) ?? {
			name: wt.branch.split("/").pop()?.replace(/-/g, " ") ?? wt.branch,
			model,
			createdAt: new Date().toISOString(),
		};
		const view = root ? prepareViews(root, [wt.path]).get(wt.path) : undefined;
		if (view && !view.ready) throw new Error(`can't reopen ${wt.branch}: ${view.reason}`);
		saveAgentMeta(wt.path, { ...meta, detached: undefined }); // reopened at the next start again
		return reopen(meta, { ...wt, base: wt.base ?? meta.base, riftri: view?.backend });
	};

	app.onQuit = () => {
		app.stopTimers();
		for (const s of app.sessions) {
			s.abort();
			s.dispose();
		}
		terminal.write(FOCUS_REPORTING_OFF);
		tui.stop();
		process.exit(0);
	};

	if (demo) {
		app.demo = true;
		for (const s of createDemoSessions()) app.addSession(s, false);
		app.focusIdx = 0;
		if (!argv.includes("--demo")) {
			warnings.unshift(
				"demo mode: these agents are scripted. For real ones, install and sign in to Claude Code, Codex or OpenCode, or set ANTHROPIC_API_KEY, then restart (:checkhealth)",
			);
		}
	} else if (root && config.worktree.enabled) {
		// reopen the agents that were running when vigent last quit
		// riftri views on OverlayFS lose their mount on reboot: they're repaired before any agent's record is read
		const { agents, blocked } = reopenableAgents(root, config.worktree, prepareViews);
		for (const b of blocked) warnings.push(`couldn't reopen the agent in ${b.path}: ${b.reason}`);
		// a stranded agent moves for good, so wait to learn which engine is signed in
		if (agents.some((a) => stranded(a.meta))) await detectEngines().then((engines) => app.setEngines(engines), () => {});
		for (const { meta, worktree, backend } of agents) {
			try {
				app.addSession(reopen(meta, { ...worktree, riftri: backend }), false);
			} catch (err) {
				warnings.push(`couldn't reopen '${meta.name}': ${(err as Error).message}`);
			}
		}
		if (app.sessions.length > 0) {
			app.focusIdx = 0;
			app.notify(`reopened ${app.sessions.length} agent${app.sessions.length === 1 ? "" : "s"} from last time`, "Comment");
		}
	}

	tui.addChild(app);
	tui.setFocus(app);
	terminal.setTitle("vigent");
	tui.start();
	// focus reports let a notification skip the agent you're looking at
	terminal.write(FOCUS_REPORTING_ON);
	if (warnings.length > 0) app.notify(warnings.join(" · "));
	if (isFollow(themeName)) {
		const editor = themeName;
		refreshFollow(editor, (t) => {
			app.setTheme(t);
			app.notify(`colorscheme from ${editor}: ${followedColorscheme(editor) ?? editor}`, "Comment");
		});
	}
	tui.requestRender(true);
	// follow from your phone from the start (same as :serve)
	if (argv.includes("--serve")) void app.execServe(argv.includes("--local") ? "local" : "");
	return undefined;
}

main()
	.then((code) => {
		if (code !== undefined) process.exitCode = code;
	})
	.catch((err) => {
		console.error(`vigent: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	});
