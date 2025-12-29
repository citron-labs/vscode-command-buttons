# Change Log

All notable changes to the "Command Buttons Panel" extension will be documented in this file.

## [0.2.5] - 2025-12-28

### Added
- Separate run modes for copying only to the clipboard or only to the terminal.
- Collapsing the list now hides the per-command run-mode chips under the grid.
- Accent/button color setting with preset palette options.

### Fixed
- Webview colors now follow the active VS Code theme.

## [0.2.3] - 2025-12-26

### Fixed
- Copy-only mode now copies the command to the clipboard and shows a confirmation message.

## [0.2.2] - 2025-12-23

### Added
- Visual guide GIFs for presets, custom commands, layout toggling, and show/hide controls in the README.

## [0.2.0] - 2025-12-23

### Added
- Editable preset library with add/remove actions and restore defaults.
- Preset library persistence synced via Settings Sync.

### Changed
- Marketplace preview images updated to grid + compact views.

### Fixed
- Dark mode preset dropdown background for better contrast.

## [0.1.2] - 2025-12-23

### Fixed
- Persisted cached commands and grid settings so Marketplace installs keep local data.

## [0.1.1] - 2025-11-27

### Added
- Marketplace preview screenshots for the README.

### Changed
- Documented predefined variables and selection placeholders in the README.
- Fixed minor encoding issues in the docs.

## [0.1.0] - 2025-11-18

### Added
- VSCE scripts for packaging/publishing and guidance in the README.
- `.vscodeignore` now excludes packaged `.vsix` files.

### Changed
- Refined Marketplace metadata and refreshed documentation for release.

## [0.0.1] - 2025-11-14

### Added
- Initial release
- Side panel view in Explorer with customizable command buttons
- Add, run, and delete commands functionality
- Dedicated terminal for running commands with automatic Enter
- Persistent global storage for commands
- Clean, modern UI with dark mode support
