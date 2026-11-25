import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import multer from 'multer'
import { z } from 'zod'

const port = Number(process.env.PORT ?? 3001)
const dataDirectory = path.resolve(process.env.DATA_DIR ?? './data')
const uploadDirectory = path.join(dataDirectory, 'uploads')
mkdirSync(uploadDirectory, { recursive: true })

const db = new Database(path.join(dataDirectory, 'montrack.sqlite'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    accepted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS records (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    payload TEXT,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, kind, record_id)
  );
  CREATE TABLE IF NOT EXISTS sync_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    payload TEXT,
    version INTEGER NOT NULL,
    deleted INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sync_events_user_sequence ON sync_events(user_id, sequence);
  CREATE TABLE IF NOT EXISTS sync_operations (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY (user_id, operation_id)
  );
`)

const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase()
const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD
if (bootstrapEmail && bootstrapPassword && !db.prepare('SELECT id FROM users WHERE email = ?').get(bootstrapEmail)) {
  db.prepare('INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run(randomUUID(), bootstrapEmail, bootstrapEmail.split('@')[0], bcrypt.hashSync(bootstrapPassword, 12), new Date().toISOString())
}

interface UserRow {
  id: string
  email: string
  name: string
  is_admin: number
}

declare global {
  namespace Express {
    interface Request {
      user?: UserRow
    }
  }
}

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const sessionCookie = (token: string, maxAge: number) =>
  `mt_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
const readCookie = (request: Request, name: string) => {
  const cookies = request.headers.cookie?.split(';') ?? []
  const cookie = cookies.map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
  return cookie?.slice(name.length + 1)
}
const createSession = (userId: string, response: Response) => {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString()
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hash(token), userId, expiresAt)
  response.setHeader('Set-Cookie', sessionCookie(token, 60 * 60 * 24 * 30))
}

const auth = (request: Request, response: Response, next: NextFunction) => {
  const token = readCookie(request, 'mt_session')
  if (!token) return response.status(401).json({ error: 'Authentication required' })
  const row = db.prepare(`
    SELECT users.id, users.email, users.name, users.is_admin
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(hash(token), new Date().toISOString()) as UserRow | undefined
  if (!row) return response.status(401).json({ error: 'Session expired' })
  request.user = row
  next()
}

const adminOnly = (request: Request, response: Response, next: NextFunction) => {
  if (!request.user?.is_admin) return response.status(403).json({ error: 'Administrator access required' })
  next()
}

app.get('/api/health', (_request, response) => response.json({ ok: true }))

app.post('/api/auth/login', async (request, response) => {
  const parsed = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }).safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: 'Enter a valid email and password' })
  const user = db.prepare('SELECT id, email, name, password_hash, is_admin FROM users WHERE email = ?')
    .get(parsed.data.email.trim().toLowerCase()) as (UserRow & { password_hash: string }) | undefined
  if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
    return response.status(401).json({ error: 'Email or password is incorrect' })
  }
  createSession(user.id, response)
  response.json({ id: user.id, email: user.email, name: user.name, isAdmin: Boolean(user.is_admin) })
})

app.post('/api/auth/logout', auth, (request, response) => {
  const token = readCookie(request, 'mt_session')
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token))
  response.setHeader('Set-Cookie', sessionCookie('', 0))
  response.json({ ok: true })
})

app.get('/api/me', auth, (request, response) => {
  const user = request.user!
  response.json({ id: user.id, email: user.email, name: user.name, isAdmin: Boolean(user.is_admin) })
})

app.get('/api/invitations/:token', (request, response) => {
  const row = db.prepare('SELECT email, expires_at, accepted_at FROM invitations WHERE token_hash = ?')
    .get(hash(request.params.token)) as { email: string; expires_at: string; accepted_at: string | null } | undefined
  if (!row || row.accepted_at || row.expires_at < new Date().toISOString()) {
    return response.status(404).json({ error: 'This invitation is invalid or expired' })
  }
  response.json({ email: row.email })
})

app.post('/api/invitations/accept', async (request, response) => {
  const parsed = z.object({ token: z.string().min(20), name: z.string().trim().min(1).max(80), password: z.string().min(10).max(200) })
    .safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: 'Use a name and a password of at least 10 characters' })
  const invitation = db.prepare('SELECT id, email, expires_at, accepted_at FROM invitations WHERE token_hash = ?')
    .get(hash(parsed.data.token)) as { id: string; email: string; expires_at: string; accepted_at: string | null } | undefined
  if (!invitation || invitation.accepted_at || invitation.expires_at < new Date().toISOString()) {
    return response.status(404).json({ error: 'This invitation is invalid or expired' })
  }
  const userId = randomUUID()
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, invitation.email, parsed.data.name, bcrypt.hashSync(parsed.data.password, 12), new Date().toISOString())
      db.prepare('UPDATE invitations SET accepted_at = ? WHERE id = ?').run(new Date().toISOString(), invitation.id)
    })()
  } catch {
    return response.status(409).json({ error: 'An account already exists for this invitation' })
  }
  createSession(userId, response)
  response.status(201).json({ id: userId, email: invitation.email, name: parsed.data.name, isAdmin: false })
})

app.post('/api/admin/invitations', auth, adminOnly, (request, response) => {
  const parsed = z.object({ email: z.string().email().max(254) }).safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: 'Enter a valid email address' })
  const email = parsed.data.email.trim().toLowerCase()
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return response.status(409).json({ error: 'A user with this email already exists' })
  }
  const token = randomBytes(32).toString('base64url')
  const id = randomUUID()
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString()
  db.prepare('INSERT INTO invitations (id, token_hash, email, expires_at) VALUES (?, ?, ?, ?)').run(id, hash(token), email, expiresAt)
  response.status(201).json({ id, email, token, expiresAt })
})

const kinds = ['account', 'adjustment', 'category', 'project', 'tag', 'transaction', 'debt'] as const
const changeSchema = z.object({
  operationId: z.string().uuid(),
  kind: z.enum(kinds),
  recordId: z.string().min(1).max(100),
  baseVersion: z.number().int().min(0),
  payload: z.unknown().nullable(),
  deleted: z.boolean(),
  createdAt: z.string().max(40),
})

app.post('/api/sync/push', auth, (request, response) => {
  const parsed = z.object({ changes: z.array(changeSchema).max(200) }).safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: 'Invalid sync batch' })
  const userId = request.user!.id
  const accepted: { operationId: string; version: number }[] = []
  const conflicts: {
    operationId: string; kind: string; recordId: string; localPayload: unknown; serverPayload: unknown; serverVersion: number
  }[] = []
  const persist = db.transaction(() => {
    for (const change of parsed.data.changes) {
      const priorOperation = db.prepare('SELECT version FROM sync_operations WHERE user_id = ? AND operation_id = ?')
        .get(userId, change.operationId) as { version: number } | undefined
      if (priorOperation) {
        accepted.push({ operationId: change.operationId, version: priorOperation.version })
        continue
      }
      const current = db.prepare('SELECT payload, version, deleted FROM records WHERE user_id = ? AND kind = ? AND record_id = ?')
        .get(userId, change.kind, change.recordId) as { payload: string | null; version: number; deleted: number } | undefined
      const serverVersion = current?.version ?? 0
      if (serverVersion !== change.baseVersion) {
        conflicts.push({
          operationId: change.operationId,
          kind: change.kind,
          recordId: change.recordId,
          localPayload: change.deleted ? null : change.payload,
          serverPayload: current?.deleted ? null : current?.payload ? JSON.parse(current.payload) : null,
          serverVersion,
        })
        continue
      }
      const version = serverVersion + 1
      const payload = change.deleted ? null : JSON.stringify(change.payload)
      const updatedAt = new Date().toISOString()
      db.prepare(`
        INSERT INTO records (user_id, kind, record_id, payload, version, updated_at, deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, kind, record_id) DO UPDATE SET
          payload = excluded.payload, version = excluded.version,
          updated_at = excluded.updated_at, deleted = excluded.deleted
      `).run(userId, change.kind, change.recordId, payload, version, updatedAt, Number(change.deleted))
      db.prepare('INSERT INTO sync_events (user_id, kind, record_id, payload, version, deleted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(userId, change.kind, change.recordId, payload, version, Number(change.deleted), updatedAt)
      db.prepare('INSERT INTO sync_operations (user_id, operation_id, version) VALUES (?, ?, ?)')
        .run(userId, change.operationId, version)
      accepted.push({ operationId: change.operationId, version })
    }
  })
  persist()
  response.json({ accepted, conflicts })
})

app.get('/api/sync/pull', auth, (request, response) => {
  const cursor = Math.max(0, Number.parseInt(String(request.query.cursor ?? '0'), 10) || 0)
  const events = db.prepare(`
    SELECT sequence, kind, record_id, payload, version, deleted
    FROM sync_events WHERE user_id = ? AND sequence > ? ORDER BY sequence LIMIT 1000
  `).all(request.user!.id, cursor) as {
    sequence: number; kind: string; record_id: string; payload: string | null; version: number; deleted: number
  }[]
  const changes = events.map((event) => ({
    kind: event.kind,
    recordId: event.record_id,
    payload: event.payload ? JSON.parse(event.payload) : null,
    version: event.version,
    deleted: Boolean(event.deleted),
  }))
  response.json({ cursor: String(events.at(-1)?.sequence ?? cursor), changes })
})

const storage = multer.diskStorage({
  destination: (request, _file, callback) => {
    const directory = path.join(uploadDirectory, request.user!.id)
    mkdirSync(directory, { recursive: true })
    callback(null, directory)
  },
  filename: (_request, file, callback) => callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase().slice(0, 10)}`),
})
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => callback(null, /^image\/(jpeg|png|webp|heic)$/.test(file.mimetype)),
})

app.post('/api/attachments/:transactionId', auth, upload.single('receipt'), (request, response) => {
  const row = db.prepare(`SELECT record_id FROM records WHERE user_id = ? AND kind = 'transaction' AND record_id = ? AND deleted = 0`)
    .get(request.user!.id, request.params.transactionId)
  if (!row) return response.status(404).json({ error: 'Transaction not found on the server yet' })
  if (!request.file) return response.status(400).json({ error: 'Choose a supported image under 8 MB' })
  response.status(201).json({ url: `/api/attachments/${request.file.filename}` })
})

app.get('/api/attachments/:filename', auth, (request, response) => {
  const filename = path.basename(String(request.params.filename))
  const file = path.join(uploadDirectory, request.user!.id, filename)
  if (!existsSync(file)) return response.status(404).end()
  response.sendFile(file)
})

app.get('/api/rates/:base', async (request, response) => {
  const base = request.params.base.toUpperCase()
  if (!/^[A-Z]{3}$/.test(base)) return response.status(400).json({ error: 'Invalid currency code' })
  try {
    const result = await fetch(`https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!result.ok) throw new Error('Rate provider unavailable')
    response.setHeader('Cache-Control', 'public, max-age=3600')
    response.json(await result.json())
  } catch {
    response.status(503).json({ error: 'Exchange rates are currently unavailable' })
  }
})

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error)
  response.status(500).json({ error: 'The request could not be completed' })
})

const staticDirectory = path.resolve('dist')
if (existsSync(staticDirectory)) {
  app.use(express.static(staticDirectory))
  app.get('/{*path}', (_request, response) => response.sendFile(path.join(staticDirectory, 'index.html')))
}

app.listen(port, '0.0.0.0', () => console.log(`MonTrack API listening on ${port}`))