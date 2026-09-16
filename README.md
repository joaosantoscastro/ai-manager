# Plugin Manager

A desktop app for managing your local Copilot setup. It gives you one place to review and edit the
plugins, MCP servers, tools, skills, agents and hooks that live in `~/.copilot`.

The app is a Next.js server wrapped in an Electron shell. When you open it, it starts a local server
on `http://127.0.0.1:3000` and shows that page in a normal desktop window. If port 3000 is busy, it
moves to the next free port.

## Download

### macOS

Choose the download for your Mac:

| Mac type | Download |
| --- | --- |
| Apple Silicon (M1 or later) | [Download Plugin Manager](../../releases/latest/download/Plugin-Manager-macos-arm64.dmg) |
| Intel | [Download Plugin Manager](../../releases/latest/download/Plugin-Manager-macos-x64.dmg) |

Click a download link to save the installer. Open the downloaded `.dmg`, then drag `Plugin Manager`
into the `Applications` folder. You can then open it from `Applications`.

### Other platforms

Get the installer for your platform from the [Releases page](../../releases/latest).

| Platform | File |
| --- | --- |
| Windows | `Plugin Manager Setup <version>.exe` |

### The builds are unsigned

There is no Apple Developer or Windows code-signing certificate behind these builds yet. Both
systems will warn you the first time you open the app. This is expected.

**macOS.** Right-click `Plugin Manager` in `Applications` the first time. Choose **Open**, then
confirm in the dialog. macOS remembers the choice, so later launches are normal.

If macOS still refuses and says the app is damaged, clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine "/Applications/Plugin Manager.app"
```

**Windows.** SmartScreen shows a blue "Windows protected your PC" screen. Click **More info**, then
**Run anyway**.

## What it needs

The app reads and writes `~/.copilot`, so it expects a Copilot setup already on the machine. Some
features shell out to other tools:

- `copilot` for running CLI commands
- `npx` for MCP servers published to npm
- `docker` for containerised MCP servers

The app reads your login shell's `PATH` on startup, so tools installed through nvm, Homebrew, asdf
or similar are found even though desktop apps do not normally inherit that `PATH`.

## Running from source

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

To run the Electron shell against a production build instead:

```bash
npm run desktop:build   # build the Next.js payload into build/resources
npm run desktop:start   # launch the Electron shell
```

## Building installers

```bash
npm run dist:mac        # macOS .dmg (arm64 + x64)
npm run dist:win        # Windows .exe installer
npm run dist            # both, where the toolchain allows it
```

Installers land in `dist/`. You can only build macOS installers on macOS. Windows installers build
on Windows, and on macOS or Linux with Wine installed.

Releases are also built by `.github/workflows/release.yml`. Push a tag starting with `v` and it
builds on both platforms, then opens a draft GitHub Release with the installers attached.

## How the desktop build works

```
electron/main.js        Window, menu, lifecycle, startup errors
electron/next-server.js Picks a port, forks the server, waits for it to be healthy
electron/shell-path.js  Recovers the login shell PATH
scripts/build-desktop.mjs  Builds and stages everything into build/resources
```

The Next.js server is built with `output: "standalone"`, then forked by Electron using its own
bundled Node runtime. The payload ships as `extraResources` rather than inside `app.asar`, because a
forked process cannot execute a script from an asar archive.

### MCP proxy note

When a filtered MCP server is applied, the app writes a launcher into `~/.copilot/mcp-config.json`
that points at the installed app. Moving or deleting the app breaks those proxied servers. Applying
your changes again from the new location repairs them.
