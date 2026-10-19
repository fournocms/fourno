# Fourno

**An agent-first, open-source CMS with a visual page builder.**

WordPress-level simplicity on a clean modern base, with AI agents as first-class actors: they connect over MCP with the AI subscription you already have, work inside limits you set, and everything they do is logged and reversible.

> **Status: early.** Fourno is pre-1.0 and under active construction. APIs and workflows will change. The roadmap lives in the planning documents (PRD and security concept); it is not a promise yet.

## Based on Instatic

Fourno is a hard fork of [Instatic](https://github.com/corebunch/instatic) (v0.0.21, MIT) by David Babinec and contributors. Instatic provides the foundation: the visual canvas editor, content model, publisher, plugin sandbox, real-time co-editing, MCP server, and authentication. Fourno develops independently from here: Node runtime, a rethought admin UX, multilingual content, an autonomy model for agents, and more. The Instatic copyright notice stays in [LICENSE](LICENSE).

## What it is

- **Self-hosted.** One Node server, backed by SQLite (default) or Postgres, selected by `DATABASE_URL`.
- **Fast output.** Pages are baked to static HTML with compact CSS. No framework runtime on public pages, no database access on the common path.
- **Visual page building.** Canvas editor, design tokens, modules, components with slots, templates, loops, forms.
- **Agents as actors.** Every connection (OAuth or personal token) is its own identity with its own rights. Agents write *data*, not code.
- **Extensible and sandboxed.** Plugins are zip packages with a manifest; server code runs in a QuickJS-WASM sandbox with owner-granted permissions.
- **No lock-in.** Plain semantic HTML, open formats, full export.

## Quick start

You need [Node.js](https://nodejs.org) 24.11 or newer and [pnpm](https://pnpm.io) (`corepack enable` activates the version pinned in `package.json`). The default dev setup runs on SQLite, so there are no extra services to stand up.

```sh
git clone <your clone URL> fourno
cd fourno
pnpm install
pnpm dev
```

Open `http://localhost:5173`. The first visit walks you through creating your site and your owner account.

`pnpm start` builds the admin and serves it from the Node server at `http://localhost:3001/admin`.

## Deploy

Fourno ships as a single Docker image (SQLite or Postgres). See [docs/deployment](docs/deployment/README.md) for Docker Compose, VPS, Railway and Render setups, and [backup and restore](docs/deployment/backup-restore.md).

> The published image name and one-click templates still point at placeholder locations until the Fourno organisation and registry exist.

## For developers

| | |
|---|---|
| **Runtime** | Node.js, pnpm, Vitest |
| **Language** | TypeScript everywhere |
| **Admin app** | React 19 (React Compiler on), Vite, Zustand + Mutative, CodeMirror, dnd-kit |
| **Server** | Hand-written router on `srvx` + `ws` |
| **Database** | SQLite (`better-sqlite3`) or Postgres (`postgres`), one `DbClient` interface |
| **Validation** | TypeBox at every untyped boundary |
| **Plugins** | QuickJS-WASM backend sandbox, owner-granted permissions |
| **AI** | Provider-agnostic drivers over raw HTTP/SSE, MCP server for external agents |

Architectural rules are enforced as tests in `src/__tests__/architecture/`.

```sh
pnpm build   # tsc -b && vite build
pnpm test
pnpm lint
```

Dig in: [docs index](docs/README.md) · [architecture](docs/architecture.md) · [editor](docs/editor.md) · [server](docs/server.md) · [publisher](docs/features/publisher.md) · [plugin system](docs/features/plugin-system.md) · [contributing](CONTRIBUTING.md) · [security policy](SECURITY.md)

## Thanks

The interface uses [Pixelarticons](https://pixelarticons.com/) by Gerrit Halfmann, and the design-token system integrates [Core Framework](https://coreframework.com). Thanks to the Instatic authors for the foundation.

## License

MIT. See [LICENSE](LICENSE).
