import * as vscode from 'vscode';

type CommandMode = 'enter' | 'clipboard' | 'terminal' | 'dynamic';
type LegacyCommandMode = CommandMode | 'copy';

type CommandItem = {
  id: string;
  label: string;
  text: string;
  addNewLine?: boolean;
  runMode?: LegacyCommandMode;
  inputValue?: string;
};

type PresetItem = {
  id: string;
  label: string;
  text: string;
};

type AccentColorOption =
  | 'red'
  | 'pink'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'grey'
  | 'white'
  | 'black';

type AccentColors = {
  accent: string;
  accentHover: string;
  accentFg: string;
};

const CONFIG_SECTION = 'commandButtons';
const STORAGE_KEY = 'commandButtons.commands';
const PRESET_STORAGE_KEY = 'commandButtons.presets';
const PRESET_DEFAULTS: PresetItem[] = [
  { id: 'preset-npm-dev', label: 'npm dev', text: 'npm run dev' },
  { id: 'preset-npm-build', label: 'npm build', text: 'npm run build' },
  { id: 'preset-npm-test', label: 'npm test', text: 'npm test' },
  { id: 'preset-git-status', label: 'git status', text: 'git status' },
  { id: 'preset-dc-up', label: 'docker compose up', text: 'docker compose up' }
];
const ACCENT_COLORS: Record<AccentColorOption, AccentColors> = {
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

export function activate(context: vscode.ExtensionContext) {
  // Optional: allow Settings Sync to sync global commands/presets between machines
  context.globalState.setKeysForSync?.([STORAGE_KEY, PRESET_STORAGE_KEY]);

  const provider = new CommandButtonsViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'commandButtonsView',
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );
}

export function deactivate() {
  // nothing to clean up for now
}

class CommandButtonsViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _commands: CommandItem[] = [];
  private _presets: PresetItem[] = [];
  private _terminal?: vscode.Terminal;

  constructor(private readonly context: vscode.ExtensionContext) {
    this._commands = this.loadCommands();
    this._presets = this.loadPresets();
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`${CONFIG_SECTION}.accentColor`)) {
          this.postAccentColors();
        }
      })
    );
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
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
          if (
            !this._commands.length &&
            Array.isArray(message.cachedCommands) &&
            message.cachedCommands.length
          ) {
            this._commands = this.normalizeCommands(message.cachedCommands);
            await this.saveCommands();
          } else {
            this.postCommands();
          }
          this._presets = this.loadPresets();
          this.postPresets();
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
          const runMode = this.normalizeRunMode(
            message.runMode as LegacyCommandMode,
            message.addNewLine
          );
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

  private get hasWorkspace(): boolean {
    return Boolean(vscode.workspace.workspaceFolders?.length);
  }

  private get storage(): vscode.Memento {
    return this.hasWorkspace ? this.context.workspaceState : this.context.globalState;
  }

  private normalizeRunMode(
    runMode: LegacyCommandMode | undefined,
    addNewLine?: boolean
  ): CommandMode {
    if (
      runMode === 'enter' ||
      runMode === 'clipboard' ||
      runMode === 'terminal' ||
      runMode === 'dynamic'
    ) {
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

  private shouldSendEnter(runMode: CommandMode): boolean {
    return runMode === 'enter' || runMode === 'dynamic';
  }

  private loadCommands(): CommandItem[] {
    const workspaceCommands = this.context.workspaceState.get<CommandItem[]>(STORAGE_KEY);
    if (this.hasWorkspace && Array.isArray(workspaceCommands)) {
      return this.normalizeCommands(workspaceCommands);
    }

    const globalCommands = this.context.globalState.get<CommandItem[]>(STORAGE_KEY);
    return Array.isArray(globalCommands)
      ? this.normalizeCommands(globalCommands)
      : [];
  }

  private normalizeCommands(commands: CommandItem[]): CommandItem[] {
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

  private async saveCommands() {
    this._commands = this.normalizeCommands(this._commands);
    await this.storage.update(STORAGE_KEY, this._commands);
    // Update the webview UI
    this.postCommands();
  }

  private postCommands() {
    this._view?.webview.postMessage({
      type: 'setCommands',
      commands: this._commands
    });
  }

  private get presetStorage(): vscode.Memento {
    return this.context.globalState;
  }

  private loadPresets(): PresetItem[] {
    const storedPresets = this.presetStorage.get<PresetItem[]>(PRESET_STORAGE_KEY);
    if (Array.isArray(storedPresets)) {
      return this.normalizePresets(storedPresets);
    }
    return this.normalizePresets(PRESET_DEFAULTS);
  }

  private normalizePresets(presets: PresetItem[]): PresetItem[] {
    if (!Array.isArray(presets)) {
      return [];
    }
    const normalized: PresetItem[] = [];
    for (const preset of presets) {
      const text = String(preset?.text ?? '').trim();
      if (!text) {
        continue;
      }
      const label = String(preset?.label ?? text).trim() || text;
      const id = String(preset?.id ?? this.createPresetId());
      normalized.push({ id, label, text });
    }
    return normalized;
  }

  private async savePresets() {
    this._presets = this.normalizePresets(this._presets);
    await this.presetStorage.update(PRESET_STORAGE_KEY, this._presets);
    this.postPresets();
  }

  private postPresets() {
    this._view?.webview.postMessage({
      type: 'setPresets',
      presets: this._presets
    });
  }

  private getAccentColors(): AccentColors {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const selected = config.get<AccentColorOption>('accentColor', 'green');
    return ACCENT_COLORS[selected] ?? ACCENT_COLORS.green;
  }

  private postAccentColors() {
    this._view?.webview.postMessage({
      type: 'setAccent',
      accent: this.getAccentColors()
    });
  }

  private createPresetId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private async addCommand(label: string, text: string) {
    const trimmedLabel = (label ?? '').trim();
    const trimmedText = (text ?? '').trim();

    if (!trimmedText) {
      vscode.window.showWarningMessage('Please provide a command.');
      return;
    }

    const id = Date.now().toString();
    const finalLabel = trimmedLabel || trimmedText;
    const inferredMode: CommandMode = trimmedText.includes('${input}')
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

  private async addPreset(label: string, text: string) {
    const trimmedLabel = (label ?? '').trim();
    const trimmedText = (text ?? '').trim();

    if (!trimmedText) {
      vscode.window.showWarningMessage('Please provide a command to save as a preset.');
      return;
    }

    const finalLabel = trimmedLabel || trimmedText;
    const exists = this._presets.some(
      (preset) => preset.label === finalLabel && preset.text === trimmedText
    );
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

  private async deleteCommand(id: string) {
    this._commands = this._commands.filter((c) => c.id !== id);
    await this.saveCommands();
  }

  private async removePreset(id: string) {
    if (!id) {
      return;
    }
    this._presets = this._presets.filter((preset) => preset.id !== id);
    await this.savePresets();
  }

  private async restorePresetDefaults() {
    this._presets = this.normalizePresets(PRESET_DEFAULTS);
    await this.savePresets();
  }

  private async reorderCommands(fromIndex: number, toIndex: number) {
    if (
      !Number.isInteger(fromIndex) ||
      !Number.isInteger(toIndex) ||
      fromIndex === toIndex
    ) {
      return;
    }

    if (
      fromIndex < 0 ||
      fromIndex >= this._commands.length ||
      toIndex < 0
    ) {
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

  private async updateCommandMode(id: string, runMode: LegacyCommandMode) {
    const normalizedMode = this.normalizeRunMode(runMode);
    this._commands = this._commands.map((cmd) =>
      cmd.id === id
        ? {
            ...cmd,
            runMode: normalizedMode,
            addNewLine: this.shouldSendEnter(normalizedMode)
          }
        : cmd
    );
    await this.saveCommands();
  }

  private async updateAllCommandModes(runMode: LegacyCommandMode) {
    const normalizedMode = this.normalizeRunMode(runMode);
    this._commands = this._commands.map((cmd) => ({
      ...cmd,
      runMode: normalizedMode,
      addNewLine: this.shouldSendEnter(normalizedMode)
    }));
    await this.saveCommands();
  }

  private async updateCommandInputValue(id: string, inputValue: string) {
    this._commands = this._commands.map((cmd) =>
      cmd.id === id ? { ...cmd, inputValue } : cmd
    );
    await this.saveCommands();
  }

  // --- Terminal handling --------------------------------------------------

  private ensureTerminal(): vscode.Terminal {
    if (!this._terminal || this._terminal.exitStatus) {
      this._terminal = vscode.window.createTerminal('Command Buttons');
    }
    this._terminal.show(true);
    return this._terminal;
  }

  private async runCommand(text: string, runMode: CommandMode) {
    if (runMode === 'clipboard') {
      try {
        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage('Copied to Clipboard');
      } catch {
        vscode.window.showErrorMessage('Failed to copy to clipboard.');
      }
      return;
    }

    const terminal = this.ensureTerminal();
    terminal.sendText(text, this.shouldSendEnter(runMode)); // true -> add newline (ENTER)
  }

  // --- Webview HTML -------------------------------------------------------

  private getHtmlForWebview(webview: vscode.Webview): string {
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

    input[type="text"] {
      flex: 1;
      border-radius: 4px;
      border: 1px solid var(--input-border);
      padding: 0.25rem 0.35rem;
      font-size: 12px;
      background-color: var(--input-bg);
      color: var(--input-fg);
    }

    input[type="text"]:focus {
      outline: 1px solid var(--focus);
      outline-offset: 1px;
      border-color: var(--focus);
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
        <div class="preset-row">
          <select id="presetSelect">
            <option value="">Preset library...</option>
          </select>
          <button id="presetAddBtn" title="Save the current inputs as a preset">Add preset</button>
          <button id="presetRemoveBtn" class="btn-delete" title="Remove selected preset">Remove</button>
          <button id="presetRestoreBtn" class="btn-secondary" title="Restore default presets">Restore defaults</button>
        </div>
        <div class="add-row">
          <input
            id="labelInput"
            type="text"
            placeholder="Label (optional, e.g. Build)"
          />
        </div>
        <div class="add-row">
          <input
            id="commandInput"
            type="text"
            placeholder="Command (e.g. npm run build)"
          />
          <button id="addBtn">Add</button>
        </div>
        <div class="note">
          Label is optional. Use the run-mode toggles to switch between "Copy + Enter", "Copy only to clipboard", "Copy only to terminal", or "Dynamic Input" (commands containing <code>\${input}</code> will prompt for a value).
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const labelInput = document.getElementById('labelInput');
    const commandInput = document.getElementById('commandInput');
    const addBtn = document.getElementById('addBtn');
    const commandsList = document.getElementById('commandsList');
    const commandsGrid = document.getElementById('commandsGrid');
    const mainPanel = document.getElementById('mainPanel');
    const presetSelect = document.getElementById('presetSelect');
    const presetAddBtn = document.getElementById('presetAddBtn');
    const presetRemoveBtn = document.getElementById('presetRemoveBtn');
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

    let presetLibrary = normalizePresetsForView(${JSON.stringify(this._presets)});
    const PLACEHOLDER_TOKEN = '\${input}';
    const MODE_SEQUENCE = ['enter', 'clipboard', 'terminal', 'dynamic'];
    const initialAccent = ${JSON.stringify(accent)};

    let viewState = typeof vscode.getState === 'function' ? vscode.getState() || {} : {};
    const cachedCommands = Array.isArray(viewState.commands) ? viewState.commands : [];
    const cachedPresets = Array.isArray(viewState.presets) ? viewState.presets : [];
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

    if (cachedPresets.length) {
      presetLibrary = normalizePresetsForView(cachedPresets);
    }

    populatePresetDropdown();
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

    function addCommandFromInputs() {
      const label = labelInput.value.trim();
      const text = commandInput.value.trim();

      vscode.postMessage({ type: 'addCommand', label, text });

      if (text) {
        labelInput.value = '';
        commandInput.value = '';
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

    function populatePresetDropdown() {
      if (!presetSelect) {
        return;
      }
      presetSelect.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Preset library...';
      presetSelect.appendChild(placeholder);

      presetLibrary.forEach((preset, index) => {
        const opt = document.createElement('option');
        opt.value = String(index);
        opt.textContent = preset.label || preset.text;
        opt.title = preset.text;
        presetSelect.appendChild(opt);
      });
    }

    function applyPresetToInputs(index) {
      const preset = presetLibrary[index];
      if (!preset) return;
      labelInput.value = preset.label || preset.text;
      commandInput.value = preset.text;
    }

    function addPresetFromInputs() {
      const label = labelInput.value.trim();
      const text = commandInput.value.trim();
      vscode.postMessage({ type: 'addPreset', label, text });
    }

    function removeSelectedPreset() {
      if (!presetSelect.value) {
        return;
      }
      const selectedIndex = Number(presetSelect.value);
      if (Number.isNaN(selectedIndex)) {
        return;
      }
      const preset = presetLibrary[selectedIndex];
      if (!preset || !preset.id) {
        return;
      }
      vscode.postMessage({ type: 'removePreset', id: preset.id });
      presetSelect.value = '';
    }

    function restorePresetDefaults() {
      vscode.postMessage({ type: 'restorePresetDefaults' });
      presetSelect.value = '';
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

    presetRemoveBtn?.addEventListener('click', () => {
      removeSelectedPreset();
    });

    presetRestoreBtn?.addEventListener('click', () => {
      restorePresetDefaults();
    });

    presetSelect.addEventListener('change', () => {
      if (!presetSelect.value) {
        return;
      }
      const idx = Number(presetSelect.value);
      if (!Number.isNaN(idx)) {
        applyPresetToInputs(idx);
      }
    });

    addBtn.addEventListener('click', () => {
      addCommandFromInputs();
    });

    commandInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        addCommandFromInputs();
      }
    });

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
          presetLibrary = normalizePresetsForView(message.presets);
          persistViewState({ presets: presetLibrary });
          populatePresetDropdown();
          break;
        }
        case 'setAccent': {
          applyAccentColors(message.accent);
          break;
        }
      }
    });

    vscode.postMessage({ type: 'ready', cachedCommands: commands });
  </script>
</body>
</html>`;
  }
}

// Utility to create a nonce for CSP
function getNonce(): string {
  let text = '';
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
