# ⚡️ Node Killer

[![Electron](https://img.shields.io/badge/Electron-%5E38-blue?logo=electron)](https://www.electronjs.org/)
[![macOS](https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple)](https://developer.apple.com/macos/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

⚡️ **Node Killer** — a sleek macOS menubar app that keeps an eye on your **Node.js**, **Vite**, and **Bun** dev servers and lets you kill them with a click.

> 🖥️ Currently available only for Apple Silicon (arm64).

![Node Killer placeholder screenshot](assets/demo/node-killer-screenshot-0.2.0.png)

## ✨ Features
- 📊 **Live counter** in the status bar — instantly shows how many dev servers (Node.js, Vite, Bun) are listening (`active: 4`).  
- 🖱️ **Interactive tray menu** — lists every active process with its type, PID, and ports when available.  
- 🔪 **One-click kill** — terminate individual Node/Vite/Bun processes with success/error notifications.  
- 💣 **Kill all** — wipe out every running process of the enabled types, with confirmation and summary.  
- 🔄 **Smart auto-refresh** — updates every 5 seconds plus a manual **Refresh** option.  
- 🧰 **Customizable preferences** — adjust refresh rate, auto-launch, status-bar display mode, and which process types to monitor.
- ✅ **Process type toggles** — enable or disable Node.js, Vite, and Bun scanning directly from Preferences.


## 🏷️ Labelled processes + MCP server (fork additions)

- **Finds every Node/Bun/Deno process**, not just ones listening on a port — test runners, `tsc --watch`, language servers and MCP servers included.
- **Groups workers under the command that started them** (e.g. `npm run test` → `vitest run` + 8 workers is one entry) and totals their CPU and memory.
- **Labels each group** with the launching app (Terminal, VS Code, Claude Code, T3 Code, launchd…), the project, git worktree and sub-folder, and listening ports.
- The menu bar shows `groups · total CPU`, and the list is sorted by CPU. Each entry's submenu lets you kill the whole group or one worker, reveal its folder, or copy its command.

### MCP server

`src/mcp-server.js` is a stdio MCP server that uses the same scanner. Its tools:

| Tool | What it does |
|---|---|
| `list_processes` | Groups sorted by CPU; filter with `min_cpu` / `query` (matches app, project, worktree, task) |
| `get_process_group` | Every member of a group, with per-process CPU and command line |
| `kill_process_group` | SIGTERM → SIGKILL a whole group (or `only_this_pid`). It refuses to kill the agent calling it. |

Register it with Claude Code:

```bash
claude mcp add --scope user node-killer -- node /absolute/path/to/node-killer/src/mcp-server.js
```

Run the tests with `npm test`.

## 🚀 Getting Started

For development:

```bash
npm install
npm run dev
```

Node Killer lives in the macOS menu bar near the clock. 


## 📥 Download

You can grab the latest pre-built binary from the [Releases page](https://github.com/adolfoflores/node-killer/releases).

👉 Direct download for Apple Silicon (M1/M2/M3/M4):  
[Node-Killer-0.2.0-arm64.dmg](https://github.com/adolfoflores/node-killer/releases/download/v0.2.0/Node-Killer-0.2.0-arm64.dmg)

> 🖥️ Currently only Apple Silicon (arm64) builds are provided.  
> macOS will ask for confirmation the first time you run the app.  

## 🎥 Demo

![Node Killer demo](assets/demo/node-killer-demo.gif)

## 📦 Build

Create a `.app` and `.dmg` bundle with [electron-builder](https://www.electron.build/):

```bash
npm run build
```

Artifacts are written to `dist/`. 


## ⚠️ Limitations
- Processes are detected via `lsof -nP -iTCP -sTCP:LISTEN` parsing.
- Containers (Docker) usually appear as `docker-proxy`, so underlying Node processes may not be visible.

## 📸 Roadmap
- [ ] Alternate scan mode for Node processes that are not listening on sockets.
- [ ] Basic Linux support.


## 🧪 Manual Smoke Test
1. Start one server for each runtime you use (`next dev`, `vite dev`, `bun dev`, etc.).
2. Run `npm run dev` for Node Killer.
3. Confirm the menu shows each process with the correct label (node/vite/bun), ports, and that disabling a type in Preferences hides its entries.
4. Terminate a single process, then try **Kill all** and review the notifications.


## 🤝 Contributing
Pull requests and feedback are welcome! Feel free to open an issue.

## 📝 License
[MIT](./LICENSE)

