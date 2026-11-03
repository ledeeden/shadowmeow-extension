# ShadowMeow / Shadow Language — Chrome Extension

**Free, open-source** browser extension for sentence-level listening and shadowing on **YouTube** and **Bilibili**.

This repo is the Chrome (Chromium) extension source. Paid features and the full learning experience live in the **ShadowMeow iOS app** (Bundle ID `pro.honi.language`) — not in this repository. The extension is free to use and modify; if you want the polished mobile product, see the marketing site.

- Marketing / product: [https://shadowmeow.ledetools.com/](https://shadowmeow.ledetools.com/)
- Publisher: [https://github.com/ledeeden](https://github.com/ledeeden)
- Chinese product name: **虾豆跟读** (ShadowMeow / Shadow Language)

## What’s included

| Path | Role |
|------|------|
| `extension/` | WXT Chrome extension (`@shadow-language/extension`) |
| `packages/contracts/` | Shared Zod/TS contracts (`@shadow-language/contracts`), vendored as an npm workspace so this repo builds standalone |

No waitlist app, iOS project, CloudBase backend, or download zips are published here.

## Requirements

- Node.js **≥ 22**
- npm (workspaces)

## Setup

```bash
cp extension/.env.example extension/.env
# Optional: fill CloudBase / public API URLs for cloud sync features.
# Local dictionary & player UI work without them.

npm install
```

`@shadow-language/contracts` is built automatically via the extension `postinstall` / the root `build` scripts.

## Develop

```bash
npm run dev
# or: npm run dev -w @shadow-language/extension
```

WXT serves a development build. Load the path it prints (typically under `.output/` during `wxt` dev) via **chrome://extensions → Developer mode → Load unpacked**.

## Production build & load unpacked

```bash
npm run build
```

Default WXT `outDir` is the repo-root `dist/` folder with template `chrome-extension`:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select **`dist/chrome-extension`**

You can also build from the extension package:

```bash
npm run build -w @shadow-language/contracts
npm run build -w @shadow-language/extension
```

## Configuration

See `extension/.env.example`. Values are injected by WXT as `import.meta.env.WXT_*`.

- `WXT_CLOUDBASE_ENV` / `WXT_CLOUDBASE_REGION` / `WXT_CLOUDBASE_ACCESS_KEY` — optional Tencent CloudBase
- `WXT_PUBLIC_API_URL` — optional public learning API
- `WXT_UPDATE_CHECK_URL` — optional HTTPS release manifest for ZIP updates
- `release-config.json` — extension version + placeholder update/CDN URLs (override via env for releases)

## License

MIT © 2026 Eden Lede — see [LICENSE](./LICENSE).

## Related

The iOS app and backend are **not** open-sourced in this repository. Learn more at [shadowmeow.ledetools.com](https://shadowmeow.ledetools.com/).
