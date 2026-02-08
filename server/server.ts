import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pdfParse from 'pdf-parse';
import MiniSearch, { SearchResult } from 'minisearch';

// Environment-aware constants
// Dev must NOT be detected as production just because 'dist' exists.
const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || (isProd ? 3000 : 8000);
const CONTENT_DIR = path.resolve(
  process.cwd(),
  isProd ? path.join('dist', 'content') : path.join('public', 'content')
);
const OUTPUT_DIR = path.resolve(process.cwd(), 'uploaded-content');
const PDF_INDEX_PATH = path.join(OUTPUT_DIR, 'pdfs-index.json');
const SUMMARIES_DIR = path.join(OUTPUT_DIR, 'summaries');
const SEARCH_INDEX_PATH = path.join(OUTPUT_DIR, 'search-index.json');

type DocMeta = {
  id: string;
  title: string;
  publicPath: string;
  hash: string;
  size: number;
  indexedAt: string;
  chunkCount: number;
};

type Chunk = {
  id: string; // chunkId = `${docId}-${i}`
  docId: string;
  text: string;
};

// In-memory state
let docsMeta: DocMeta[] = [];
let chunks: Chunk[] = [];
let miniSearch: MiniSearch | null = null;

function logDev(...args: any[]) {
  if (!isProd) {
    // Simple local logging for development
    try { console.error('[dev]', ...args); } catch {}
  }
}

function ensurePaths() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!fs.existsSync(SUMMARIES_DIR)) fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
  if (!fs.existsSync(PDF_INDEX_PATH)) fs.writeFileSync(PDF_INDEX_PATH, JSON.stringify({ docs: [] }, null, 2));
}

function listPdfFiles(): string[] {
  if (!fs.existsSync(CONTENT_DIR)) return [];
  const entries = fs.readdirSync(CONTENT_DIR);
  return entries
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .map((f) => path.join(CONTENT_DIR, f));
}

function computeFileHash(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const buf = fs.readFileSync(filePath);
  hash.update(buf);
  return hash.digest('hex');
}

async function extractPdfText(filePath: string): Promise<string> {
  const dataBuffer = fs.readFileSync(filePath);
  const result = await pdfParse(dataBuffer);
  // result.text is the full text; for v1 we keep it simple
  return result.text || '';
}

function normalizeText(text: string): string {
  // Basic cleanup: collapse whitespace
  return text
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function chunkText(fullText: string, docId: string): Chunk[] {
  const maxChunkChars = 4000;
  const overlapChars = 400;
  const chunks: Chunk[] = [];

  const text = normalizeText(fullText);
  let start = 0;
  let index = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChunkChars, text.length);
    const chunkText = text.slice(start, end);
    chunks.push({ id: `${docId}-${index}`, docId, text: chunkText });
    if (end >= text.length) break;
    start = end - overlapChars;
    if (start < 0) start = 0;
    index++;
  }
  return chunks;
}

function buildSearchIndex(allChunks: Chunk[]): MiniSearch {
  const ms = new MiniSearch({
    fields: ['text'],
    storeFields: ['docId', 'text'],
    searchOptions: { fuzzy: 0.2, prefix: true }
  });
  ms.addAll(allChunks.map((c) => ({ id: c.id, text: c.text, docId: c.docId })));
  return ms;
}

function saveDocsMeta(meta: DocMeta[]) {
  fs.writeFileSync(PDF_INDEX_PATH, JSON.stringify({ docs: meta }, null, 2));
}

function saveDocChunks(docId: string, docTitle: string, docChunks: Chunk[]) {
  const payload = { id: docId, title: docTitle, chunks: docChunks.map((c) => ({ id: c.id, docId: c.docId, text: c.text })) };
  const filePath = path.join(SUMMARIES_DIR, `${docId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

async function ingestAll(): Promise<void> {
  ensurePaths();
  const files = listPdfFiles();
  const newDocsMeta: DocMeta[] = [];
  const newChunks: Chunk[] = [];

  for (const filePath of files) {
    const stat = fs.statSync(filePath);
    const title = path.basename(filePath);
    const publicPath = `/content/${path.basename(filePath)}`;
    const hash = computeFileHash(filePath);
    const docId = hash.slice(0, 12); // short id

    let fullText = '';
    try {
      fullText = await extractPdfText(filePath);
    } catch (err) {
      console.error(`Failed to extract PDF text: ${title}`, err);
      fullText = '';
    }

    const docChunks = chunkText(fullText, docId);
    newChunks.push(...docChunks);

    newDocsMeta.push({
      id: docId,
      title,
      publicPath,
      hash,
      size: stat.size,
      indexedAt: new Date().toISOString(),
      chunkCount: docChunks.length,
    });

    // Persist per-doc chunks for debugging/inspection
    saveDocChunks(docId, title, docChunks);
  }

  // Build and persist meta
  docsMeta = newDocsMeta;
  saveDocsMeta(docsMeta);

  // Build MiniSearch in-memory index
  chunks = newChunks;
  miniSearch = buildSearchIndex(chunks);
}

function searchChunks(question: string, topK: number = 5): Array<{
  docId: string;
  title: string;
  publicPath: string;
  chunkId: string;
  excerpt: string;
  score: number;
}> {
  if (!miniSearch) return [];
  const results: SearchResult[] = miniSearch.search(question, { prefix: true, fuzzy: 0.2 });
  const limited = results.slice(0, topK);

  const titleByDocId = new Map(docsMeta.map((m) => [m.id, m.title]));
  const pathByDocId = new Map(docsMeta.map((m) => [m.id, m.publicPath]));
  const textByChunkId = new Map(chunks.map((c) => [c.id, c.text]));
  const docIdByChunkId = new Map(chunks.map((c) => [c.id, c.docId]));

  return limited.map((r) => {
    const chunkId = String(r.id);
    const docId = docIdByChunkId.get(chunkId) || '';
    const title = titleByDocId.get(docId) || '';
    const publicPath = pathByDocId.get(docId) || '';
    const text = textByChunkId.get(chunkId) || '';
    const excerpt = text.length > 500 ? text.slice(0, 500) + '…' : text;
    return { docId, title, publicPath, chunkId, excerpt, score: r.score || 0 };
  });
}

// Express app
const app = express();
app.use(express.json({ limit: '2mb' }));
// Basic CORS for dev (frontend on Vite 5173)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// --- API routes (base) ---
app.get('/content/index', (_req, res) => {
  try {
    if (!fs.existsSync(PDF_INDEX_PATH)) return res.json({ docs: [] });
    const data = JSON.parse(fs.readFileSync(PDF_INDEX_PATH, 'utf-8'));
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read index', details: String(err) });
  }
});

app.post('/content/rescan', async (_req, res) => {
  try {
    await ingestAll();
    return res.json({ ok: true, docs: docsMeta.length });
  } catch (err) {
    return res.status(500).json({ error: 'Rescan failed', details: String(err) });
  }
});

// Return all summaries (chunks) for preloading into AI session
app.get('/content/summaries', (_req, res) => {
  try {
    ensurePaths();
    const payload = docsMeta.map((m) => {
      const filePath = path.join(SUMMARIES_DIR, `${m.id}.json`);
      if (!fs.existsSync(filePath)) {
        return { id: m.id, title: m.title, chunks: [] };
      }
      let data: any = { chunks: [] };
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch (err) {
        // Fallback per-file: don't break the whole endpoint
        logDev(`Failed to parse summary JSON for doc ${m.id} (${m.title}):`, String(err));
        return { id: m.id, title: m.title, chunks: [] };
      }
      // Limit each chunk text length for transmission safety
      const trimmedChunks = (data.chunks || []).map((c: any) => ({
        id: String(c.id),
        docId: String(c.docId),
        text: typeof c.text === 'string' ? (c.text.length > 4000 ? c.text.slice(0, 4000) + '…' : c.text) : ''
      }));
      return { id: m.id, title: m.title, chunks: trimmedChunks };
    });
    return res.json({ summaries: payload });
  } catch (err) {
    logDev('Summaries endpoint failed:', String(err));
    return res.status(500).json({ error: 'Failed to read summaries', details: String(err) });
  }
});

app.post('/rag/query', (req, res) => {
  try {
    const { question, topK } = req.body || {};
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Missing question' });
    }
    const k = typeof topK === 'number' ? topK : 5;
    const answers = searchChunks(question, k);
    return res.json({ answers });
  } catch (err) {
    return res.status(500).json({ error: 'Query failed', details: String(err) });
  }
});

// --- API routes alias under /api to match frontend ---
app.get('/api/content/index', (_req, res) => {
  try {
    if (!fs.existsSync(PDF_INDEX_PATH)) return res.json({ docs: [] });
    const data = JSON.parse(fs.readFileSync(PDF_INDEX_PATH, 'utf-8'));
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read index', details: String(err) });
  }
});

app.post('/api/content/rescan', async (_req, res) => {
  try {
    await ingestAll();
    return res.json({ ok: true, docs: docsMeta.length });
  } catch (err) {
    return res.status(500).json({ error: 'Rescan failed', details: String(err) });
  }
});

app.get('/api/content/summaries', (_req, res) => {
  try {
    ensurePaths();
    const payload = docsMeta.map((m) => {
      const filePath = path.join(SUMMARIES_DIR, `${m.id}.json`);
      if (!fs.existsSync(filePath)) {
        return { id: m.id, title: m.title, chunks: [] };
      }
      let data: any = { chunks: [] };
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch (err) {
        logDev(`Failed to parse summary JSON for doc ${m.id} (${m.title}):`, String(err));
        return { id: m.id, title: m.title, chunks: [] };
      }
      const trimmedChunks = (data.chunks || []).map((c: any) => ({
        id: String(c.id),
        docId: String(c.docId),
        text: typeof c.text === 'string' ? (c.text.length > 4000 ? c.text.slice(0, 4000) + '…' : c.text) : ''
      }));
      return { id: m.id, title: m.title, chunks: trimmedChunks };
    });
    return res.json({ summaries: payload });
  } catch (err) {
    logDev('Summaries endpoint failed:', String(err));
    return res.status(500).json({ error: 'Failed to read summaries', details: String(err) });
  }
});

app.post('/api/rag/query', (req, res) => {
  try {
    const { question, topK } = req.body || {};
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Missing question' });
    }
    const k = typeof topK === 'number' ? topK : 5;
    const answers = searchChunks(question, k);
    return res.json({ answers });
  } catch (err) {
    return res.status(500).json({ error: 'Query failed', details: String(err) });
  }
});

// --- Static serving for production ---
if (isProd) {
  const distDir = path.resolve(process.cwd(), 'dist');
  app.use(express.static(distDir));
  // SPA fallback: route non-API requests to index.html
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).end();
    const indexPath = path.join(distDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    return res.status(404).send('index.html not found');
  });
}

// Startup
(async () => {
  ensurePaths();
  await ingestAll();
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
    console.log(`[server] mode: ${isProd ? 'production' : 'development'}`);
    console.log(`[server] content dir: ${CONTENT_DIR}`);
  });
})();