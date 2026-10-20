# Releasing

Releases use the version in `package.json` and are published to npm by the tag-triggered GitHub Actions workflow.

1. Move the entries under `[Unreleased]` in `CHANGELOG.md` into a dated version section, leave an empty `[Unreleased]` heading above it, and confirm the notes describe the changes.
2. Commit and push `main`. Wait for the Test workflow to pass on that commit. Local tests are a pre-check, not a substitute for CI.
3. Ask for explicit final confirmation before creating or pushing the release tag.
4. After confirmation, run `npm version patch` (or `minor`/`major`), then push the version commit and tag. The tag triggers tests, smoke checks, version validation, and npm trusted publishing.

The catalog refreshes automatically at runtime, so new models do not require a release. Releases are needed for retirement handling, pricing changes, or max output token limit updates. See the [README](../README.md) for user-facing behavior and generated-data notes.

npm trusted publishing uses OIDC; no `NPM_TOKEN` secret is required. The publish workflow requires `contents: read` and `id-token: write` permissions.
