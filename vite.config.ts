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
  build: {
    rollupOptions: {
      output: {
        // Vendor libs rarely change between deploys; splitting them into their
        // own chunk lets the browser reuse a cached copy across app updates
        // instead of re-downloading React/Supabase on every release.
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-supabase': ['@supabase/supabase-js'],
        },
      },
    },
  },
})
