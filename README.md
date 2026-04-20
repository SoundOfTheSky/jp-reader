# Vite + TypeScript Browser Extension (Chrome + Firefox)

This scaffold builds a browser extension for both Chrome and Firefox using Vite and TypeScript.

Quick commands:

```bash
npm install
npm run build:chrome   # builds into dist/chrome
npm run build:firefox  # builds into dist/firefox
npm run build:all
npm run dev            # vite dev server (for debugging frontend parts)
```

Files of interest:
- [package.json](package.json)
- [vite.config.ts](vite.config.ts)
- [src/manifest.base.json](src/manifest.base.json)
- [src/manifest.firefox.json](src/manifest.firefox.json)
- [src/background.ts](src/background.ts)
- [src/content.ts](src/content.ts)
- [src/popup.html](src/popup.html)

Notes:
- Add icons and other static assets into `public/`.
- The build script writes the final `manifest.json` into `dist/<target>/manifest.json` after running `vite build`.
- You can customize `src/manifest.<target>.json` to add target-specific overrides.
