# Repository Instructions

## Changelog policy

- `CHANGELOG.md` and its English and Chinese documentation mirrors must contain only changes that affect consumers of the published library.
- Include public API or type changes, documented capability or error-semantics changes, and consumer-visible behavior fixes.
- Exclude repository engineering details such as internal refactors, example/private app changes, fixtures, tests, CI, build tooling, and version bumps by themselves.
- Follow the concise style of existing entries and write for consumers of the published library: state what changed and how it affects usage.
- Avoid unnecessary implementation details; keep architecture, storage layouts, locking, cleanup mechanics, and other internal design explanations in the relevant documentation rather than the changelog. Mention implementation details only when necessary to explain a consumer-visible contract or limitation.
- Keep the root, English, and Chinese changelog entries semantically synchronized.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
