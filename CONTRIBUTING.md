# Contributing to ChronoBranch for Antigravity

Contributions, bug reports, and feature ideas are welcome!

## Local Development

Requires Node.js >= 20 and `pnpm`.

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm run install:antigravity
```

After running `pnpm run install:antigravity`, close and reopen the **Timeline** / **ChronoBranch** panel in Antigravity to load the updated `dist/app.html` live. If you modified `src/antigravity/server.ts`, restart the `chronobranch_chronobranch` server from Antigravity's **MCP Servers** settings.

## Pull Request Checklist

1. `pnpm run typecheck` passes with zero errors.
2. `pnpm run build` succeeds and updates `dist/server.mjs` and `dist/app.html`.
3. Any new UI strings are added to both `ZH` and `EN` in `src/core/i18n.ts`.
