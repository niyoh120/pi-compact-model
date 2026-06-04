/**
 * pi-compact-model
 *
 * Use a custom model for pi compaction instead of the active conversation model.
 *
 * Hooks:
 * - session_before_compact: auto-compaction and /compact use the configured model.
 * - session_before_tree: /tree branch summarization uses the configured model.
 *
 * The summary format is identical to pi's default, because this extension reuses
 * pi's own compact() and generateBranchSummary() functions and only swaps the model.
 *
 * Configuration (resolved project -> global -> fall back to default compaction):
 * - Project: <cwd>/.pi/compact-model.json
 * - Global:  ~/.pi/agent/compact-model.json
 *   Format: { "provider": "google", "model": "gemini-2.5-flash" }
 *
 * Command:
 * - /compact-model opens a settings-style menu.
 *   Enter/Space changes the selected setting; Esc exits without further changes.
 *
 * On any failure (no config, model not found, no auth, LLM error, aborted/error
 * result, or unexpected exception) the extension returns undefined so pi falls
 * back to its default compaction behavior.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	compact,
	generateBranchSummary,
	getSelectListTheme,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	SelectList,
	SettingsList,
	type Component,
	type SelectItem,
	type SettingItem,
} from "@earendil-works/pi-tui";

const CONFIG_FILENAME = "compact-model.json";

type ConfigSource = "project" | "global";

interface CompactModelConfig {
	provider: string;
	model: string;
}

interface ResolvedConfig extends CompactModelConfig {
	source: ConfigSource;
}

/** Reentrancy guard: prevents re-entering our handlers if pi's compact()/
 * generateBranchSummary() were ever to re-trigger the same events. */
let inCompaction = false;

function projectConfigPath(cwd: string): string {
	return path.join(cwd, ".pi", CONFIG_FILENAME);
}

function globalConfigPath(): string {
	return path.join(os.homedir(), ".pi", "agent", CONFIG_FILENAME);
}

function configPathForScope(scope: ConfigSource, cwd: string): string {
	return scope === "project" ? projectConfigPath(cwd) : globalConfigPath();
}

/** Read and validate one config file. Returns undefined if missing or invalid. */
function readConfigFile(file: string): CompactModelConfig | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return undefined; // missing or unreadable -> treat as no config at this layer
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof (parsed as CompactModelConfig).provider === "string" &&
			typeof (parsed as CompactModelConfig).model === "string"
		) {
			const { provider, model } = parsed as CompactModelConfig;
			if (provider.trim() && model.trim()) {
				return { provider: provider.trim(), model: model.trim() };
			}
		}
	} catch {
		// invalid JSON -> treat as no config at this layer, continue fallback
	}
	return undefined;
}

/** Resolve config with precedence: project -> global -> undefined. */
function resolveConfig(cwd: string): ResolvedConfig | undefined {
	const project = readConfigFile(projectConfigPath(cwd));
	if (project) return { ...project, source: "project" };
	const global = readConfigFile(globalConfigPath());
	if (global) return { ...global, source: "global" };
	return undefined;
}

/** Write config to the chosen scope. Returns the path on success, undefined on failure. */
function writeConfig(
	scope: ConfigSource,
	cwd: string,
	cfg: CompactModelConfig,
): string | undefined {
	const file = configPathForScope(scope, cwd);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
		return file;
	} catch {
		return undefined;
	}
}

function clearConfig(scope: ConfigSource, cwd: string): boolean {
	try {
		fs.rmSync(configPathForScope(scope, cwd), { force: true });
		return true;
	} catch {
		return false;
	}
}

type ResolvedModelAuth = {
	model: NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;
	apiKey: string;
	headers: Record<string, string> | undefined;
};

/**
 * Resolve a model + auth from config. Returns null (and notifies) on any failure
 * so the caller can fall back to default compaction.
 */
async function resolveModelAndAuth(
	ctx: ExtensionContext,
	cfg: ResolvedConfig,
): Promise<ResolvedModelAuth | null> {
	const model = ctx.modelRegistry.find(cfg.provider, cfg.model);
	if (!model) {
		ctx.ui.notify(
			`compact-model: model ${cfg.provider}/${cfg.model} not found, using default compaction`,
			"warning",
		);
		return null;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		ctx.ui.notify(
			`compact-model: auth failed (${auth.error}), using default compaction`,
			"warning",
		);
		return null;
	}
	if (!auth.apiKey) {
		ctx.ui.notify(
			`compact-model: no API key for ${cfg.provider}, using default compaction`,
			"warning",
		);
		return null;
	}
	return { model, apiKey: auth.apiKey, headers: auth.headers };
}

function modelLabel(provider: string, id: string): string {
	return `${provider}/${id}`;
}

export default function (pi: ExtensionAPI) {
	// --- Compaction: auto-compaction and /compact ---
	pi.on("session_before_compact", async (event, ctx) => {
		if (inCompaction) return undefined;
		// Set the guard before the first await so concurrent events cannot both pass
		// the check above; finally below guarantees reset on every path.
		inCompaction = true;
		try {
			const cfg = resolveConfig(ctx.cwd);
			if (!cfg) return undefined; // no config -> default compaction

			const resolved = await resolveModelAndAuth(ctx, cfg);
			if (!resolved) return undefined;

			const { preparation, customInstructions, signal } = event;
			ctx.ui.notify(
				`compact-model: summarizing with ${modelLabel(cfg.provider, resolved.model.id)} (${cfg.source})`,
				"info",
			);

			const result = await compact(
				preparation,
				resolved.model,
				resolved.apiKey,
				resolved.headers,
				customInstructions,
				signal,
			);
			if (!result.summary?.trim()) {
				if (!signal.aborted) {
					ctx.ui.notify(
						"compact-model: empty summary, using default compaction",
						"warning",
					);
				}
				return undefined;
			}
			return { compaction: result };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(
				`compact-model: compaction failed (${msg}), using default compaction`,
				"warning",
			);
			return undefined;
		} finally {
			inCompaction = false;
		}
	});

	// --- Branch summarization: /tree navigation ---
	pi.on("session_before_tree", async (event, ctx) => {
		const { preparation, signal } = event;
		// Only intervene when the user actually asked for a summary.
		if (!preparation.userWantsSummary) return undefined;
		if (inCompaction) return undefined;
		// Set the guard before the first await; finally below guarantees reset.
		inCompaction = true;

		try {
			const cfg = resolveConfig(ctx.cwd);
			if (!cfg) return undefined;

			const resolved = await resolveModelAndAuth(ctx, cfg);
			if (!resolved) return undefined;

			ctx.ui.notify(
				`compact-model: branch summary with ${modelLabel(cfg.provider, resolved.model.id)} (${cfg.source})`,
				"info",
			);

			const result = await generateBranchSummary(
				preparation.entriesToSummarize,
				{
					model: resolved.model,
					apiKey: resolved.apiKey,
					headers: resolved.headers,
					signal,
					customInstructions: preparation.customInstructions,
					replaceInstructions: preparation.replaceInstructions,
				},
			);

			if (result.aborted) return undefined;
			if (result.error) {
				ctx.ui.notify(
					`compact-model: branch summary failed (${result.error}), using default`,
					"warning",
				);
				return undefined;
			}
			if (!result.summary?.trim()) return undefined;

			return {
				summary: {
					summary: result.summary,
					details: {
						readFiles: result.readFiles ?? [],
						modifiedFiles: result.modifiedFiles ?? [],
					},
				},
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(
				`compact-model: branch summary failed (${msg}), using default`,
				"warning",
			);
			return undefined;
		} finally {
			inCompaction = false;
		}
	});

	// --- Command: /compact-model ---
	pi.registerCommand("compact-model", {
		description: "Configure the model used for compaction and branch summaries",
		handler: async (_args, ctx) => {
			const defaultValue = "pi default";
			const available = ctx.modelRegistry.getAvailable();
			const modelOptions: SelectItem[] = [
				{
					value: defaultValue,
					label: defaultValue,
					description: "Clear this scope and let pi choose the default compaction behavior",
				},
				...available.map((m) => ({
					value: modelLabel(m.provider, m.id),
					label: modelLabel(m.provider, m.id),
					description: m.name,
				})),
			];

			const readScopedLabel = (scope: ConfigSource): string => {
				const file = configPathForScope(scope, ctx.cwd);
				const cfg = readConfigFile(file);
				return cfg ? modelLabel(cfg.provider, cfg.model) : defaultValue;
			};
			const effectiveLabel = (): string => {
				const cfg = resolveConfig(ctx.cwd);
				return cfg ? `${modelLabel(cfg.provider, cfg.model)} (${cfg.source})` : defaultValue;
			};

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				let settingsList: SettingsList;

				const makeModelSubmenu = (
					scope: ConfigSource,
					currentValue: string,
					doneSubmenu: (selectedValue?: string) => void,
				): Component => {
					const selectList = new SelectList(
						modelOptions,
						Math.min(modelOptions.length, 12),
						getSelectListTheme(),
					);
					const currentIndex = modelOptions.findIndex((o) => o.value === currentValue);
					if (currentIndex >= 0) selectList.setSelectedIndex(currentIndex);
					selectList.onSelect = (item) => doneSubmenu(item.value);
					selectList.onCancel = () => doneSubmenu();
					return {
						render(width: number) {
							return [
								theme.bold(theme.fg("accent", `${scope === "project" ? "Project" : "Global"} compaction model`)),
								"",
								...selectList.render(width),
								"",
								theme.fg("dim", "  Enter to select · Esc to go back"),
							];
						},
						handleInput(data: string) {
							selectList.handleInput(data);
							tui.requestRender();
						},
						invalidate() {
							selectList.invalidate();
						},
					};
				};

				const items: SettingItem[] = [
					{
						id: "effective",
						label: "Effective model",
						description: "Current model used by compaction. Project config overrides global config.",
						currentValue: effectiveLabel(),
					},
					{
						id: "project",
						label: "Project model",
						description: "Saved in .pi/compact-model.json. Enter/Space to change; choose pi default to clear.",
						currentValue: readScopedLabel("project"),
						submenu: (currentValue, doneSubmenu) => makeModelSubmenu("project", currentValue, doneSubmenu),
					},
					{
						id: "global",
						label: "Global model",
						description: "Saved in ~/.pi/agent/compact-model.json. Enter/Space to change; choose pi default to clear.",
						currentValue: readScopedLabel("global"),
						submenu: (currentValue, doneSubmenu) => makeModelSubmenu("global", currentValue, doneSubmenu),
					},
				];

				settingsList = new SettingsList(
					items,
					Math.min(items.length, 10),
					getSettingsListTheme(),
					(id, newValue) => {
						if (id !== "project" && id !== "global") return;
						const scope = id as ConfigSource;
						const previousValue = readScopedLabel(scope);
						if (newValue === defaultValue) {
							if (!clearConfig(scope, ctx.cwd)) {
								ctx.ui.notify(`compact-model: failed to clear ${scope} config`, "error");
								settingsList.updateValue(scope, previousValue);
								return;
							}
						} else {
							const chosen = available.find((m) => modelLabel(m.provider, m.id) === newValue);
							if (!chosen) {
								ctx.ui.notify(`compact-model: model ${newValue} is no longer available`, "warning");
								settingsList.updateValue(scope, previousValue);
								return;
							}
							const written = writeConfig(scope, ctx.cwd, {
								provider: chosen.provider,
								model: chosen.id,
							});
							if (!written) {
								ctx.ui.notify(`compact-model: failed to write ${scope} config`, "error");
								settingsList.updateValue(scope, previousValue);
								return;
							}
						}
						settingsList.updateValue("effective", effectiveLabel());
					},
					() => done(),
				);

				return {
					render(width: number) {
						return [
							theme.bold(theme.fg("accent", "Compact Model Configuration")),
							"",
							...settingsList.render(width),
						];
					},
					handleInput(data: string) {
						settingsList.handleInput(data);
						tui.requestRender();
					},
					invalidate() {
						settingsList.invalidate();
					},
				};
			});
		},
	});
}
