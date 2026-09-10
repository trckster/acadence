# Releasing Acadence

Merging a PR does not publish a release. The installer downloads the latest GitHub release, and `.github/workflows/release.yml` runs only when a `v*` tag is pushed.

Every client-facing PR **must include a version bump and be followed by a published release**. This applies even to small changes to CLI output, help, formatting, menus, installation, or shared code and dependencies that affect the client. Merging alone does not make those changes available through the installer. Documentation-only changes do not require a release. See [AGENTS.md](AGENTS.md) for the repository-wide completion rule and explicit user scope exceptions.

For backend-only PRs, consider whether their changes should be included in the next release. A mixed backend/client PR follows the mandatory client release rule.

## Every release

1. Choose a new, unused release version: patch for compatible fixes, minor for new functionality, and major for incompatible changes. While the package is below `1.0.0`, use minor versions for incompatible changes and describe them in the release notes. Never reuse or move a published version tag.
2. Update `package.json` and `package-lock.json`, and ensure the CLI reports the same version (it reads `package.json`).
3. Run `npm run check`, `npm test`, `npm run build`, and the container smoke check in `scripts/smoke-container.sh`.
4. Include the version changes in the PR. After merging, tag the merged commit that contains both the version bump and all intended changes.
5. Push a matching `v<version>` tag. Verify the release workflow succeeds and publishes `acadence.tgz` and `SHA256SUMS`.
6. Review the generated release notes, including any migration instructions.
7. Verify the installer downloads the new release and bare `acadence` reports the expected version.

A release is complete only after the published artifact and installation have been verified. Report the published version and GitHub release link in the completion message.
