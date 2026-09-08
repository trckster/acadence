# Release follow-up

Merging PRs does not publish a release. The installer downloads the latest GitHub release, and the release workflow runs only when a `v*` tag is pushed. At the time of this note, the latest release is `v0.1.0`; merged changes have not been released.

Before the next release:

- [ ] Use a single version source: the CLI currently hardcodes `0.1.0` separately from `package.json`.
- [ ] Update the container smoke check to invoke bare `acadence` for its version; it still uses the removed `--version` flag.
- [ ] Bump the package version and lockfile, keeping CLI output consistent until the single version source is implemented.
- [ ] Run type checking, tests, build, and the container smoke check.
- [ ] Push a matching `v<version>` tag and verify the release workflow publishes the archive and checksums.
- [ ] Verify the installer downloads the new release and the installed CLI reports the expected version.

Decide on a repeatable release cadence or automation so merged changes do not remain unpublished unintentionally. A separate version for every PR is not required.
