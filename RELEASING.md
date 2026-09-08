# Releasing Acadence

Merging a PR does not publish a release. The installer downloads the latest GitHub release, and `.github/workflows/release.yml` runs only when a `v*` tag is pushed.

For every PR, consider whether its changes should be included in the next release. Multiple PRs can share a release; merging alone does not make their changes available through the installer.

## Every release

1. Choose the release scope and version: patch for compatible fixes, minor for new functionality, and major for incompatible changes. While the package is below `1.0.0`, use minor versions for incompatible changes and describe them in the release notes.
2. Update `package.json` and `package-lock.json`, and ensure the CLI reports the same version.
3. Run `npm run check`, `npm test`, `npm run build`, and the container smoke check in `scripts/smoke-container.sh`.
4. Commit the version changes and ensure all intended changes are on the release commit before tagging it.
5. Push a matching `v<version>` tag. Verify the release workflow succeeds and publishes `acadence.tgz` and `SHA256SUMS`.
6. Review the generated release notes, including any migration instructions.
7. Verify the installer downloads the new release and bare `acadence` reports the expected version.

A release is complete only after the published artifact and installation have been verified.

## Current implementation gaps

These are one-time fixes, separate from the recurring release procedure:

- The CLI hardcodes its version separately from `package.json`. Use a single version source; until then, update both together.
- The container smoke check still uses the removed `--version` flag. Update it to invoke the CLI without arguments before the next release.
