import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'

const version: string = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
// Changes on every build, so a redeploy without a version bump still counts as an update.
const build = `${version}-${Date.now().toString(36)}`

// The Android wrapper bundles the app itself, so it skips the service worker.
const android = process.env.VITE_TARGET === 'android'

// base './' lets the same build run at a domain root or under /repo-name/ on GitHub Pages.
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version), __APP_BUILD__: JSON.stringify(build) },
  build: android ? { outDir: 'android/assets/www', emptyOutDir: true } : {},
  plugins: [
    react(),
    // dist/version.json: what the live site runs. Never precached, so an open app can compare.
    {
      name: 'version-json',
      generateBundle() {
        if (!android) this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version, build }) })
      },
    },
    VitePWA({
      disable: android,
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Nutshell',
        short_name: 'Nutshell',
        description: 'Summarize WhatsApp group chats and pull out calendar events, with your own AI.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#eef7f3',
        theme_color: '#0e9f7e',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        share_target: {
          action: './share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            files: [
              {
                name: 'chat',
                accept: ['text/plain', 'application/zip', 'application/x-zip-compressed', '.txt', '.zip'],
              },
            ],
          },
        },
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}', '**/*latin-wght-normal*.woff2'],
      },
    }),
  ],
})
