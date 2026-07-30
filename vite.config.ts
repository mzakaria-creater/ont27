import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Same-origin /api in dev → local Hono server (httpOnly cookies work unchanged)
      '/api': 'http://localhost:8787',
    },
  },
})
