# Repository instructions

## Client changes require a published release

For every client-facing change, including small fixes, bump the release version
and publish a new GitHub release under a matching `v<version>` Git tag. Merging
the PR alone does not complete the work: users install the latest release, not
the latest commit on `master`.

Client-facing changes include CLI commands, output, help, formatting, interactive
menus, installation, and dependencies or shared modules that affect the CLI.
A shared module change counts even when most of the work is on the backend.
Documentation-only changes do not require a release.

- Include the version bump in `package.json` and `package-lock.json` in the PR.
  Use a new, unused version number; never reuse or move a published release tag.
  Follow the versioning rules in [RELEASING.md](RELEASING.md).
- When completing or merging a client-facing PR, publish the matching tag from
  the merged commit containing both the changes and the version bump. Verify
  that the release workflow publishes `acadence.tgz` and `SHA256SUMS`, and that
  installing the release reports the new version.
- Include the published version and release link in the completion message.
  Do not describe a client-facing change as delivered while publication or
  verification is still outstanding.
- Explicit user limits take precedence. If the user requests only a review,
  staged changes, no commits, or no publishing, respect that scope and state
  which release steps remain. Do not publish merely to satisfy this rule when
  the user has excluded publication.

Read [RELEASING.md](RELEASING.md) before preparing or completing a release.
