# Adding a sample

Each sample lives in its own top-level folder and runs on its own.

## Conventions

- **Folder name:** `<what-it-does>[-<ai-provider>]-sent`, for example `outbound-agent-openai-sent` or `voice-feature-tour-sent`.
- **Required files:** `README.md`, `.env.example`, `pnpm-lock.yaml`, and a `package.json` with `"engines": { "node": ">=22" }` and a pinned `packageManager` pnpm version. Never commit `.env`.
- **No license file in the sample.** The root [LICENSE](./LICENSE) covers every sample.
- **Committed build output:** if it bundles third-party code, generate a `THIRD_PARTY_NOTICES.md` as part of the build, like [the inbound sample](./inbound-agent-openai-sent/scripts/build.mjs) does.
- **Root README:** add or update the sample's row in the table.

## CI

GitHub Actions treats every top-level folder with a `package.json` as a sample. For each one it runs these scripts when they exist:

1. `check`
2. `test`
3. `build`, failing if the output differs from what is committed
4. `test:browser` and `test:dashboard`, with Playwright's Chromium installed when `playwright` is a dependency

Run them locally before opening a pull request.
