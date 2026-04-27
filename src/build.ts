import { rmSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'fs'

import { $, build } from 'bun'

type Manifest = {
  version: string
  background: {
    scripts?: string[]
    service_worker?: string
  }
  browser_specific_settings?: unknown
  [key: string]: unknown
}

const targets = ['chrome', 'firefox'] as const

const baseManifest = JSON.parse(
  readFileSync('./src/manifest.json', 'utf-8'),
) as Manifest
baseManifest.version = process.env.npm_package_version!

rmSync('./dist', { recursive: true, force: true })

for (const target of targets) {
  const outdir = `./dist/${target}`
  mkdirSync(outdir, { recursive: true })
  cpSync('./assets', `${outdir}/assets`, { recursive: true })
  cpSync(
    './node_modules/lindera-wasm-web/lindera_wasm_bg.wasm',
    `${outdir}/assets/lindera_wasm_bg.wasm`,
  )
  const manifest = structuredClone(baseManifest)
  if (target === 'chrome') {
    manifest.background = { service_worker: 'background.js' }
    delete manifest.browser_specific_settings
  }
  writeFileSync(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2))
  await build({
    entrypoints: [
      './src/popup.html',
      './src/content.ts',
      './src/background.ts',
    ],
    outdir,
    minify: true,
    sourcemap: true,
  })
  writeFileSync(
    `${outdir}/background.js`,
    readFileSync(`${outdir}/background.js`, 'utf-8')
      .replace(
        'new URL("lindera_wasm_bg.wasm",import.meta.url)',
        `chrome.runtime.getURL("assets/lindera_wasm_bg.wasm")`,
      )
      .replace(
        'new URL("lindera_wasm_bg.wasm", import.meta.url)',
        `chrome.runtime.getURL("assets/lindera_wasm_bg.wasm")`,
      ),
  )
  if (target === 'firefox') await $`cd ${outdir} && zip -qr ../firefox.xpi .`
  // else
  //   await $`cd ${outdir} && /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --pack-extension=. --pack-extension-key="../../chrome.pem"`
}
