# Deski

**Deski** is a tiny desktop pet app for Codex / Petdex-style pets.

It lives on your desktop as a transparent, always-on-top companion, can load pets from `pet.json + spritesheet.webp`, and understands the same 8x9 sprite atlas used by `codex-pets-react`.

![Deski app icon](app-icon.png)

> Built with Tauri 2, React 19, and `codex-pets-react`.

## Why Deski

Codex pets are delightful inside Codex. Deski lets them step out onto your desktop.

Instead of inventing another pet format, Deski focuses on compatibility with the existing Petdex / Codex pet package shape:

```text
pet.json
spritesheet.webp
```

That means pets downloaded from Petdex, installed under `~/.codex/pets`, or created with Codex pet tooling can be loaded by Deski with very little friction.

## Features

- **Transparent desktop pet window**: frameless, always-on-top, and hidden from the taskbar.
- **Petdex-style pet loading**: load a local `pet.json` and its matching spritesheet.
- **Installed pet discovery**: scans `~/.codex/pets/*/pet.json` for Codex-compatible pets.
- **Built-in pets**: ships with sample pets such as Dropout Bear and Boba.
- **Recent pets menu**: quickly switch back to pets you have used before.
- **Native right-click menu**: change pets, trigger actions, adjust appearance, and quit.
- **Interactive animations**: hover to wave, click to jump, drag to run.
- **Auto patrol**: the pet can occasionally walk short distances and turn around near screen edges.
- **Idle / waiting behavior**: after a longer quiet period, the pet can settle into a waiting state.
- **Window controls**: size presets, opacity presets, always-on-top, click-through, tray menu, and autostart.

## Quick Start

### Requirements

- Node.js
- Rust
- Tauri 2 desktop prerequisites for your platform

### Run locally

```bash
npm install
npm run tauri dev
```

### Build

```bash
npm run tauri build
```

For frontend-only development:

```bash
npm run dev
```

## Using Pets

### Load a pet from disk

Right-click the pet, choose **更换宠物…**, then select a `pet.json` file.

Example pet package:

```text
my-pet/
  pet.json
  spritesheet.webp
```

Example `pet.json`:

```json
{
  "id": "my-pet",
  "displayName": "My Pet",
  "description": "A tiny companion for your desktop.",
  "spritesheetPath": "spritesheet.webp"
}
```

`spritesheetPath` may be relative to the `pet.json` file or an absolute local path.

### Load installed Codex pets

Deski scans:

```text
~/.codex/pets
```

Expected structure:

```text
~/.codex/pets/my-pet/
  pet.json
  spritesheet.webp
```

Open the right-click menu and use **已安装（~/.codex/pets）** to pick one.

### Built-in pets

Built-in pet assets live under:

```text
public/pets/<pet-id>/
```

Each built-in pet has the same `pet.json + spritesheet.webp` shape.

## Pet Format

Deski currently expects pets to use the atlas layout from `codex-pets-react`:

- 8 columns
- 9 rows
- one spritesheet image
- animation names such as `idle`, `waving`, `jumping`, `running-left`, `running-right`, `failed`, `waiting`, `running`, and `review`

Deski intentionally keeps this format small so it stays compatible with Codex / Petdex-style pets.

## Controls

Right-click the pet to open the native menu.

Common actions:

- Change pet
- Pick a recent pet
- Pick an installed pet from `~/.codex/pets`
- Pick a built-in pet
- Open Petdex
- Change size
- Change opacity
- Toggle always-on-top
- Toggle click-through
- Trigger demo animations
- Quit

The tray icon can also show, hide, toggle click-through, or quit the app.

## Project Structure

```text
desktop-pet/
  src/                 React app
  src/lib/             pet loading, recent pets, window settings, window position helpers
  public/pets/         built-in pet packages
  src-tauri/           Tauri app, native menu, tray, commands, permissions
  app-icon.png         source app icon
```

## Tech Stack

| Area | Technology |
| --- | --- |
| Desktop shell | Tauri 2, Rust 2021 |
| Frontend | React 19, TypeScript, Vite |
| Pet rendering | `codex-pets-react` |
| Native features | Tauri fs, dialog, opener, autostart, tray |

## Roadmap Ideas

- A small settings window for pet management.
- Friendlier import validation for broken pet packages.
- Better visual feedback when a pet fails to load.
- More natural idle / patrol scheduling.
- Optional speech bubbles for lightweight desktop feedback.
- A guided flow that helps users create pets with Codex, while still keeping Deski focused on displaying and managing pets.

## Contributing

Issues and pull requests are welcome.

Good first areas to explore:

- pet package validation
- menu and tray polish
- multi-monitor behavior
- Windows and Linux testing
- README screenshots / demo videos
- additional built-in pets

## Development Notes

The Tauri app uses a transparent, undecorated main window:

- `alwaysOnTop: true`
- `skipTaskbar: true`
- `transparent: true`
- `decorations: false`

During debug builds, the main WebView may open devtools automatically.

Regenerate app icons with:

```bash
npx tauri icon app-icon.png
```

## License

No license has been declared yet. Add one before publishing binaries or accepting external contributions.
