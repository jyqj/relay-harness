# Relay Harness

English | [中文](README.zh.md)

Relay Harness (`rlh`) is an open-source general-purpose agent harness for people who want to describe a goal in ordinary language, add relevant files when needed, and receive a verified result without learning prompt engineering or agent internals.

Its architecture treats **everything as a plugin** and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Product experience

- **Simple by default:** Chat, Work, and Library provide the ordinary product path; advanced implementation controls stay out of the way until requested.
- **Chat and Work:** Chat supports continuous conversation. Work owns an independent task, execution state, questions, files, outputs, verification, and recovery without requiring a Project.
- **Explicit context:** users add files and folders to the current Chat or Work instead of granting an implicit whole-device scan.
- **Prompt Enhancement:** users may improve an unsent draft from its current context, review the diff and sources, accept or undo it, and remain in control of submission.
- **Local governance:** permission, memory, context evidence, checkpoints, and verification remain explicit and auditable.

Current shipped, partial, and planned status is defined only by the machine-readable [feature status](docs/feature-status.json), whose verifier checks default composition, Remote/API, UI, e2e, and documentation evidence.

## Developer preview

Relay Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @relay-harness/rlh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See the [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/jyqj/relay-harness.git
cd relay-harness/relay-harness
pnpm install
pnpm run build
pnpm rlh web
```

`pnpm run build` prepares the repository artifacts. `pnpm rlh web` uses those built artifacts without rebuilding.

## Repository and documentation

The Git checkout is an outer container. The TypeScript runtime monorepo lives under `relay-harness/`; inside it, `apps/` contains the CLI, Web, and Desktop applications, `packages/` contains the plugin runtime, and `docs/` contains product and implementation documentation. Root `.github/` is the only GitHub automation authority.

- Start with the [documentation map](docs/README.md) and [domain context](docs/CONTEXT.md).
- Read the current [architecture](docs/architecture.md) and [subsystem references](docs/subsystems/README.md) for implementation contracts.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [development guide](docs/development.md) before changing the repository.
- Agents follow [AGENTS.md](AGENTS.md).

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/jyqj/relay-harness/discussions).
- Add the [`rlh-plugin`](https://github.com/topics/rlh-plugin) topic to plugin repositories for discoverability.
- Join the <a href="https://discord.gg/Ycq5dCaS4">Relay Harness Discord community</a>.

## License

[MIT](LICENSE)

Relay Harness is a rebrand of DeepSeek Harness, so [LICENSE](LICENSE) keeps the upstream copyright notice the MIT terms require.

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
