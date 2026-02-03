"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const CONFIG_SECTION = 'commandButtons';
const STORAGE_KEY = 'commandButtons.commands';
const PRESET_STORAGE_KEY = 'commandButtons.presets';
const PRESET_LIBRARY_FILE = 'terminal-command-reference.json';
const PRESET_DEFAULTS = [
    { id: 'preset-npm-dev', label: 'npm dev', text: 'npm run dev' },
    { id: 'preset-npm-build', label: 'npm build', text: 'npm run build' },
    { id: 'preset-npm-test', label: 'npm test', text: 'npm test' },
    {
        id: 'preset-tsc-no-emit',
        label: 'tsc no emit',
        text: 'npx tsc --noEmit --pretty false'
    },
    { id: 'preset-git-status', label: 'git status', text: 'git status' },
    { id: 'preset-dc-up', label: 'docker compose up', text: 'docker compose up' }
];
const ACCENT_COLORS = {
    red: { accent: '#e53935', accentHover: '#d32f2f', accentFg: '#ffffff' },
    pink: { accent: '#d81b60', accentHover: '#c2185b', accentFg: '#ffffff' },
    orange: { accent: '#fb8c00', accentHover: '#f57c00', accentFg: '#ffffff' },
    yellow: { accent: '#fbc02d', accentHover: '#f9a825', accentFg: '#1f1f1f' },
    green: { accent: '#4caf50', accentHover: '#43a047', accentFg: '#ffffff' },
    blue: { accent: '#1e88e5', accentHover: '#1976d2', accentFg: '#ffffff' },
    purple: { accent: '#8e24aa', accentHover: '#7b1fa2', accentFg: '#ffffff' },
    grey: { accent: '#9e9e9e', accentHover: '#8e8e8e', accentFg: '#111111' },
    white: { accent: '#ffffff', accentHover: '#f2f2f2', accentFg: '#111111' },
    black: { accent: '#111111', accentHover: '#000000', accentFg: '#ffffff' }
};
function activate(context) {
    // Optional: allow Settings Sync to sync global commands/presets between machines
    context.globalState.setKeysForSync?.([STORAGE_KEY, PRESET_STORAGE_KEY]);
    const provider = new CommandButtonsViewProvider(context);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('commandButtonsView', provider, {
        webviewOptions: {
            retainContextWhenHidden: true
        }
    }));
}
function deactivate() {
    // nothing to clean up for now
}
class CommandButtonsViewProvider {
    constructor(context) {
        this.context = context;
        this._commands = [];
        this._presets = [];
        this._presetLibrary = {
            environments: [],
            languages: []
        };
        this._commands = this.loadCommands();
        this._presets = this.loadPresets();
        this._presetLibrary = this.loadPresetLibrary();
        this.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(`${CONFIG_SECTION}.accentColor`)) {
                this.postAccentColors();
            }
        }));
    }
    resolveWebviewView(webviewView, _context, _token) {
        this._view = webviewView;
        const webview = webviewView.webview;
        webview.options = {
            enableScripts: true
        };
        webview.html = this.getHtmlForWebview(webview);
        webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'ready': {
                    this._commands = this.loadCommands();
                    if (!this._commands.length &&
                        Array.isArray(message.cachedCommands) &&
                        message.cachedCommands.length) {
                        this._commands = this.normalizeCommands(message.cachedCommands);
                        await this.saveCommands();
                    }
                    else {
                        this.postCommands();
                    }
                    this._presets = this.loadPresets();
                    this.postPresets();
                    this._presetLibrary = this.loadPresetLibrary();
                    this.postPresetLibrary();
                    this.postAccentColors();
                    break;
                }
                case 'addCommand': {
                    await this.addCommand(message.label, message.text);
                    break;
                }
                case 'addPreset': {
                    await this.addPreset(message.label, message.text);
                    break;
                }
                case 'deleteCommand': {
                    await this.deleteCommand(message.id);
                    break;
                }
                case 'removePreset': {
                    await this.removePreset(message.id);
                    break;
                }
                case 'runCommand': {
                    const runMode = this.normalizeRunMode(message.runMode, message.addNewLine);
                    await this.runCommand(message.text, runMode);
                    break;
                }
                case 'reorderCommands': {
                    await this.reorderCommands(message.fromIndex, message.toIndex);
                    break;
                }
                case 'updateCommandMode': {
                    await this.updateCommandMode(message.id, message.runMode);
                    break;
                }
                case 'updateAllCommandModes': {
                    await this.updateAllCommandModes(message.runMode);
                    break;
                }
                case 'updateCommandInput': {
                    await this.updateCommandInputValue(message.id, message.inputValue ?? '');
                    break;
                }
                case 'restorePresetDefaults': {
                    await this.restorePresetDefaults();
                    break;
                }
            }
        });
    }
    // --- Storage helpers ----------------------------------------------------
    get hasWorkspace() {
        return Boolean(vscode.workspace.workspaceFolders?.length);
    }
    get storage() {
        return this.hasWorkspace ? this.context.workspaceState : this.context.globalState;
    }
    normalizeRunMode(runMode, addNewLine) {
        if (runMode === 'enter' ||
            runMode === 'clipboard' ||
            runMode === 'terminal' ||
            runMode === 'dynamic') {
            return runMode;
        }
        if (runMode === 'copy') {
            return 'clipboard';
        }
        if (addNewLine === false) {
            return 'clipboard';
        }
        return 'enter';
    }
    shouldSendEnter(runMode) {
        return runMode === 'enter' || runMode === 'dynamic';
    }
    loadCommands() {
        const workspaceCommands = this.context.workspaceState.get(STORAGE_KEY);
        if (this.hasWorkspace && Array.isArray(workspaceCommands)) {
            return this.normalizeCommands(workspaceCommands);
        }
        const globalCommands = this.context.globalState.get(STORAGE_KEY);
        return Array.isArray(globalCommands)
            ? this.normalizeCommands(globalCommands)
            : [];
    }
    normalizeCommands(commands) {
        return commands.map((cmd) => {
            const text = cmd.text ?? '';
            const label = (cmd.label ?? text)?.trim() || text || '';
            const runMode = this.normalizeRunMode(cmd.runMode, cmd.addNewLine);
            const inputValue = cmd.inputValue ?? '';
            return {
                ...cmd,
                text,
                label,
                addNewLine: this.shouldSendEnter(runMode),
                runMode,
                inputValue
            };
        });
    }
    async saveCommands() {
        this._commands = this.normalizeCommands(this._commands);
        await this.storage.update(STORAGE_KEY, this._commands);
        // Update the webview UI
        this.postCommands();
    }
    postCommands() {
        this._view?.webview.postMessage({
            type: 'setCommands',
            commands: this._commands
        });
    }
    get presetStorage() {
        return this.context.globalState;
    }
    loadPresets() {
        const storedPresets = this.presetStorage.get(PRESET_STORAGE_KEY);
        if (Array.isArray(storedPresets)) {
            return this.normalizePresets(storedPresets);
        }
        return this.normalizePresets(PRESET_DEFAULTS);
    }
    normalizePresets(presets) {
        if (!Array.isArray(presets)) {
            return [];
        }
        const normalized = [];
        for (const preset of presets) {
            const rawText = this.normalizeCommandText(String(preset?.text ?? ''));
            const trimmedText = rawText.trim();
            if (!trimmedText) {
                continue;
            }
            const label = String(preset?.label ?? trimmedText).trim() || trimmedText;
            const id = String(preset?.id ?? this.createPresetId());
            normalized.push({ id, label, text: trimmedText });
        }
        return normalized;
    }
    async savePresets() {
        this._presets = this.normalizePresets(this._presets);
        await this.presetStorage.update(PRESET_STORAGE_KEY, this._presets);
        this.postPresets();
    }
    postPresets() {
        this._view?.webview.postMessage({
            type: 'setPresets',
            presets: this._presets
        });
    }
    postPresetLibrary() {
        this._view?.webview.postMessage({
            type: 'setPresetLibrary',
            library: this._presetLibrary
        });
    }
    loadPresetLibrary() {
        const fallback = {
            environments: [],
            languages: []
        };
        const libraryPath = path.join(this.context.extensionPath, PRESET_LIBRARY_FILE);
        let raw;
        try {
            raw = fs.readFileSync(libraryPath, 'utf8');
        }
        catch {
            return fallback;
        }
        try {
            const parsed = JSON.parse(raw);
            return this.normalizePresetLibrary(parsed);
        }
        catch {
            return fallback;
        }
    }
    normalizePresetLibrary(raw) {
        const fallback = {
            environments: [],
            languages: []
        };
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return fallback;
        }
        const data = raw;
        const envSource = this.extractPresetSection(data, 'environments');
        const langSource = this.extractPresetSection(data, 'languages');
        if (envSource || langSource) {
            return {
                environments: this.normalizePresetGroups(envSource),
                languages: this.normalizePresetGroups(langSource)
            };
        }
        const split = this.splitPresetGroups(data);
        return {
            environments: this.normalizePresetGroups(split.environments),
            languages: this.normalizePresetGroups(split.languages)
        };
    }
    extractPresetSection(data, key) {
        const value = data[key];
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return undefined;
        }
        return value;
    }
    splitPresetGroups(data) {
        const environments = {};
        const languages = {};
        for (const [key, value] of Object.entries(data)) {
            if (key === 'environments' || key === 'languages') {
                continue;
            }
            if (this.isLanguageKey(key)) {
                languages[key] = value;
            }
            else {
                environments[key] = value;
            }
        }
        return { environments, languages };
    }
    normalizePresetGroups(source) {
        if (!source || typeof source !== 'object') {
            return [];
        }
        const groups = [];
        for (const [groupId, groupValue] of Object.entries(source)) {
            if (!groupValue || typeof groupValue !== 'object' || Array.isArray(groupValue)) {
                continue;
            }
            const categories = [];
            for (const [categoryId, categoryValue] of Object.entries(groupValue)) {
                if (!Array.isArray(categoryValue)) {
                    continue;
                }
                const commands = [];
                for (const entry of categoryValue) {
                    const command = String(entry?.command ?? '').trim();
                    if (!command) {
                        continue;
                    }
                    const description = String(entry?.description ?? '').trim();
                    commands.push({ command, description: description || undefined });
                }
                if (commands.length) {
                    categories.push({
                        id: categoryId,
                        label: this.formatPresetLabel(categoryId),
                        commands
                    });
                }
            }
            if (categories.length) {
                groups.push({
                    id: groupId,
                    label: this.formatPresetLabel(groupId),
                    categories
                });
            }
        }
        return groups;
    }
    formatPresetLabel(value) {
        const normalized = String(value ?? '').trim();
        if (!normalized) {
            return '';
        }
        const parts = normalized.split(/[_-]+/).filter(Boolean);
        const mapped = parts.map((part) => {
            const lower = part.toLowerCase();
            if (lower === 'javascript') {
                return 'JavaScript';
            }
            if (lower === 'typescript') {
                return 'TypeScript';
            }
            if (lower === 'csharp' || lower === 'c#') {
                return 'C#';
            }
            if (lower === 'cpp' || lower === 'c++') {
                return 'C++';
            }
            if (lower === 'dotnet') {
                return '.NET';
            }
            return lower.charAt(0).toUpperCase() + lower.slice(1);
        });
        return mapped.join(' ');
    }
    isLanguageKey(key) {
        const normalized = key.toLowerCase();
        const languageTokens = [
            'javascript',
            'typescript',
            'python',
            'ruby',
            'php',
            'java',
            'go',
            'golang',
            'rust',
            'csharp',
            'c#',
            'cpp',
            'c++',
            'dotnet',
            'swift',
            'kotlin',
            'scala',
            'dart',
            'lua'
        ];
        return languageTokens.some((token) => normalized.includes(token));
    }
    getAccentColors() {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const selected = config.get('accentColor', 'green');
        return ACCENT_COLORS[selected] ?? ACCENT_COLORS.green;
    }
    postAccentColors() {
        this._view?.webview.postMessage({
            type: 'setAccent',
            accent: this.getAccentColors()
        });
    }
    normalizeCommandText(value) {
        return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }
    createPresetId() {
        return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    async addCommand(label, text) {
        const trimmedLabel = (label ?? '').trim();
        const normalizedText = this.normalizeCommandText(text ?? '');
        const trimmedText = normalizedText.trim();
        if (!trimmedText) {
            vscode.window.showWarningMessage('Please provide a command.');
            return;
        }
        const id = Date.now().toString();
        const defaultLabel = trimmedText.split('\n')[0] || trimmedText;
        const finalLabel = trimmedLabel || defaultLabel;
        const inferredMode = normalizedText.includes('${input}')
            ? 'dynamic'
            : 'enter';
        this._commands = [
            ...this._commands,
            {
                id,
                label: finalLabel,
                text: trimmedText,
                addNewLine: true,
                runMode: inferredMode,
                inputValue: ''
            }
        ];
        await this.saveCommands();
    }
    async addPreset(label, text) {
        const trimmedLabel = (label ?? '').trim();
        const normalizedText = this.normalizeCommandText(text ?? '');
        const trimmedText = normalizedText.trim();
        if (!trimmedText) {
            vscode.window.showWarningMessage('Please provide a command to save as a preset.');
            return;
        }
        const defaultLabel = trimmedText.split('\n')[0] || trimmedText;
        const finalLabel = trimmedLabel || defaultLabel;
        const exists = this._presets.some((preset) => preset.label === finalLabel && preset.text === trimmedText);
        if (exists) {
            vscode.window.showInformationMessage('That preset already exists.');
            return;
        }
        this._presets = [
            ...this._presets,
            {
                id: this.createPresetId(),
                label: finalLabel,
                text: trimmedText
            }
        ];
        await this.savePresets();
    }
    async deleteCommand(id) {
        this._commands = this._commands.filter((c) => c.id !== id);
        await this.saveCommands();
    }
    async removePreset(id) {
        if (!id) {
            return;
        }
        this._presets = this._presets.filter((preset) => preset.id !== id);
        await this.savePresets();
    }
    async restorePresetDefaults() {
        this._presets = this.normalizePresets(PRESET_DEFAULTS);
        await this.savePresets();
    }
    async reorderCommands(fromIndex, toIndex) {
        if (!Number.isInteger(fromIndex) ||
            !Number.isInteger(toIndex) ||
            fromIndex === toIndex) {
            return;
        }
        if (fromIndex < 0 ||
            fromIndex >= this._commands.length ||
            toIndex < 0) {
            return;
        }
        const maxIndex = this._commands.length;
        const target = Math.max(0, Math.min(toIndex, maxIndex));
        const updated = [...this._commands];
        const [moved] = updated.splice(fromIndex, 1);
        if (!moved) {
            return;
        }
        let insertIndex = target;
        if (fromIndex < target) {
            insertIndex = target - 1;
        }
        insertIndex = Math.max(0, Math.min(insertIndex, updated.length));
        updated.splice(insertIndex, 0, moved);
        this._commands = updated;
        await this.saveCommands();
    }
    async updateCommandMode(id, runMode) {
        const normalizedMode = this.normalizeRunMode(runMode);
        this._commands = this._commands.map((cmd) => cmd.id === id
            ? {
                ...cmd,
                runMode: normalizedMode,
                addNewLine: this.shouldSendEnter(normalizedMode)
            }
            : cmd);
        await this.saveCommands();
    }
    async updateAllCommandModes(runMode) {
        const normalizedMode = this.normalizeRunMode(runMode);
        this._commands = this._commands.map((cmd) => ({
            ...cmd,
            runMode: normalizedMode,
            addNewLine: this.shouldSendEnter(normalizedMode)
        }));
        await this.saveCommands();
    }
    async updateCommandInputValue(id, inputValue) {
        this._commands = this._commands.map((cmd) => cmd.id === id ? { ...cmd, inputValue } : cmd);
        await this.saveCommands();
    }
    // --- Terminal handling --------------------------------------------------
    ensureTerminal() {
        if (!this._terminal || this._terminal.exitStatus) {
            this._terminal = vscode.window.createTerminal('Command Buttons');
        }
        this._terminal.show(true);
        return this._terminal;
    }
    async runCommand(text, runMode) {
        if (runMode === 'clipboard') {
            try {
                await vscode.env.clipboard.writeText(text);
                vscode.window.showInformationMessage('Copied to Clipboard');
            }
            catch {
                vscode.window.showErrorMessage('Failed to copy to clipboard.');
            }
            return;
        }
        const terminal = this.ensureTerminal();
        terminal.sendText(text, this.shouldSendEnter(runMode)); // true -> add newline (ENTER)
    }
    // --- Webview HTML -------------------------------------------------------
    getHtmlForWebview(webview) {
        const nonce = getNonce();
        const cspSource = webview.cspSource;
        const accent = this.getAccentColors();
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${cspSource} https:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Command Buttons</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-sideBar-foreground, var(--vscode-foreground));
      --surface: var(--vscode-editorWidget-background);
      --border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(0,0,0,0.2)));
      --accent: ${accent.accent};
      --accent-hover: ${accent.accentHover};
      --accent-fg: ${accent.accentFg};
      --secondary-bg: var(--vscode-button-secondaryBackground, rgba(0,0,0,0.15));
      --secondary-hover: var(--vscode-button-secondaryHoverBackground, rgba(0,0,0,0.25));
      --secondary-fg: var(--vscode-button-secondaryForeground, var(--fg));
      --input-bg: var(--vscode-input-background, transparent);
      --input-border: var(--vscode-input-border, var(--border));
      --input-fg: var(--vscode-input-foreground, var(--fg));
      --dropdown-bg: var(--vscode-dropdown-background, var(--surface));
      --dropdown-border: var(--vscode-dropdown-border, var(--border));
      --dropdown-fg: var(--vscode-dropdown-foreground, var(--fg));
      --danger: var(--vscode-inputValidation-errorBackground, #e53935);
      --danger-hover: var(--vscode-inputValidation-errorBackground, #c62828);
      --danger-fg: var(--vscode-inputValidation-errorForeground, #ffffff);
      --warning-bg: var(--vscode-inputValidation-warningBackground, rgba(255,165,0,0.12));
      --warning-border: var(--vscode-inputValidation-warningBorder, rgba(255,165,0,0.6));
      --warning-fg: var(--vscode-inputValidation-warningForeground, rgba(255,140,0,0.95));
      --focus: var(--vscode-focusBorder, var(--accent));
    }

    * {
      box-sizing: border-box;
    }

    html, body {
      height: 100%;
    }

    body {
      margin: 0;
      padding: 0.5rem;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      background-color: var(--bg);
      color: var(--fg);
      overflow-x: hidden;
      min-height: 100%;
    }

    .panel {
      height: 100%;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      min-width: 0;
    }

    .list-section {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      min-width: 0;
    }

    .panel.grid-bottom .grid-section {
      order: 2;
    }

    .panel.grid-bottom .list-section {
      order: 1;
    }

    .grid-section {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      min-width: 0;
      position: relative;
    }

    .grid-controls {
      display: flex;
      gap: 0.25rem;
      align-items: center;
      justify-content: flex-end;
      flex-wrap: wrap;
      order: 2;
    }

    .collapse-toggle {
      position: absolute;
      top: -0.4rem;
      right: -0.1rem;
      width: 1.5rem;
      height: 1.5rem;
      border-radius: 50%;
      border: 1px solid var(--border);
      background-color: var(--secondary-bg);
      color: var(--secondary-fg);
      font-size: 11px;
      cursor: pointer;
    }

    .collapse-toggle:hover {
      background-color: var(--secondary-hover);
    }

    .panel.grid-bottom .grid-controls {
      order: 1;
    }

    .panel.grid-bottom .commands-grid {
      order: 2;
    }

    .panel.grid-only .grid-controls,
    .panel.grid-only .list-section {
      display: none;
    }

    .panel.grid-only {
      gap: 0;
      height: auto;
      min-height: 0;
    }

    .panel.grid-only .grid-section {
      flex: 1;
      min-height: 0;
    }

    .panel.grid-only .commands-grid {
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    html.grid-only-mode,
    body.grid-only-mode {
      min-height: 0;
      height: auto;
    }

    body.grid-only-mode {
      overflow-y: hidden;
    }

    body.grid-only-mode #mainPanel {
      height: auto;
      min-height: 0;
    }

    body.grid-only-mode .grid-section {
      flex: none;
    }

    body.grid-only-mode .commands-grid {
      min-height: 0;
      height: auto;
    }

    body.grid-only-mode .grid-button-wrapper .mode-chip {
      display: none;
    }

    .grid-controls label {
      font-size: 10px;
      opacity: 0.6;
      white-space: nowrap;
    }

    .toggle-btn {
      padding: 0.15rem 0.35rem;
      font-size: 10px;
      background-color: var(--secondary-bg);
      color: var(--secondary-fg);
    }

    .toggle-btn:hover {
      background-color: var(--secondary-hover);
    }

    .toggle-btn.active {
      background-color: var(--accent);
      color: var(--accent-fg);
    }

    .toggle-btn.active:hover {
      background-color: var(--accent-hover);
    }

    .mode-toggle {
      padding: 0.15rem 0.35rem;
      font-size: 10px;
      border: 1px solid var(--border);
      background-color: var(--secondary-bg);
      color: var(--secondary-fg);
    }

    .mode-toggle.mode-enter {
      border-color: var(--accent);
      background-color: var(--surface);
    }

    .mode-toggle.mode-clipboard,
    .mode-toggle.mode-terminal,
    .mode-toggle.mode-copy {
      border-color: var(--border);
      background-color: var(--secondary-bg);
    }

    .mode-toggle.mode-dynamic {
      border-color: var(--warning-border);
      background-color: var(--warning-bg);
      color: var(--warning-fg);
    }

    .mode-toggle.small {
      padding: 0.1rem 0.3rem;
      font-size: 10px;
    }

    .commands-grid {
      display: grid;
      gap: 0.25rem;
      padding: 0.35rem;
      border-radius: 6px;
      border: 1px solid var(--border);
      background-color: var(--surface);
      order: 1;
      width: 100%;
      min-width: 0;
      min-height: 6rem;
      flex: 1;
    }

    .commands-grid.cols-1 { grid-template-columns: repeat(1, minmax(0, 1fr)); }
    .commands-grid.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .commands-grid.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .commands-grid.cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }

    .grid-button {
      padding: 0.4rem 0.5rem;
      text-align: center;
      font-weight: 500;
      font-size: 12px;
      background-color: var(--accent);
      color: var(--accent-fg);
      cursor: grab;
      user-select: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 2.35rem;
      min-width: 0;
    }

    .grid-button:hover {
      background-color: var(--accent-hover);
    }

    .grid-button:active {
      cursor: grabbing;
    }

    .grid-button.dragging {
      opacity: 0.6;
    }

    .grid-button-wrapper {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }

    .dynamic-input {
      width: 100%;
      padding: 0.25rem 0.35rem;
      border-radius: 4px;
      border: 1px solid var(--input-border);
      background-color: var(--input-bg);
      font-size: 11px;
      color: var(--input-fg);
    }

    .dynamic-input:focus {
      outline: none;
      border-color: var(--focus);
      box-shadow: 0 0 0 1px var(--focus);
    }

    .command-dynamic-row {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      margin-top: 0.35rem;
    }

    .command-dynamic-row label {
      font-size: 10px;
      opacity: 0.7;
    }

    .grid-button-wrapper .mode-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background-color: var(--secondary-bg);
      padding: 0.15rem 0.25rem;
      cursor: pointer;
      color: var(--secondary-fg);
    }

    .grid-button-wrapper .mode-chip.mode-enter {
      border-color: var(--accent);
      background-color: var(--surface);
    }

    .grid-button-wrapper .mode-chip.mode-clipboard,
    .grid-button-wrapper .mode-chip.mode-terminal,
    .grid-button-wrapper .mode-chip.mode-copy {
      border-color: var(--border);
      background-color: var(--secondary-bg);
    }

    .grid-button-wrapper .mode-chip.mode-dynamic {
      border-color: var(--warning-border);
      background-color: var(--warning-bg);
      color: var(--warning-fg);
    }

    .grid-empty {
      font-size: 11px;
      opacity: 0.5;
      text-align: center;
      padding: 0.5rem;
      grid-column: 1 / -1;
    }

    .add-form {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.45rem;
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      background-color: var(--surface);
    }

    .preset-row {
      display: flex;
      gap: 0.25rem;
      align-items: center;
      flex-wrap: wrap;
    }

    .preset-row-tools {
      justify-content: flex-start;
    }

    .preset-library {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }

    .preset-library-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.35rem;
      flex-wrap: wrap;
    }

    .preset-library-title {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      opacity: 0.7;
    }

    .preset-library-subtitle {
      font-size: 10px;
      opacity: 0.7;
    }

    .preset-library-search {
      display: flex;
      gap: 0.25rem;
      align-items: center;
    }

    .preset-library-summary {
      font-size: 10px;
      opacity: 0.7;
    }

    .preset-filters {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 0.35rem;
    }

    .preset-filter {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      min-width: 0;
    }

    .preset-filter label {
      font-size: 10px;
      opacity: 0.7;
    }

    .preset-library-list {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.25rem;
      max-height: 14rem;
      overflow-y: auto;
      background-color: var(--input-bg);
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }

    .preset-library-empty {
      font-size: 11px;
      opacity: 0.6;
      text-align: center;
      padding: 0.35rem;
    }

    .preset-group {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .preset-group-title {
      font-size: 11px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.35rem;
    }

    .preset-group-title .count {
      font-size: 10px;
      opacity: 0.6;
    }

    .preset-category {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }

    .preset-category-title {
      font-size: 10px;
      opacity: 0.7;
    }

    .preset-item {
      display: flex;
      flex-direction: column;
      gap: 0.05rem;
      text-align: left;
      width: 100%;
      border: 1px solid var(--border);
      background-color: var(--secondary-bg);
      color: var(--secondary-fg);
      padding: 0.25rem 0.35rem;
    }

    .preset-item:hover {
      background-color: var(--secondary-hover);
    }

    .preset-item-custom {
      background-color: var(--surface);
      border-style: dashed;
    }

    .preset-item-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.35rem;
    }

    .preset-item-label {
      font-size: 11px;
      font-weight: 600;
    }

    .preset-item-actions {
      display: flex;
      gap: 0.25rem;
      align-items: center;
    }

    .btn-xs {
      font-size: 10px;
      padding: 0.15rem 0.35rem;
    }

    .preset-item .command {
      font-family: monospace;
      font-size: 11px;
    }

    .preset-item .description {
      font-size: 10px;
      opacity: 0.75;
    }

    select {
      flex: 1;
      border-radius: 4px;
      border: 1px solid var(--dropdown-border);
      padding: 0.25rem 0.35rem;
      font-size: 12px;
      background-color: var(--dropdown-bg);
      color: var(--dropdown-fg);
    }

    select option {
      background-color: var(--dropdown-bg);
      color: var(--dropdown-fg);
    }

    .add-row {
      display: flex;
      gap: 0.25rem;
    }

    input[type="text"],
    textarea {
      flex: 1;
      border-radius: 4px;
      border: 1px solid var(--input-border);
      padding: 0.25rem 0.35rem;
      font-size: 12px;
      background-color: var(--input-bg);
      color: var(--input-fg);
      font-family: inherit;
    }

    input[type="text"]:focus,
    textarea:focus {
      outline: 1px solid var(--focus);
      outline-offset: 1px;
      border-color: var(--focus);
    }

    .autocomplete {
      position: relative;
      flex: 1;
      min-width: 0;
    }

    .autocomplete input[type="text"],
    .autocomplete textarea {
      width: 100%;
    }

    #commandInput {
      min-height: 3.25rem;
      resize: vertical;
      line-height: 1.35;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
    }

    .autocomplete-menu {
      position: absolute;
      left: 0;
      right: 0;
      top: calc(100% + 2px);
      background-color: var(--dropdown-bg);
      color: var(--dropdown-fg);
      border: 1px solid var(--dropdown-border);
      border-radius: 4px;
      padding: 0.15rem;
      display: none;
      z-index: 20;
      max-height: 11rem;
      overflow-y: auto;
      box-shadow: 0 6px 14px rgba(0,0,0,0.2);
    }

    .autocomplete-menu.visible {
      display: block;
    }

    .autocomplete-item {
      display: flex;
      flex-direction: column;
      gap: 0.05rem;
      padding: 0.25rem 0.35rem;
      border-radius: 3px;
      cursor: pointer;
    }

    .autocomplete-item:hover {
      background-color: var(--secondary-hover);
    }

    .autocomplete-item.active {
      background-color: var(--secondary-bg);
    }

    .autocomplete-item .token {
      font-family: monospace;
      font-size: 12px;
    }

    .autocomplete-item .desc {
      font-size: 10px;
      opacity: 0.7;
    }

    button {
      border-radius: 4px;
      border: none;
      font-size: 12px;
      padding: 0.25rem 0.5rem;
      cursor: pointer;
      background-color: var(--accent);
      color: var(--accent-fg);
      white-space: nowrap;
    }

    button:hover {
      background-color: var(--accent-hover);
    }

    .btn-delete {
      background-color: var(--danger);
      color: var(--danger-fg);
    }

    .btn-delete:hover {
      background-color: var(--danger-hover);
    }

    .btn-secondary {
      background-color: var(--secondary-bg);
      color: var(--secondary-fg);
    }

    .btn-secondary:hover {
      background-color: var(--secondary-hover);
    }

    .commands-list {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      border-radius: 6px;
      border: 1px solid var(--border);
      padding: 0.35rem;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      min-width: 0;
    }

    .empty {
      font-size: 12px;
      opacity: 0.6;
      text-align: center;
      padding: 0.5rem 0.25rem;
    }

    .command-item {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      padding: 0.3rem;
      border-radius: 4px;
      border: 1px solid var(--border);
      background-color: var(--surface);
    }

    .command-main-row {
      display: flex;
      gap: 0.25rem;
      align-items: center;
      min-width: 0;
    }

    .command-run-btn {
      flex: 1;
      min-width: 0;
      text-align: left;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .command-meta {
      font-family: monospace;
      font-size: 11px;
      opacity: 0.7;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .command-controls {
      display: flex;
      gap: 0.25rem;
      justify-content: flex-end;
      margin-top: 0.1rem;
    }

    .note {
      font-size: 11px;
      opacity: 0.6;
    }

  </style>
</head>
<body>
  <div class="panel" id="mainPanel">
    <div class="grid-section">
      <button class="collapse-toggle" id="collapseToggle" title="Collapse everything but the grid">-</button>
      <div class="grid-controls">
        <label>Cols:</label>
        <button class="toggle-btn" id="cols1Btn">1</button>
        <button class="toggle-btn active" id="cols2Btn">2</button>
        <button class="toggle-btn" id="cols3Btn">3</button>
        <button class="toggle-btn" id="cols4Btn">4</button>
        <label style="margin-left: 0.25rem;">Position:</label>
        <button class="toggle-btn active" id="posTopBtn">Top</button>
        <button class="toggle-btn" id="posBotBtn">Bottom</button>
        <label style="margin-left: 0.25rem;">Run:</label>
        <button class="toggle-btn active" id="modeEnterAllBtn">Copy + Enter</button>
        <button class="toggle-btn" id="modeClipboardAllBtn">Copy only to clipboard</button>
        <button class="toggle-btn" id="modeTerminalAllBtn">Copy only to terminal</button>
        <button class="toggle-btn" id="modeDynamicAllBtn">Dynamic Input</button>
      </div>
      <div id="commandsGrid" class="commands-grid cols-2">
        <div class="grid-empty">No commands yet</div>
      </div>
    </div>

    <div class="list-section">
      <div id="commandsList" class="commands-list">
        <div class="empty">No commands yet. Add one below.</div>
      </div>
      <div class="add-form">
        <div class="preset-library">
          <div class="preset-library-header">
            <div>
              <div class="preset-library-title">Preset library</div>
              <div class="preset-library-subtitle">
                Search shared presets and your saved presets stored locally.
              </div>
            </div>
            <div class="preset-library-search">
              <input
                id="presetSearchInput"
                type="text"
                placeholder="Search presets..."
              />
              <button
                id="presetSearchClear"
                class="btn-secondary"
                title="Clear search"
              >
                Clear
              </button>
            </div>
          </div>
          <div class="preset-filters">
            <div class="preset-filter">
              <label for="presetEnvironmentSelect">Environment</label>
              <select id="presetEnvironmentSelect"></select>
            </div>
            <div class="preset-filter">
              <label for="presetLanguageSelect">Language</label>
              <select id="presetLanguageSelect"></select>
            </div>
            <div class="preset-filter">
              <label for="presetScopeSelect">Scope</label>
              <select id="presetScopeSelect">
                <option value="all">All presets</option>
                <option value="library">Library only</option>
                <option value="mine">My presets</option>
              </select>
            </div>
          </div>
          <div id="presetLibrarySummary" class="preset-library-summary"></div>
          <div id="presetLibraryList" class="preset-library-list" role="list"></div>
        </div>
        <div class="preset-row preset-row-tools">
          <button
            id="presetAddBtn"
            title="Save the current inputs to My Presets (stored locally)"
          >
            Save to My Presets
          </button>
          <button
            id="presetRestoreBtn"
            class="btn-secondary"
            title="Restore default presets"
          >
            Restore defaults
          </button>
        </div>
        <div class="add-row">
          <input
            id="labelInput"
            type="text"
            placeholder="Label (optional, e.g. Build)"
          />
        </div>
        <div class="add-row">
          <div class="autocomplete" id="commandAutocomplete">
            <textarea
              id="commandInput"
              rows="3"
              placeholder="Command (paste multi-line, Ctrl+Enter to add)"
            ></textarea>
            <div
              id="commandSuggestions"
              class="autocomplete-menu"
              role="listbox"
            ></div>
          </div>
          <button id="addBtn">Add</button>
        </div>
        <div class="note">
          Label is optional. Use the run-mode toggles to switch between "Copy + Enter", "Copy only to clipboard", "Copy only to terminal", or "Dynamic Input" (commands containing <code>\${input}</code> will prompt for a value). For multi-line commands, press Ctrl+Enter (Cmd+Enter on macOS) to add.
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const labelInput = document.getElementById('labelInput');
    const commandInput = document.getElementById('commandInput');
    const commandAutocomplete = document.getElementById('commandAutocomplete');
    const commandSuggestions = document.getElementById('commandSuggestions');
    const addBtn = document.getElementById('addBtn');
    const commandsList = document.getElementById('commandsList');
    const commandsGrid = document.getElementById('commandsGrid');
    const mainPanel = document.getElementById('mainPanel');
    const presetEnvironmentSelect = document.getElementById('presetEnvironmentSelect');
    const presetLanguageSelect = document.getElementById('presetLanguageSelect');
    const presetSearchInput = document.getElementById('presetSearchInput');
    const presetSearchClear = document.getElementById('presetSearchClear');
    const presetScopeSelect = document.getElementById('presetScopeSelect');
    const presetLibrarySummary = document.getElementById('presetLibrarySummary');
    const presetLibraryList = document.getElementById('presetLibraryList');
    const presetAddBtn = document.getElementById('presetAddBtn');
    const presetRestoreBtn = document.getElementById('presetRestoreBtn');

    const cols1Btn = document.getElementById('cols1Btn');
    const cols2Btn = document.getElementById('cols2Btn');
    const cols3Btn = document.getElementById('cols3Btn');
    const cols4Btn = document.getElementById('cols4Btn');
    const posTopBtn = document.getElementById('posTopBtn');
    const posBotBtn = document.getElementById('posBotBtn');
    const modeEnterAllBtn = document.getElementById('modeEnterAllBtn');
    const modeClipboardAllBtn = document.getElementById('modeClipboardAllBtn');
    const modeTerminalAllBtn = document.getElementById('modeTerminalAllBtn');
    const modeDynamicAllBtn = document.getElementById('modeDynamicAllBtn');
    const collapseToggle = document.getElementById('collapseToggle');

    let savedPresets = normalizePresetsForView(${JSON.stringify(this._presets)});
    let presetReferenceLibrary = normalizeReferenceLibrary(
      ${JSON.stringify(this._presetLibrary)}
    );
    const PLACEHOLDER_TOKEN = '\${input}';
    const COMMAND_PLACEHOLDERS = [
      { token: '\${file}', description: 'active file path.' },
      { token: '\${fileBasename}', description: 'active file basename.' },
      {
        token: '\${fileBasenameNoExtension}',
        description: 'active file basename with no extension.'
      },
      { token: '\${fileDirname}', description: 'active file directory name.' },
      { token: '\${fileExtname}', description: 'active file extension.' },
      { token: '\${lineNumber}', description: 'first selected line number.' },
      {
        token: '\${lineNumbers}',
        description: 'all selected line numbers, e.g. 41,46,80.'
      },
      { token: '\${columnNumber}', description: 'first selected column number.' },
      {
        token: '\${columnNumbers}',
        description: 'all selected column numbers, e.g. 41,46,80.'
      },
      {
        token: '\${selectedFile}',
        description: 'first selected file or folder from the context menu.'
      },
      {
        token: '\${selectedFiles}',
        description:
          'selected file or folder list from the context menu or config, e.g. "path/to/file1" "path/to/file2".'
      },
      { token: '\${selectedText}', description: 'first selected text.' },
      {
        token: '\${selectedTextList}',
        description: 'all selected text, e.g. sl1 sl2.'
      },
      {
        token: '\${selectedTextSection}',
        description: 'all selected text sections, e.g. sl1\\nsl2.'
      },
      {
        token: '\${selectedPosition}',
        description: 'selected position, e.g. 21,6.'
      },
      {
        token: '\${selectedPositionList}',
        description: 'all selected positions, e.g. 45,6 80,18 82,5.'
      },
      {
        token: '\${selectedLocation}',
        description: 'first selected location, e.g. 21,6,21,10.'
      },
      {
        token: '\${selectedLocationList}',
        description:
          'all selected locations, e.g. 21,6,21,10 22,6,22,10 23,6,23,10.'
      },
      { token: '\${relativeFile}', description: 'active file relative path.' },
      {
        token: '\${workspaceFolder}',
        description: 'active workspace folder path.'
      },
      {
        token: '\${workspaceFolderBasename}',
        description: 'active workspace folder basename.'
      },
      { token: '\${homedir}', description: 'home directory of the current user.' },
      { token: '\${tmpdir}', description: 'default directory for temporary files.' },
      { token: '\${platform}', description: 'OS platform.' },
      { token: '\${env:PATH}', description: 'value of the PATH environment variable.' },
      {
        token: '\${config:editor.fontSize}',
        description: 'VS Code setting value.'
      },
      {
        token: '\${command:workbench.action.terminal.clear}',
        description: 'run a VS Code command.'
      },
      { token: '\${input}', description: 'prompt for a value as a parameter.' },
      {
        token: '\${input:defaultValue}',
        description: 'prompt for a value with a default.'
      }
    ];
    const MODE_SEQUENCE = ['enter', 'clipboard', 'terminal', 'dynamic'];
    const initialAccent = ${JSON.stringify(accent)};

    let viewState = typeof vscode.getState === 'function' ? vscode.getState() || {} : {};
    const cachedCommands = Array.isArray(viewState.commands) ? viewState.commands : [];
    const cachedPresets = Array.isArray(viewState.presets) ? viewState.presets : [];
    let selectedEnvironmentId =
      typeof viewState.presetEnvironmentId === 'string'
        ? viewState.presetEnvironmentId
        : '';
    let selectedLanguageId =
      typeof viewState.presetLanguageId === 'string' ? viewState.presetLanguageId : '';
    let presetSearchQuery =
      typeof viewState.presetSearchQuery === 'string' ? viewState.presetSearchQuery : '';
    let presetScope =
      typeof viewState.presetScope === 'string' ? viewState.presetScope : 'all';
    if (!['all', 'library', 'mine'].includes(presetScope)) {
      presetScope = 'all';
    }
    let commands = normalizeCommandsForView(cachedCommands);
    let gridColumns = 2;
    if (Number.isInteger(viewState.gridColumns)) {
      const storedColumns = Number(viewState.gridColumns);
      if (storedColumns >= 1 && storedColumns <= 4) {
        gridColumns = storedColumns;
      }
    }
    let gridPosition = viewState.gridPosition === 'bottom' ? 'bottom' : 'top';
    let dragIndex = null;
    let globalRunMode = 'enter';
    let isCollapsed = Boolean(viewState.collapsed);
    let commandSuggestionItems = [];
    let activeCommandSuggestion = -1;
    let commandSuggestionTrigger = null;

    if (cachedPresets.length) {
      savedPresets = normalizePresetsForView(cachedPresets);
    }

    if (presetSearchInput) {
      presetSearchInput.value = presetSearchQuery;
    }
    if (presetScopeSelect) {
      presetScopeSelect.value = presetScope;
    }
    populatePresetFilters();
    setCollapsed(isCollapsed);
    setGridColumns(gridColumns);
    setGridPosition(gridPosition);
    applyAccentColors(initialAccent);
    if (commands.length) {
      updateGlobalModeFromCommands();
      renderCommands();
    }

    commandsGrid.addEventListener('dragover', handleGridDragOver);
    commandsGrid.addEventListener('drop', handleGridDrop);

    collapseToggle?.addEventListener('click', () => {
      setCollapsed(!isCollapsed);
    });

    function persistViewState(partial) {
      if (typeof vscode.setState !== 'function') {
        return;
      }
      viewState = { ...viewState, ...partial };
      vscode.setState(viewState);
    }

    function applyAccentColors(accentColors) {
      if (!accentColors || typeof accentColors !== 'object') {
        return;
      }
      const root = document.documentElement;
      if (accentColors.accent) {
        root.style.setProperty('--accent', accentColors.accent);
      }
      if (accentColors.accentHover) {
        root.style.setProperty('--accent-hover', accentColors.accentHover);
      }
      if (accentColors.accentFg) {
        root.style.setProperty('--accent-fg', accentColors.accentFg);
      }
    }

    function setCollapsed(collapsed) {
      isCollapsed = collapsed;
      if (mainPanel) {
        mainPanel.classList.toggle('grid-only', collapsed);
      }
      document.body.classList.toggle('grid-only-mode', collapsed);
      document.documentElement.classList.toggle('grid-only-mode', collapsed);
      if (collapseToggle) {
        collapseToggle.textContent = collapsed ? '+' : '-';
        collapseToggle.setAttribute(
          'aria-label',
          collapsed ? 'Expand panels' : 'Collapse panels'
        );
        collapseToggle.title = collapsed
          ? 'Expand configuration panels'
          : 'Collapse everything except the grid';
      }
      persistViewState({ collapsed });
    }

    function normalizeRunMode(runMode, addNewLine) {
      if (MODE_SEQUENCE.includes(runMode)) {
        return runMode;
      }
      if (runMode === 'copy') {
        return 'clipboard';
      }
      if (addNewLine === false) {
        return 'clipboard';
      }
      return 'enter';
    }

    function shouldSendEnter(runMode) {
      return runMode === 'enter' || runMode === 'dynamic';
    }

    function getRunMode(cmd) {
      if (!cmd) {
        return 'enter';
      }
      return normalizeRunMode(cmd.runMode, cmd.addNewLine);
    }

    function normalizeCommandsForView(list) {
      if (!Array.isArray(list)) {
        return [];
      }
      return list.map((cmd) => {
        const runMode = getRunMode(cmd);
        return {
          ...cmd,
          runMode,
          addNewLine: shouldSendEnter(runMode),
          inputValue: cmd.inputValue ?? ''
        };
      });
    }

    function normalizePresetsForView(list) {
      if (!Array.isArray(list)) {
        return [];
      }
      const normalized = [];
      for (const preset of list) {
        const text = String(preset?.text ?? '').trim();
        if (!text) {
          continue;
        }
        const label = String(preset?.label ?? text).trim() || text;
        const id = String(preset?.id ?? '');
        normalized.push({ id, label, text });
      }
      return normalized;
    }

    function normalizeReferenceLibrary(library) {
      return {
        environments: normalizeReferenceGroups(library?.environments),
        languages: normalizeReferenceGroups(library?.languages)
      };
    }

    function normalizeReferenceGroups(groups) {
      if (!Array.isArray(groups)) {
        return [];
      }
      const normalized = [];
      for (const group of groups) {
        const id = String(group?.id ?? '').trim();
        if (!id) {
          continue;
        }
        const label = String(group?.label ?? id).trim() || id;
        const categories = normalizeReferenceCategories(group?.categories);
        if (!categories.length) {
          continue;
        }
        normalized.push({ id, label, categories });
      }
      return normalized;
    }

    function normalizeReferenceCategories(categories) {
      if (!Array.isArray(categories)) {
        return [];
      }
      const normalized = [];
      for (const category of categories) {
        const id = String(category?.id ?? '').trim();
        if (!id) {
          continue;
        }
        const label = String(category?.label ?? id).trim() || id;
        const commands = normalizeReferenceCommands(category?.commands);
        if (!commands.length) {
          continue;
        }
        normalized.push({ id, label, commands });
      }
      return normalized;
    }

    function normalizeReferenceCommands(list) {
      if (!Array.isArray(list)) {
        return [];
      }
      const normalized = [];
      for (const entry of list) {
        const command = String(entry?.command ?? '').trim();
        if (!command) {
          continue;
        }
        const description = String(entry?.description ?? '').trim();
        normalized.push({
          command,
          description
        });
      }
      return normalized;
    }

    function normalizeCommandText(value) {
      const raw = String(value ?? '');
      return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }

    function updatePresetFilterAvailability() {
      if (!presetEnvironmentSelect || !presetLanguageSelect) {
        return;
      }
      const envCount = Array.isArray(presetReferenceLibrary.environments)
        ? presetReferenceLibrary.environments.length
        : 0;
      const langCount = Array.isArray(presetReferenceLibrary.languages)
        ? presetReferenceLibrary.languages.length
        : 0;
      const disableFilters = presetScope === 'mine';
      presetEnvironmentSelect.disabled = disableFilters || envCount === 0;
      presetLanguageSelect.disabled = disableFilters || langCount === 0;
    }

    function populatePresetFilters() {
      if (!presetEnvironmentSelect || !presetLanguageSelect) {
        return;
      }
      const environments = Array.isArray(presetReferenceLibrary.environments)
        ? presetReferenceLibrary.environments
        : [];
      const languages = Array.isArray(presetReferenceLibrary.languages)
        ? presetReferenceLibrary.languages
        : [];

      if (selectedEnvironmentId && !hasGroup(environments, selectedEnvironmentId)) {
        selectedEnvironmentId = '';
      }
      if (selectedLanguageId && !hasGroup(languages, selectedLanguageId)) {
        selectedLanguageId = '';
      }

      if (!selectedEnvironmentId && environments.length === 1) {
        selectedEnvironmentId = environments[0].id;
      }
      if (!selectedLanguageId && languages.length === 1) {
        selectedLanguageId = languages[0].id;
      }

      fillSelect(
        presetEnvironmentSelect,
        environments,
        'Select environment...'
      );
      fillSelect(presetLanguageSelect, languages, 'Select language...');

      presetEnvironmentSelect.value = selectedEnvironmentId || '';
      presetLanguageSelect.value = selectedLanguageId || '';

      if (presetScopeSelect) {
        presetScopeSelect.value = presetScope;
      }

      persistViewState({
        presetEnvironmentId: selectedEnvironmentId,
        presetLanguageId: selectedLanguageId
      });

      updatePresetFilterAvailability();
      renderPresetLibrary();
    }

    function fillSelect(select, groups, placeholderText) {
      select.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = placeholderText;
      select.appendChild(placeholder);

      groups.forEach((group) => {
        const opt = document.createElement('option');
        opt.value = group.id;
        opt.textContent = group.label || group.id;
        select.appendChild(opt);
      });
    }

    function hasGroup(groups, groupId) {
      if (!Array.isArray(groups)) {
        return false;
      }
      return groups.some((group) => group.id === groupId);
    }

    function findGroup(groups, groupId) {
      if (!Array.isArray(groups)) {
        return null;
      }
      return groups.find((group) => group.id === groupId) || null;
    }

    function getPresetScopeLabel() {
      if (presetScope === 'mine') {
        return 'My presets';
      }
      if (presetScope === 'library') {
        return 'Library only';
      }
      return 'All presets';
    }

    function matchesPresetSearch(cmd, query) {
      if (!query) {
        return true;
      }
      const label = String(cmd?.label ?? '');
      const description = String(cmd?.description ?? '');
      const command = String(cmd?.command ?? '');
      const haystack = (label + ' ' + description + ' ' + command).toLowerCase();
      return haystack.includes(query);
    }

    function filterGroupByQuery(group, query) {
      if (!group) {
        return null;
      }
      if (!query) {
        return group;
      }
      const categories = group.categories
        .map((category) => {
          const commands = category.commands.filter((cmd) =>
            matchesPresetSearch(cmd, query)
          );
          if (!commands.length) {
            return null;
          }
          return { ...category, commands };
        })
        .filter(Boolean);
      if (!categories.length) {
        return null;
      }
      return { ...group, categories };
    }

    function countGroupCommands(group) {
      if (!group || !Array.isArray(group.categories)) {
        return 0;
      }
      return group.categories.reduce((total, category) => {
        if (!category || !Array.isArray(category.commands)) {
          return total;
        }
        return total + category.commands.length;
      }, 0);
    }

    function buildCustomPresetGroup() {
      if (!Array.isArray(savedPresets) || !savedPresets.length) {
        return null;
      }
      const sorted = [...savedPresets].sort((a, b) => {
        const labelA = (a?.label || a?.text || '').toLowerCase();
        const labelB = (b?.label || b?.text || '').toLowerCase();
        return labelA.localeCompare(labelB);
      });
      const commands = sorted.map((preset) => ({
        command: preset.text,
        description:
          preset.label && preset.label !== preset.text ? preset.label : undefined,
        presetId: preset.id,
        isCustom: true,
        label: preset.label || preset.text,
        preset
      }));
      return {
        id: 'my_presets',
        label: 'My Presets',
        categories: [
          {
            id: 'saved',
            label: 'Saved presets',
            commands
          }
        ]
      };
    }

    function updatePresetLibrarySummary(totalCount, groupCount) {
      if (!presetLibrarySummary) {
        return;
      }
      const parts = [];
      if (Number.isInteger(totalCount)) {
        const label = totalCount === 1 ? 'preset' : 'presets';
        parts.push(String(totalCount) + ' ' + label);
      }
      if (Number.isInteger(groupCount)) {
        const label = groupCount === 1 ? 'group' : 'groups';
        parts.push(String(groupCount) + ' ' + label);
      }
      parts.push('Scope: ' + getPresetScopeLabel());
      if (presetScope === 'mine') {
        parts.push('Stored locally');
      }
      const trimmed = String(presetSearchQuery ?? '').trim();
      if (trimmed) {
        parts.push('Search: "' + trimmed + '"');
      }
      presetLibrarySummary.textContent = parts.join(' • ');
    }

    function renderPresetLibrary() {
      if (!presetLibraryList) {
        return;
      }
      presetLibraryList.innerHTML = '';

      const environments = Array.isArray(presetReferenceLibrary.environments)
        ? presetReferenceLibrary.environments
        : [];
      const languages = Array.isArray(presetReferenceLibrary.languages)
        ? presetReferenceLibrary.languages
        : [];
      const hasLibrary = environments.length > 0 || languages.length > 0;
      const rawQuery = String(presetSearchQuery ?? '').trim();
      const query = rawQuery.toLowerCase();
      const searchAll = Boolean(query) && !selectedEnvironmentId && !selectedLanguageId;
      const selections = [];

      if (presetScope !== 'library') {
        const customGroup = buildCustomPresetGroup();
        if (customGroup) {
          selections.push({ kind: 'My Presets', group: customGroup, isCustom: true });
        }
      }

      if (presetScope !== 'mine') {
        if (!hasLibrary && presetScope === 'library') {
          renderPresetLibraryEmpty('Preset library not found.');
          updatePresetLibrarySummary(0, 0);
          return;
        }

        if (searchAll) {
          environments.forEach((group) => {
            selections.push({ kind: 'Environment', group });
          });
          languages.forEach((group) => {
            selections.push({ kind: 'Language', group });
          });
        } else {
          if (selectedEnvironmentId) {
            const envGroup = findGroup(environments, selectedEnvironmentId);
            if (envGroup) {
              selections.push({ kind: 'Environment', group: envGroup });
            }
          }
          if (selectedLanguageId) {
            const langGroup = findGroup(languages, selectedLanguageId);
            if (langGroup) {
              selections.push({ kind: 'Language', group: langGroup });
            }
          }
        }
      }

      if (!selections.length) {
        if (presetScope === 'mine') {
          renderPresetLibraryEmpty('No saved presets yet.');
        } else if (!hasLibrary) {
          renderPresetLibraryEmpty('Preset library not found.');
        } else if (query) {
          renderPresetLibraryEmpty('No presets match "' + rawQuery + '".');
        } else {
          renderPresetLibraryEmpty(
            'Select an environment or language, or search to browse presets.'
          );
        }
        updatePresetLibrarySummary(0, 0);
        return;
      }

      let totalMatches = 0;
      let groupMatches = 0;

      selections.forEach((selection) => {
        const filteredGroup = filterGroupByQuery(selection.group, query);
        if (!filteredGroup) {
          return;
        }

        const groupCount = countGroupCommands(filteredGroup);
        if (!groupCount) {
          return;
        }

        totalMatches += groupCount;
        groupMatches += 1;

        const groupEl = document.createElement('div');
        groupEl.className = 'preset-group';

        const title = document.createElement('div');
        title.className = 'preset-group-title';
        const titleText =
          selection.kind === 'My Presets'
            ? filteredGroup.label || filteredGroup.id
            : selection.kind + ': ' + (filteredGroup.label || filteredGroup.id);
        title.textContent = titleText;

        const countEl = document.createElement('span');
        countEl.className = 'count';
        countEl.textContent = String(groupCount);
        title.appendChild(countEl);
        groupEl.appendChild(title);

        filteredGroup.categories.forEach((category) => {
          const categoryEl = document.createElement('div');
          categoryEl.className = 'preset-category';

          const categoryTitle = document.createElement('div');
          categoryTitle.className = 'preset-category-title';
          categoryTitle.textContent = category.label || category.id;
          categoryEl.appendChild(categoryTitle);

          category.commands.forEach((cmd) => {
            if (cmd.isCustom) {
              const item = document.createElement('div');
              item.className = 'preset-item preset-item-custom';
              item.title = cmd.label
                ? cmd.label + ' - ' + cmd.command
                : cmd.command;

              const header = document.createElement('div');
              header.className = 'preset-item-header';

              const label = document.createElement('div');
              label.className = 'preset-item-label';
              label.textContent = cmd.label || cmd.command;
              header.appendChild(label);

              const actions = document.createElement('div');
              actions.className = 'preset-item-actions';

              const useBtn = document.createElement('button');
              useBtn.type = 'button';
              useBtn.className = 'btn-secondary btn-xs';
              useBtn.textContent = 'Use';
              useBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                applySavedPreset(cmd.preset);
              });

              const removeBtn = document.createElement('button');
              removeBtn.type = 'button';
              removeBtn.className = 'btn-delete btn-xs';
              removeBtn.textContent = 'Remove';
              removeBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                removeSavedPreset(cmd.presetId);
              });

              actions.appendChild(useBtn);
              actions.appendChild(removeBtn);
              header.appendChild(actions);
              item.appendChild(header);

              const commandLine = document.createElement('div');
              commandLine.className = 'command';
              commandLine.textContent = cmd.command;
              item.appendChild(commandLine);

              item.addEventListener('click', () => {
                applySavedPreset(cmd.preset);
              });

              categoryEl.appendChild(item);
              return;
            }

            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'preset-item';
            item.title = cmd.description
              ? cmd.command + ' - ' + cmd.description
              : cmd.command;

            const commandLine = document.createElement('div');
            commandLine.className = 'command';
            commandLine.textContent = cmd.command;
            item.appendChild(commandLine);

            if (cmd.description) {
              const desc = document.createElement('div');
              desc.className = 'description';
              desc.textContent = cmd.description;
              item.appendChild(desc);
            }

            item.addEventListener('click', () => {
              applyReferencePreset(cmd.command, cmd.description);
            });

            categoryEl.appendChild(item);
          });

          groupEl.appendChild(categoryEl);
        });

        presetLibraryList.appendChild(groupEl);
      });

      if (groupMatches === 0) {
        renderPresetLibraryEmpty(
          query ? ('No presets match "' + rawQuery + '".') : 'No presets found.'
        );
        updatePresetLibrarySummary(0, 0);
        return;
      }

      updatePresetLibrarySummary(totalMatches, groupMatches);
    }

    function renderPresetLibraryEmpty(message) {
      if (!presetLibraryList) {
        return;
      }
      const empty = document.createElement('div');
      empty.className = 'preset-library-empty';
      empty.textContent = message;
      presetLibraryList.appendChild(empty);
    }

    function applyReferencePreset(command, description) {
      if (!commandInput || !labelInput) {
        return;
      }
      const trimmedCommand = String(command ?? '').trim();
      if (!trimmedCommand) {
        return;
      }
      const desc = String(description ?? '').trim();
      const label =
        desc && desc.length <= 40 ? desc : trimmedCommand;
      labelInput.value = label;
      commandInput.value = trimmedCommand;
      hideCommandSuggestions();
      commandInput.focus();
    }

    function getModeLabel(runMode) {
      if (runMode === 'clipboard') {
        return 'Copy only to clipboard';
      }
      if (runMode === 'terminal') {
        return 'Copy only to terminal';
      }
      if (runMode === 'dynamic') {
        return 'Dynamic Input';
      }
      return 'Copy + Enter';
    }

    function resolveCommandText(cmd) {
      const mode = getRunMode(cmd);
      if (mode === 'dynamic') {
        const value = cmd.inputValue ?? '';
        return (cmd.text || '').split(PLACEHOLDER_TOKEN).join(value);
      }
      return cmd.text;
    }

    function getNextMode(current) {
      const index = MODE_SEQUENCE.indexOf(current);
      if (index === -1 || index === MODE_SEQUENCE.length - 1) {
        return MODE_SEQUENCE[0];
      }
      return MODE_SEQUENCE[index + 1];
    }

    function setCommandMode(commandId, runMode) {
      commands = commands.map((cmd) =>
        cmd.id === commandId
          ? { ...cmd, runMode, addNewLine: shouldSendEnter(runMode) }
          : cmd
      );
      updateGlobalModeFromCommands();
      renderGrid();
      renderCommands();
      vscode.postMessage({ type: 'updateCommandMode', id: commandId, runMode });
    }

    function cycleCommandMode(commandId) {
      const target = commands.find((cmd) => cmd.id === commandId);
      const nextMode = getNextMode(getRunMode(target));
      setCommandMode(commandId, nextMode);
    }

    function updateModeButtons() {
      modeEnterAllBtn?.classList.toggle('active', globalRunMode === 'enter');
      modeClipboardAllBtn?.classList.toggle('active', globalRunMode === 'clipboard');
      modeTerminalAllBtn?.classList.toggle('active', globalRunMode === 'terminal');
      modeDynamicAllBtn?.classList.toggle('active', globalRunMode === 'dynamic');
    }

    function createDynamicInput(cmd) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'dynamic-input';
      input.value = cmd.inputValue ?? '';
      input.placeholder = 'Value to insert';
      input.dataset.commandId = cmd.id;
      input.addEventListener('click', (event) => event.stopPropagation());
      input.addEventListener('mousedown', (event) => event.stopPropagation());
      input.addEventListener('input', (event) => {
        const target = event.target;
        const value = target instanceof HTMLInputElement ? target.value : input.value;
        updateCommandInputValue(cmd.id, value, input);
      });
      return input;
    }

    function updateCommandInputValue(commandId, inputValue, sourceEl) {
      commands = commands.map((cmd) =>
        cmd.id === commandId ? { ...cmd, inputValue } : cmd
      );
      syncDynamicInputs(commandId, inputValue, sourceEl);
      vscode.postMessage({
        type: 'updateCommandInput',
        id: commandId,
        inputValue
      });
    }

    function syncDynamicInputs(commandId, inputValue, sourceEl) {
      const inputs = document.querySelectorAll(
        \`.dynamic-input[data-command-id="\${commandId}"]\`
      );
      inputs.forEach((input) => {
        if (input === sourceEl) {
          return;
        }
        if (input instanceof HTMLInputElement) {
          input.value = inputValue;
        }
      });
    }

    function renderGrid() {
      commandsGrid.className = \`commands-grid cols-\${gridColumns}\`;
      commandsGrid.innerHTML = '';

      if (!commands.length) {
        const empty = document.createElement('div');
        empty.className = 'grid-empty';
        empty.textContent = 'No commands yet';
        commandsGrid.appendChild(empty);
        return;
      }

      commands.forEach((cmd, index) => {
        const runMode = getRunMode(cmd);
        const wrapper = document.createElement('div');
        wrapper.className = 'grid-button-wrapper';
        wrapper.dataset.index = String(index);

        const btn = document.createElement('button');
        btn.className = 'grid-button';
        btn.textContent = cmd.label;
        btn.title = cmd.text;
        btn.dataset.index = String(index);
        btn.draggable = true;
        btn.addEventListener('click', () => {
          vscode.postMessage({
            type: 'runCommand',
            text: resolveCommandText(cmd),
            runMode
          });
        });
        btn.addEventListener('dragstart', handleDragStart);
        btn.addEventListener('dragend', handleDragEnd);
        wrapper.appendChild(btn);

        const modeChip = document.createElement('button');
        modeChip.className = \`mode-chip mode-\${runMode}\`;
        modeChip.textContent = getModeLabel(runMode);
        modeChip.title = 'Click to cycle through run modes';
        modeChip.addEventListener('click', (event) => {
          event.stopPropagation();
          cycleCommandMode(cmd.id);
        });
        wrapper.appendChild(modeChip);

        if (runMode === 'dynamic') {
          const dynamicInput = createDynamicInput(cmd);
          wrapper.appendChild(dynamicInput);
        }

        commandsGrid.appendChild(wrapper);
      });
    }

    function renderCommands() {
      commandsList.innerHTML = '';

      if (!commands.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No commands yet. Add one below.';
        commandsList.appendChild(empty);
        return;
      }

      for (const cmd of commands) {
        const runMode = getRunMode(cmd);
        const item = document.createElement('div');
        item.className = 'command-item';

        const mainRow = document.createElement('div');
        mainRow.className = 'command-main-row';

        const runBtn = document.createElement('button');
        runBtn.className = 'command-run-btn';
        runBtn.textContent = cmd.label;
        runBtn.title = cmd.text;
        runBtn.addEventListener('click', () => {
          vscode.postMessage({
            type: 'runCommand',
            text: resolveCommandText(cmd),
            runMode
          });
        });

        const meta = document.createElement('div');
        meta.className = 'command-meta';
        meta.textContent = cmd.text;

        mainRow.appendChild(runBtn);

        const controls = document.createElement('div');
        controls.className = 'command-controls';

        const modeBtn = document.createElement('button');
        modeBtn.className = \`mode-toggle small mode-\${runMode}\`;
        modeBtn.textContent = getModeLabel(runMode);
        modeBtn.title = 'Click to cycle through run modes';
        modeBtn.addEventListener('click', () => {
          cycleCommandMode(cmd.id);
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn-delete';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'deleteCommand', id: cmd.id });
        });

        controls.appendChild(modeBtn);
        controls.appendChild(deleteBtn);

        item.appendChild(mainRow);
        item.appendChild(meta);
        item.appendChild(controls);

        if (runMode === 'dynamic') {
          const dynRow = document.createElement('div');
          dynRow.className = 'command-dynamic-row';
          const dynLabel = document.createElement('label');
          dynLabel.textContent = 'Dynamic value';
          const dynInput = createDynamicInput(cmd);
          dynRow.appendChild(dynLabel);
          dynRow.appendChild(dynInput);
          item.appendChild(dynRow);
        }

        commandsList.appendChild(item);
      }
    }

    function getCommandTrigger(value, cursorPos) {
      if (typeof cursorPos !== 'number') {
        return null;
      }
      const beforeCursor = value.slice(0, cursorPos);
      const dollarIndex = beforeCursor.lastIndexOf('$');
      if (dollarIndex === -1) {
        return null;
      }
      const token = beforeCursor.slice(dollarIndex + 1);
      if (
        token.includes(' ') ||
        token.includes('\t') ||
        token.includes('}') ||
        token.includes('\n') ||
        token.includes('\r')
      ) {
        return null;
      }
      const query = token.startsWith('{') ? token.slice(1) : token;
      return { start: dollarIndex, end: cursorPos, query };
    }

    function getMatchingCommandPlaceholders(query) {
      if (!query) {
        return COMMAND_PLACEHOLDERS;
      }
      const normalized = query.toLowerCase();
      return COMMAND_PLACEHOLDERS.filter((item) => {
        const token = item.token.toLowerCase();
        const desc = item.description.toLowerCase();
        return token.includes(normalized) || desc.includes(normalized);
      });
    }

    function hideCommandSuggestions() {
      if (!commandSuggestions) {
        return;
      }
      commandSuggestions.classList.remove('visible');
      commandSuggestions.innerHTML = '';
      commandSuggestionItems = [];
      activeCommandSuggestion = -1;
      commandSuggestionTrigger = null;
    }

    function setActiveCommandSuggestion(index) {
      if (!commandSuggestions) {
        return;
      }
      const items = commandSuggestions.querySelectorAll('.autocomplete-item');
      items.forEach((item, itemIndex) => {
        item.classList.toggle('active', itemIndex === index);
      });
      activeCommandSuggestion = index;
    }

    function insertCommandSuggestion(token) {
      if (!commandSuggestionTrigger || !commandInput) {
        return;
      }
      const value = commandInput.value;
      const start = commandSuggestionTrigger.start;
      const end =
        typeof commandInput.selectionEnd === 'number'
          ? commandInput.selectionEnd
          : commandSuggestionTrigger.end;
      const nextValue = value.slice(0, start) + token + value.slice(end);
      commandInput.value = nextValue;
      const cursor = start + token.length;
      commandInput.setSelectionRange(cursor, cursor);
      hideCommandSuggestions();
      commandInput.focus();
    }

    function renderCommandSuggestions(items, trigger) {
      if (!commandSuggestions) {
        return;
      }
      commandSuggestions.innerHTML = '';
      commandSuggestionItems = items;
      commandSuggestionTrigger = trigger;

      items.forEach((item, index) => {
        const option = document.createElement('div');
        option.className = 'autocomplete-item';
        option.dataset.index = String(index);

        const token = document.createElement('div');
        token.className = 'token';
        token.textContent = item.token;

        const desc = document.createElement('div');
        desc.className = 'desc';
        desc.textContent = item.description;

        option.appendChild(token);
        option.appendChild(desc);

        option.addEventListener('mouseenter', () => {
          setActiveCommandSuggestion(index);
        });
        option.addEventListener('mousedown', (event) => {
          event.preventDefault();
          insertCommandSuggestion(item.token);
        });

        commandSuggestions.appendChild(option);
      });

      commandSuggestions.classList.add('visible');
      setActiveCommandSuggestion(0);
    }

    function updateCommandSuggestions() {
      if (!commandInput || !commandSuggestions) {
        return;
      }
      const cursorPos =
        typeof commandInput.selectionStart === 'number'
          ? commandInput.selectionStart
          : commandInput.value.length;
      const trigger = getCommandTrigger(commandInput.value, cursorPos);
      if (!trigger) {
        hideCommandSuggestions();
        return;
      }
      const matches = getMatchingCommandPlaceholders(trigger.query);
      if (!matches.length) {
        hideCommandSuggestions();
        return;
      }
      renderCommandSuggestions(matches, trigger);
    }

    function handleCommandInputKeydown(event) {
      if (commandSuggestions?.classList.contains('visible')) {
        if (!commandSuggestionItems.length) {
          hideCommandSuggestions();
          return;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          const nextIndex =
            (activeCommandSuggestion + 1) % commandSuggestionItems.length;
          setActiveCommandSuggestion(nextIndex);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          const nextIndex =
            (activeCommandSuggestion - 1 + commandSuggestionItems.length) %
            commandSuggestionItems.length;
          setActiveCommandSuggestion(nextIndex);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          const activeItem = commandSuggestionItems[activeCommandSuggestion];
          if (activeItem) {
            insertCommandSuggestion(activeItem.token);
          }
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          hideCommandSuggestions();
          return;
        }
      }

      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        addCommandFromInputs();
      }
    }

    function addCommandFromInputs() {
      const label = labelInput.value.trim();
      const text = normalizeCommandText(commandInput.value);

      vscode.postMessage({ type: 'addCommand', label, text });

      if (text.trim()) {
        labelInput.value = '';
        commandInput.value = '';
        hideCommandSuggestions();
      }
    }

    function updateGlobalModeFromCommands() {
      if (!commands.length) {
        globalRunMode = 'enter';
        updateModeButtons();
        return;
      }
      const firstMode = getRunMode(commands[0]);
      const allSame = commands.every((cmd) => getRunMode(cmd) === firstMode);
      globalRunMode = allSame ? firstMode : null;
      updateModeButtons();
    }

    function toggleAllModes(runMode) {
      globalRunMode = runMode;
      commands = commands.map((cmd) => ({
        ...cmd,
        runMode,
        addNewLine: shouldSendEnter(runMode)
      }));
      renderGrid();
      renderCommands();
      updateModeButtons();
      vscode.postMessage({ type: 'updateAllCommandModes', runMode });
    }

    function applySavedPreset(preset) {
      if (!preset || !labelInput || !commandInput) {
        return;
      }
      labelInput.value = preset.label || preset.text;
      commandInput.value = preset.text;
      hideCommandSuggestions();
      commandInput.focus();
    }

    function addPresetFromInputs() {
      const label = labelInput.value.trim();
      const text = normalizeCommandText(commandInput.value);
      vscode.postMessage({ type: 'addPreset', label, text });
    }

    function removeSavedPreset(presetId) {
      if (!presetId) {
        return;
      }
      vscode.postMessage({ type: 'removePreset', id: presetId });
    }

    function restorePresetDefaults() {
      vscode.postMessage({ type: 'restorePresetDefaults' });
    }

    function setGridColumns(cols) {
      gridColumns = cols;
      [cols1Btn, cols2Btn, cols3Btn, cols4Btn].forEach(btn => btn.classList.remove('active'));
      if (cols === 1) cols1Btn.classList.add('active');
      else if (cols === 2) cols2Btn.classList.add('active');
      else if (cols === 3) cols3Btn.classList.add('active');
      else if (cols === 4) cols4Btn.classList.add('active');
      renderGrid();
      persistViewState({ gridColumns: cols });
    }

    function setGridPosition(pos) {
      gridPosition = pos;
      if (pos === 'bottom') {
        mainPanel.classList.add('grid-bottom');
        posTopBtn.classList.remove('active');
        posBotBtn.classList.add('active');
      } else {
        mainPanel.classList.remove('grid-bottom');
        posTopBtn.classList.add('active');
        posBotBtn.classList.remove('active');
      }
      persistViewState({ gridPosition: pos });
    }

    function handleDragStart(event) {
      const button = event.currentTarget;
      if (!(button instanceof HTMLElement)) {
        return;
      }
      const index = Number(button.dataset.index);
      if (Number.isNaN(index)) {
        return;
      }
      dragIndex = index;
      button.classList.add('dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(index));
      }
    }

    function handleDragEnd(event) {
      const button = event.currentTarget;
      if (button instanceof HTMLElement) {
        button.classList.remove('dragging');
      }
      dragIndex = null;
    }

    function handleGridDragOver(event) {
      if (dragIndex === null) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
    }

    function handleGridDrop(event) {
      if (dragIndex === null) {
        return;
      }
      event.preventDefault();
      let targetIndex = commands.length;
      if (event.target instanceof HTMLElement) {
        const btn = event.target.closest('.grid-button');
        if (btn && btn.dataset.index !== undefined) {
          const idx = Number(btn.dataset.index);
          if (!Number.isNaN(idx)) {
            targetIndex = idx;
          }
        } else {
          const wrapper = event.target.closest('.grid-button-wrapper');
          if (wrapper && wrapper.dataset.index !== undefined) {
            const idx = Number(wrapper.dataset.index);
            if (!Number.isNaN(idx)) {
              targetIndex = idx;
            }
          }
        }
      }
      vscode.postMessage({
        type: 'reorderCommands',
        fromIndex: dragIndex,
        toIndex: targetIndex
      });
      dragIndex = null;
    }

    cols1Btn.addEventListener('click', () => setGridColumns(1));
    cols2Btn.addEventListener('click', () => setGridColumns(2));
    cols3Btn.addEventListener('click', () => setGridColumns(3));
    cols4Btn.addEventListener('click', () => setGridColumns(4));
    posTopBtn.addEventListener('click', () => setGridPosition('top'));
    posBotBtn.addEventListener('click', () => setGridPosition('bottom'));
    modeEnterAllBtn.addEventListener('click', () => toggleAllModes('enter'));
    modeClipboardAllBtn.addEventListener('click', () => toggleAllModes('clipboard'));
    modeTerminalAllBtn.addEventListener('click', () => toggleAllModes('terminal'));
    modeDynamicAllBtn.addEventListener('click', () => toggleAllModes('dynamic'));

    presetAddBtn.addEventListener('click', () => {
      addPresetFromInputs();
    });

    presetRestoreBtn?.addEventListener('click', () => {
      restorePresetDefaults();
    });

    presetEnvironmentSelect?.addEventListener('change', () => {
      selectedEnvironmentId = presetEnvironmentSelect.value;
      persistViewState({ presetEnvironmentId: selectedEnvironmentId });
      renderPresetLibrary();
    });

    presetLanguageSelect?.addEventListener('change', () => {
      selectedLanguageId = presetLanguageSelect.value;
      persistViewState({ presetLanguageId: selectedLanguageId });
      renderPresetLibrary();
    });

    presetScopeSelect?.addEventListener('change', () => {
      presetScope = presetScopeSelect.value;
      persistViewState({ presetScope });
      updatePresetFilterAvailability();
      renderPresetLibrary();
    });

    presetSearchInput?.addEventListener('input', () => {
      presetSearchQuery = presetSearchInput.value;
      persistViewState({ presetSearchQuery });
      renderPresetLibrary();
    });

    presetSearchInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        presetSearchQuery = '';
        presetSearchInput.value = '';
        persistViewState({ presetSearchQuery });
        renderPresetLibrary();
      }
    });

    presetSearchClear?.addEventListener('click', () => {
      if (!presetSearchInput) {
        return;
      }
      presetSearchQuery = '';
      presetSearchInput.value = '';
      persistViewState({ presetSearchQuery });
      renderPresetLibrary();
      presetSearchInput.focus();
    });

    addBtn.addEventListener('click', () => {
      addCommandFromInputs();
    });

    commandInput.addEventListener('input', () => {
      updateCommandSuggestions();
    });

    commandInput.addEventListener('click', () => {
      updateCommandSuggestions();
    });

    commandInput.addEventListener('focus', () => {
      updateCommandSuggestions();
    });

    commandInput.addEventListener('keyup', (event) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        return;
      }
      if (event.key === 'Enter') {
        return;
      }
      updateCommandSuggestions();
    });

    commandInput.addEventListener('keydown', handleCommandInputKeydown);

    labelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        addCommandFromInputs();
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      switch (message.type) {
        case 'setCommands': {
          commands = normalizeCommandsForView(message.commands);
          persistViewState({ commands });
          updateGlobalModeFromCommands();
          renderGrid();
          renderCommands();
          break;
        }
        case 'setPresets': {
          savedPresets = normalizePresetsForView(message.presets);
          persistViewState({ presets: savedPresets });
          renderPresetLibrary();
          break;
        }
        case 'setPresetLibrary': {
          presetReferenceLibrary = normalizeReferenceLibrary(message.library);
          populatePresetFilters();
          break;
        }
        case 'setAccent': {
          applyAccentColors(message.accent);
          break;
        }
      }
    });

    document.addEventListener('click', (event) => {
      if (!commandAutocomplete) {
        return;
      }
      const target = event.target;
      if (target instanceof Node && commandAutocomplete.contains(target)) {
        return;
      }
      hideCommandSuggestions();
    });

    vscode.postMessage({ type: 'ready', cachedCommands: commands });
  </script>
</body>
</html>`;
    }
}
// Utility to create a nonce for CSP
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
//# sourceMappingURL=extension.js.map