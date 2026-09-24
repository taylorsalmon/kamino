import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          // the desktop board
          index: resolve(__dirname, 'src/renderer/index.html'),
          // the phone board, served by the phone link (src/main/remote-server.ts)
          remote: resolve(__dirname, 'src/renderer/remote.html')
        }
      }
    }
  }
})
