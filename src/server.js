import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { encryptJson, decryptJson } from './vault.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const MAX_WORKER_QUEUE = Math.max(1, Number(process.env.MAX_WORKER_QUEUE || 20));
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', process.env.APP_ORIGIN || '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); });
app.use(express.json({ limit: '256kb' }));

const dataDir = path.resolve(process.env.DATABASE_FILE ? path.dirname(process.env.DATABASE_FILE) : './data'); fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.resolve(process.env.DATABASE_FILE || './data/cathprn.db'));
db.exec(`CREATE TABLE IF NOT EXISTS scrape_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, config TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK (id=1), payload TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, canonical_url TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, imported_at TEXT NOT NULL);`);
const runs = new Map(); const queue = []; const now = () => new Date().toISOString();
let worker; let activeWorkerRun = null; let workerBuffer = '';

function finishRun(id, result) { const entry = runs.get(id); if (entry) { entry.status = result.status; entry.result = result; } db.prepare('UPDATE scrape_runs SET status=?,result=?,updated_at=? WHERE id=?').run(result.status, JSON.stringify(result), now(), id); if (activeWorkerRun === id) activeWorkerRun = null; pumpQueue(); }
function updateProgress(id, progress) { db.prepare('UPDATE scrape_runs SET status=?,result=?,updated_at=? WHERE id=?').run('RUNNING', JSON.stringify({ status: 'RUNNING', progress }), now(), id); }
function handleWorkerMessage(line) { try { const msg = JSON.parse(line); if (!activeWorkerRun || msg.id !== activeWorkerRun) return; if (msg.type === 'progress') updateProgress(msg.id, msg.progress); else if (msg.type === 'result') finishRun(msg.id, msg.result); else if (msg.type === 'error') finishRun(msg.id, { status: 'FAILED', errors: [msg.error] }); } catch {} }
function startWorker() {
  worker = spawn(process.execPath, [path.join(process.cwd(), 'src/worker.js')], { stdio: ['pipe', 'pipe', 'inherit'] }); workerBuffer = '';
  worker.stdout.on('data', chunk => { workerBuffer += chunk.toString(); const lines = workerBuffer.split('\n'); workerBuffer = lines.pop() || ''; for (const line of lines) handleWorkerMessage(line); });
  worker.on('exit', code => { const id = activeWorkerRun; activeWorkerRun = null; if (id) finishRun(id, { status: 'FAILED', errors: [{ category: 'worker', message: `Worker exited with code ${code}` }] }); if (queue.length) setTimeout(startWorker, 250); });
}
function pumpQueue() { if (!worker || worker.exitCode !== null || activeWorkerRun || !queue.length) return; const id = queue.shift(); const entry = runs.get(id); if (!entry) return pumpQueue(); activeWorkerRun = id; entry.status = 'RUNNING'; db.prepare('UPDATE scrape_runs SET status=?,updated_at=? WHERE id=?').run('RUNNING', now(), id); worker.stdin.write(`${JSON.stringify({ type: 'scrape', id, config: entry.config })}\n`); }
startWorker();

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'CATHPRN', version: '3.0.0', worker: Boolean(worker && worker.exitCode === null), queued: queue.length, active: Boolean(activeWorkerRun) }));
app.post('/api/vault', (req, res) => { try { const payload = encryptJson(req.body); db.prepare('INSERT INTO vault(id,payload,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(JSON.stringify(payload), now()); res.status(201).json({ saved: true, updatedAt: now() }); } catch (error) { res.status(400).json({ error: error.message }); } });
app.post('/api/ai-scraper/test', (req, res) => { const config = { ...(req.body || {}) }; if (!/^https?:\/\//i.test(config.galleryUrl || '')) return res.status(400).json({ error: 'galleryUrl must be an http(s) URL' }); if (queue.length + (activeWorkerRun ? 1 : 0) >= MAX_WORKER_QUEUE) return res.status(429).json({ error: 'Scraper queue is full' }); const id = crypto.randomUUID(); const createdAt = now(); const record = { id, status: 'QUEUED', config, result: null, createdAt }; runs.set(id, record); db.prepare('INSERT INTO scrape_runs VALUES(?,?,?,?,?,?)').run(id, 'QUEUED', JSON.stringify(config), null, createdAt, createdAt); queue.push(id); pumpQueue(); res.status(202).json({ runId: id, status: 'QUEUED' }); });
app.get('/api/ai-scraper/runs/:id', (req, res) => { const row = db.prepare('SELECT * FROM scrape_runs WHERE id=?').get(req.params.id); if (!row) return res.sendStatus(404); res.json({ runId: row.id, status: row.status, config: JSON.parse(row.config), result: row.result ? JSON.parse(row.result) : null, createdAt: row.created_at, updatedAt: row.updated_at }); });
app.post('/api/ai-scraper/runs/:id/import', (req, res) => { const row = db.prepare('SELECT * FROM scrape_runs WHERE id=?').get(req.params.id); if (!row) return res.sendStatus(404); const result = row.result ? JSON.parse(row.result) : null; if (!result || result.status !== 'SUCCESS') return res.status(409).json({ error: 'Only a successful test run can be imported' }); const insert = db.prepare('INSERT OR IGNORE INTO videos(id,canonical_url,payload,imported_at) VALUES(?,?,?,?)'); let imported = 0; for (const item of result.items || []) { const saved = insert.run(crypto.randomUUID(), item.canonicalUrl || item.videoPageUrl, JSON.stringify(item), now()); imported += Number(saved.changes || 0); } res.status(201).json({ imported }); });
app.get('/api/videos', (_req, res) => res.json(db.prepare('SELECT id,canonical_url,payload,imported_at FROM videos ORDER BY imported_at DESC').all().map(row => ({ id: row.id, canonicalUrl: row.canonical_url, ...JSON.parse(row.payload), importedAt: row.imported_at }))));
app.post('/api/ai-scraper/runs/:id/pause', (req, res) => { if (activeWorkerRun !== req.params.id) return res.status(404).json({ error: 'Run is not active' }); worker.kill('SIGTERM'); db.prepare('UPDATE scrape_runs SET status=?,updated_at=? WHERE id=?').run('PAUSED', now(), req.params.id); activeWorkerRun = null; res.json({ paused: true }); });
app.post('/api/ai-scraper/runs/:id/resume', (req, res) => { const row = db.prepare('SELECT * FROM scrape_runs WHERE id=?').get(req.params.id); if (!row) return res.sendStatus(404); if (activeWorkerRun || queue.includes(row.id)) return res.status(409).json({ error: 'Run is already queued or active' }); if (queue.length >= MAX_WORKER_QUEUE) return res.status(429).json({ error: 'Scraper queue is full' }); runs.set(row.id, { id: row.id, status: 'QUEUED', config: JSON.parse(row.config), result: null, createdAt: row.created_at }); queue.push(row.id); db.prepare('UPDATE scrape_runs SET status=?,updated_at=? WHERE id=?').run('QUEUED', now(), row.id); if (!worker || worker.exitCode !== null) startWorker(); pumpQueue(); res.status(202).json({ resumed: true, runId: row.id, status: 'QUEUED' }); });
app.post('/api/vault/unlock', (req, res) => { try { const row = db.prepare('SELECT payload FROM vault WHERE id=1').get(); if (!row) return res.status(404).json({ error: 'Vault not configured' }); const data = decryptJson(JSON.parse(row.payload)); res.json({ unlocked: true, groups: Object.keys(data) }); } catch { res.status(401).json({ error: 'Unable to unlock vault' }); } });
const rootDir = process.cwd(); app.use(express.static(rootDir)); app.get('*', (req, res, next) => { if (req.path.startsWith('/api')) return next(); res.sendFile(path.join(rootDir, 'index.html')); });
app.listen(PORT, HOST, () => console.log(`CATHPRN server listening on http://${HOST}:${PORT}`));
