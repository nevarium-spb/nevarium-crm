import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { defaultExclude } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT) || 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            proxyReq.setHeader('x-forwarded-host', req.headers.host || '')
          })
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
    // Без этого vitest подхватывает копии тестов из .claude/worktrees/* (проект
    // ведётся в git worktree, и внутри рабочей копии лежит вложенная копия всего
    // репозитория) — тесты задваиваются, а полный прогон не укладывается в таймаут.
    // Спред defaultExclude обязателен: exclude заменяет умолчания целиком, а не
    // дополняет их — без него сюда же попал бы весь node_modules.
    exclude: [...defaultExclude, '**/.claude/**'],
  },
})
