# Repository Guidelines

This repository contains an IINA plugin that translates the active subtitle line into Simplified Chinese and displays it above the original subtitle. The plugin is distributed either via GitHub install (IINA’s “Install from GitHub” flow) or as a local `.iinaplgz` bundle.

## Project Structure & Module Organization

- `Info.json` is the plugin manifest and entry point configuration.
- `main.js` contains the runtime logic, mpv event listeners, and OpenAI-compatible API calls.
- `preferences.html` renders the settings UI for provider selection, model selection, and API key.

There are no separate test or build directories yet.

## Build, Test, and Development Commands

- Package a local install bundle:
  `zip -r SubTranslator.iinaplgz Info.json main.js preferences.html`
- If you have the IINA plugin CLI installed:
  `iina-plugin pack .` to create the `.iinaplgz`.

There are no automated tests at the moment.

## Coding Style & Naming Conventions

- JavaScript uses `const`/`let`, 2-space indentation, and ASCII-only text in source files.
- Prefer short, descriptive function names (`handleSubtitleChange`, `translateText`) and keep IINA APIs (`mpv`, `overlay`, `http`) at the top of files.
- UI strings and API endpoints should be centralized (see `PROVIDERS` in `main.js`).

No formatter or linter is currently configured.

## Testing Guidelines

- Manual testing in IINA:
  1. Play a video with a subtitle track enabled.
  2. Open plugin preferences and set provider/model/API key.
  3. Confirm Chinese translation appears above the original subtitle.

## Commit & Pull Request Guidelines

There is no established commit message convention in this repository. Use short, imperative messages and include a scope when helpful (example: `prefs: add zhipu models`). PRs should include a brief description, a screenshot or short clip of subtitle output when UI behavior changes, and steps to reproduce.

## Configuration Tips

- The plugin only translates when an active subtitle track is detected.
- If you add a new provider, update `allowedDomains` in `Info.json` and the provider registry in `main.js` and `preferences.html`.
