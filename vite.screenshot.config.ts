import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const screenshotNames = new Set([
  'dashboard-demo.jpg',
  'servers-demo.jpg',
  'server-detail-demo.jpg',
  'gpu-overview-demo.jpg',
  'gpu-detail-demo.jpg',
  'ssh-workspace-demo.jpg',
  'ssh-picker-demo.jpg'
])

const screenshotUpload = {
  name: 'screenshot-upload',
  configureServer(server: { middlewares: { use(handler: (request: any, response: any, next: () => void) => void): void } }) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split('?')[0] !== '/__capture_upload') return next()
      if (request.method !== 'POST') {
        response.statusCode = 405
        response.end('POST only')
        return
      }
      const name = new URL(request.url, 'http://127.0.0.1').searchParams.get('name')
      if (!name || !screenshotNames.has(name)) {
        response.statusCode = 400
        response.end('Unrecognized screenshot name')
        return
      }
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', async () => {
        const image = Buffer.concat(chunks)
        if (image.length < 1024 || image.length > 5 * 1024 * 1024) {
          response.statusCode = 413
          response.end('Unexpected screenshot size')
          return
        }
        await writeFile(resolve('docs/screenshots', name), image)
        response.setHeader('Content-Type', 'text/plain; charset=utf-8')
        response.end(`Saved ${name}`)
      })
    })
  }
}

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), screenshotUpload],
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  server: {
    host: '127.0.0.1',
    port: 4317,
    strictPort: true,
    fs: { allow: [resolve()] }
  }
})
