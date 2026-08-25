Desktop-only bundled plugins and the upstream import pin live here. Harness source is the monorepo root and is not duplicated under this directory.

The desktop installer bundles each vendored tree offline through electron-builder `extraResources`, which copies the directory whole — so whatever a plugin needs at runtime has to be on disk before the pack, not only in a registry. Two kinds of subtree satisfy that, and they are handled differently.

A plugin's compiled half is tracked. `rlhmarket/lib` and `rlhbot/lib` are build output with no source in this tree, so nothing here can regenerate them; [`../.gitignore`](../.gitignore) un-ignores each by name against the repository-wide `lib/` ignore. Add a matching line when vendoring a new plugin that ships prebuilt.

A plugin's dependencies are installed, not tracked. `pnpm run vendor:sync` runs `npm ci --omit=dev` in every vendored plugin that carries a `package-lock.json`, and is a no-op once the install matches. Packaging and `pnpm start` call it, and [`../scripts/after-pack.js`](../scripts/after-pack.js) installs into the packaged tree and fails the build if the result is still short — so a pack on a host that cannot reach the registry fails loudly rather than shipping a plugin that cannot mount.

[`plugins.json`](plugins.json) records each vendored plugin's upstream source, the version pinned, and any subtree the drop does not carry, with the reason. [`vendor-plugins.test.js`](vendor-plugins.test.js) checks every entry point a plugin's `package.json` declares against that record, fails when a subtree listed as absent turns up — so a restored subtree cannot stay recorded as missing, and the suites that skip on it cannot stay skipped — and fails when an install is committed or drifts from its lockfile.
