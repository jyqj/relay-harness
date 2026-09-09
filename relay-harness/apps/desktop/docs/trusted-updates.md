# Trusted desktop updates

English | [中文](trusted-updates.zh.md)

## Availability

Automatic installation requires a packaged Windows x64 build with an explicitly configured publisher signing authority. This checkout contains no update public key or release authority; its updater reports `unavailable` without downloading or executing an installer. macOS, other architectures, development launches, and prerelease versions have no supported installation protocol. A project Releases link is informational, not evidence that this build can self-update.

## Build authority

The installed desktop `package.json` owns optional `desktopUpdate` metadata: `schemaVersion: 1`, `productId` equal to `build.appId`, `repository` as the publisher-controlled `owner/repository`, and `publicKey` as a PEM-encoded Ed25519 public key. `build.nsis.artifactName` supplies the exact installer-name template, with only version, extension, and architecture substitutions. No trust configuration, artifact URL, or public key is accepted from renderer IPC. Provisioning the real publisher key and release process is deployment work; private signing keys never belong in the application or repository.

## Signed release protocol

The configured repository's latest stable GitHub release contains `relay-desktop-update.v1.json`, its detached Base64 Ed25519 signature `relay-desktop-update.v1.json.sig`, and the installer. The signature covers the manifest's exact UTF-8 bytes, not a parsed or reserialized object. The updater verifies the signature before parsing JSON.

The manifest declares `schemaVersion: 1`, the bound `productId`, a strict stable `major.minor.patch` version, the exact release `tag`, an ISO expiry `expiresAt`, and an `artifacts` array. Exactly one artifact matches Windows `win32`, architecture `x64`, and installer `kind: "nsis"`; it carries `name`, positive byte `size`, and a lowercase 64-character `sha256`. The filename must match this product's NSIS build template. The signed manifest is the publisher identity proof; its digest binds that signature to the complete installer bytes. No unsigned GitHub release body or arbitrary asset is executable authority.

Every initial asset URL must match this repository, signed tag, and exact asset name. Redirects remain HTTPS, have no embedded credentials or foreign port, use only the fixed GitHub API/download hosts, and stop after five redirects. Release metadata is bounded to 1 MiB, manifests to 256 KiB, signatures to 1 KiB, and installers to 512 MiB. Metadata transfers have a 30-second total deadline; the streaming installer transfer has a ten-minute total deadline, including redirects.

A redirect retires and destroys its response and request before opening the next hop. Timeout closes admission: late response callbacks cannot start a new request, and an error from a retired hop cannot cancel its successor.

## Installation commit

Installation performs a fresh signed check and proceeds only for `available`. Equal or older versions never download an installer. A private, unique temporary directory receives a non-executable `.part` file through an exclusive file handle; the stream is size-bounded, hashed, and fsynced. Only an exact signed size and digest pass. Signature, expiry, platform, packaged state, and the current version are checked again before atomic rename to the installer filename and process launch. A verification or launch failure removes temporary artifacts. Concurrent install requests share one operation, and one process launches at most one installer.

The Settings About page disables installation for `unavailable`, `none`, and `current`, even if a stale URL is present. An install-time verification failure remains visible rather than leaving a permanent download indicator. These UI checks supplement, never replace, the main-process verifier.

## Verification boundary

Offline tests generate temporary fixture keys and use a fake installer launcher. They cover signatures, product/tag/platform/architecture binding, version rollback, expiry before and during download, digest and byte bounds, cleanup, redirect policy, deadlines, and duplicate installation. They do not constitute validation of a configured production publisher, a real signed release, or an operating-system installer run.
