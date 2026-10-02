import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// jsdom so Builders 2/3 can mount the board view with @vue/test-utils; the data
// layer specs themselves only need Vue reactivity.
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    include: ['src/**/__tests__/**/*.spec.js']
  }
})
