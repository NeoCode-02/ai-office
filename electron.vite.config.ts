import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // SDKs are bundled into main so the packaged app ships no node_modules.
  main: { build: { externalizeDeps: false } },
  preload: {},
  renderer: { plugins: [react()], build: { minify: true } }
})
