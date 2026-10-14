import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import express, { type NextFunction, type Request, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isProduction = process.env.NODE_ENV === 'production'
const port = Number(process.env.PORT ?? 4173)
const host = process.env.HOST ?? '127.0.0.1'
const ollamaBaseUrl = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '')
const dataDirectory = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'))
mkdirSync(dataDirectory, { recursive: true })

const database = new Database(path.join(dataDirectory, 'yashu.sqlite'))
database.pragma('journal_mode = WAL')
database.pragma('foreign_keys = ON')
database.pragma('busy_timeout = 5000')
database.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, id);
`)

const app = express()
app.disable('x-powered-by')
app.use(helmet({ contentSecurityPolicy: isProduction ? undefined : false, crossOriginEmbedderPolicy: false }))
app.use(express.json({ limit: '1mb' }))
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }))
const httpServer = createHttpServer(app)

const listModels = async (): Promise<{ name: string; size: number }[]> => {
  const result = await fetch(`${ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) })
  if (!result.ok) throw new Error(`Ollama returned ${result.status}`)
  const data = await result.json() as { models?: { name: string; size: number }[] }
  return data.models ?? []
}

const getConversation = database.prepare('SELECT * FROM conversations WHERE id = ?')
const getMessages = database.prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id')
const listConversations = database.prepare(`
  SELECT c.*, COUNT(m.id) AS message_count
  FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
  GROUP BY c.id ORDER BY c.updated_at DESC
`)

app.get('/api/health', async (_request, response) => {
  try {
    const models = await listModels()
    response.json({ status: 'ok', ollama: 'connected', models: models.length })
  } catch {
    response.status(503).json({ status: 'degraded', ollama: 'disconnected', models: 0 })
  }
})

app.get('/api/models', async (_request, response) => {
  try {
    response.json({ models: await listModels() })
  } catch {
    response.status(503).json({ error: 'Ollama is unavailable. Start Ollama, then try again.' })
  }
})

app.get('/api/conversations', (_request, response) => {
  response.json(listConversations.all())
})

app.get('/api/conversations/:id', (request, response) => {
  const conversation = getConversation.get(request.params.id)
  if (!conversation) return response.status(404).json({ error: 'Conversation not found.' })
  response.json({ conversation, messages: getMessages.all(request.params.id) })
})

app.patch('/api/conversations/:id', (request, response) => {
  const title = typeof request.body?.title === 'string' ? request.body.title.trim().slice(0, 100) : ''
  if (!title) return response.status(400).json({ error: 'A conversation title is required.' })
  const result = database.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, new Date().toISOString(), request.params.id)
  if (!result.changes) return response.status(404).json({ error: 'Conversation not found.' })
  response.json({ ok: true })
})

app.delete('/api/conversations/:id', (request, response) => {
  const result = database.prepare('DELETE FROM conversations WHERE id = ?').run(request.params.id)
  if (!result.changes) return response.status(404).json({ error: 'Conversation not found.' })
  response.status(204).end()
})

app.post('/api/chat', async (request, response) => {
  const { conversationId, model, message } = request.body as { conversationId?: unknown; model?: unknown; message?: unknown }
  if (typeof message !== 'string' || !message.trim() || message.length > 20_000) {
    return response.status(400).json({ error: 'Enter a message between 1 and 20,000 characters.' })
  }
  if (typeof model !== 'string' || model.length > 200) return response.status(400).json({ error: 'Choose an available model.' })

  let availableModels: { name: string; size: number }[]
  try {
    availableModels = await listModels()
  } catch {
    return response.status(503).json({ error: 'Ollama is unavailable. Start Ollama, then try again.' })
  }
  if (!availableModels.some((item) => item.name === model)) {
    return response.status(400).json({ error: 'That model is not available in Ollama. Refresh and choose an installed model.' })
  }

  const id = typeof conversationId === 'string' ? conversationId : randomUUID()
  const conversation = getConversation.get(id)
  if (conversationId && !conversation) return response.status(404).json({ error: 'Conversation not found. Start a new conversation.' })
  const now = new Date().toISOString()
  const cleanMessage = message.trim()
  const isNewConversation = !conversation
  if (!conversation) database.prepare('INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, cleanMessage.slice(0, 48), model, now, now)
  const userMessage = database.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(id, 'user', cleanMessage, now)
  database.prepare('UPDATE conversations SET model = ?, updated_at = ? WHERE id = ?').run(model, now, id)
  const removeFailedTurn = () => {
    database.prepare('DELETE FROM messages WHERE id = ?').run(userMessage.lastInsertRowid)
    if (isNewConversation) database.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }

  const history = (getMessages.all(id) as { role: 'user' | 'assistant'; content: string }[]).slice(-32).map(({ role, content }) => ({ role, content }))
  const controller = new AbortController()
  response.on('close', () => { if (!response.writableEnded) controller.abort() })

  let upstream: globalThis.Response
  try {
    upstream = await fetch(`${ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true, messages: [
        { role: 'system', content: 'You are YaSHu, a thoughtful, clear, and helpful assistant. Answer naturally. When uncertain, say so.' },
        ...history,
      ] }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60 * 1000)]),
    })
  } catch {
    removeFailedTurn()
    return response.status(502).json({ error: 'Could not connect to the Ollama model. Check that it is running and try again.' })
  }
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '')
    removeFailedTurn()
    return response.status(502).json({ error: detail.slice(0, 300) || `Ollama returned ${upstream.status}.` })
  }

  response.status(200)
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  response.setHeader('Cache-Control', 'no-cache, no-transform')
  response.setHeader('Connection', 'keep-alive')
  response.setHeader('X-Accel-Buffering', 'no')
  response.flushHeaders()
  const emit = (payload: object) => response.write(`data: ${JSON.stringify(payload)}\n\n`)
  emit({ type: 'meta', conversationId: id })

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''
  let streamError = ''
  const saveAnswer = database.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
  const consumeLine = (line: string) => {
    if (!line.trim()) return
    try {
      const chunk = JSON.parse(line) as { message?: { content?: string }; error?: string }
      if (chunk.message?.content) {
        answer += chunk.message.content
        if (!response.destroyed) emit({ type: 'delta', content: chunk.message.content })
      }
      if (chunk.error) streamError = chunk.error
    } catch {
      streamError = 'The model returned an unreadable response.'
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      lines.forEach(consumeLine)
      if (done) break
    }
    if (buffer.trim()) consumeLine(buffer)
  } catch {
    if (!controller.signal.aborted) streamError = 'The model connection was interrupted.'
  } finally {
    reader.releaseLock()
  }

  if (answer) saveAnswer.run(id, 'assistant', answer, new Date().toISOString())
  database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
  if (!response.destroyed) {
    if (streamError) emit({ type: 'error', message: streamError })
    emit({ type: 'done', conversationId: id })
    response.end()
  }
})

if (isProduction) {
  app.use(express.static(path.join(root, 'dist'), { index: false, maxAge: '1h' }))
  app.get(/.*/, (_request, response) => response.sendFile(path.join(root, 'dist', 'index.html')))
} else {
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({ configFile: path.join(root, 'vite.config.ts'), server: { middlewareMode: true, hmr: { server: httpServer } }, appType: 'custom' })
  app.use(vite.middlewares)
  app.get(/.*/, async (request, response, next) => {
    try {
      const template = readFileSync(path.join(root, 'index.html'), 'utf8')
      const html = await vite.transformIndexHtml(request.originalUrl, template)
      response.status(200).type('html').send(html)
    } catch (error) {
      vite.ssrFixStacktrace(error as Error)
      next(error)
    }
  })
}

app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
  console.error('Request failed:', error.message)
  if (response.headersSent) return response.end()
  response.status(500).json({ error: 'Something went wrong. Please try again.' })
})

httpServer.listen(port, host, () => {
  console.log(`YaSHu AI listening at http://${host}:${port}`)
  console.log(`Ollama endpoint: ${ollamaBaseUrl}`)
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  httpServer.close(() => { database.close(); process.exit(0) })
})