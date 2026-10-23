/**
 * Production process manager — starts the Express API server (port 3001)
 * and serves the Vite-built frontend via a tiny static file server (port 7860).
 *
 * HF Spaces requires the app to listen on port 7860.
 * The Vite build output in /dist is served statically.
 * All /api/* requests are proxied from the frontend server to the API server.
 */
const { spawn } = require('child_process')
const http = require('http')
const fs   = require('fs')
const path = require('path')
const url  = require('url')

const FRONTEND_PORT = 7860
const API_PORT      = 3001
const DIST_DIR      = path.join(__dirname, '../dist')

// ─── Start API server ────────────────────────────────────────────────────────
const api = spawn('bun', ['run', path.join(__dirname, '../server/index.ts')], {
  env: { ...process.env, PORT: String(API_PORT), NODE_ENV: 'production' },
  stdio: 'inherit',
})
api.on('exit', (code) => {
  console.error(`[start-prod] API server exited with code ${code}`)
  process.exit(1)
})

// ─── MIME types ──────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
}

// ─── Static + proxy server on port 7860 ──────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url)

  // Proxy /api/* to the Express backend
  if (parsedUrl.pathname && parsedUrl.pathname.startsWith('/api')) {
    const options = {
      hostname: '127.0.0.1',
      port:     API_PORT,
      path:     req.url,
      method:   req.method,
      headers:  { ...req.headers, host: `localhost:${API_PORT}` },
    }
    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers)
      proxyRes.pipe(res)
    })
    proxyReq.on('error', (e) => {
      console.error('[proxy]', e.message)
      res.writeHead(502).end(JSON.stringify({ error: 'API server unavailable' }))
    })
    req.pipe(proxyReq)
    return
  }

  // Serve static files from dist/
  let filePath = path.join(DIST_DIR, parsedUrl.pathname === '/' ? 'index.html' : parsedUrl.pathname)

  // SPA fallback: serve index.html for any path not matching a static file
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, 'index.html')
  }

  const ext = path.extname(filePath)
  const contentType = MIME[ext] || 'application/octet-stream'

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found')
      return
    }
    res.writeHead(200, { 'Content-Type': contentType })
    res.end(data)
  })
})

server.listen(FRONTEND_PORT, () => {
  console.log(`[start-prod] Frontend serving on :${FRONTEND_PORT}`)
  console.log(`[start-prod] API proxied from /api → :${API_PORT}`)
})
