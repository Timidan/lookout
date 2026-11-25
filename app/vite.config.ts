import { defineConfig, loadEnv } from 'vite'
import manifest from './app.json'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const base = env.VITE_API_BASE || 'http://localhost:8790'
  const permissions = manifest.permissions.map(permission => permission.name === 'network'
    ? { ...permission, whitelist: [new URL(base).origin] }
    : permission)
  const source = JSON.stringify({ ...manifest, permissions }, null, 2)
  return {
    base: './',
    define: { 'import.meta.env.VITE_API_BASE': JSON.stringify(base) },
    plugins: [{
      name: 'backend-permission',
      configureServer(server) {
        server.middlewares.use('/app.json', (_req, res) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(source)
        })
      },
      generateBundle() { this.emitFile({ type: 'asset', fileName: 'app.json', source }) },
    }],
  }
})
