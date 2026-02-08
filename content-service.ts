export interface RagAnswer {
  docId: string;
  title: string;
  publicPath: string;
  chunkId: string;
  excerpt: string;
  score: number;
}

export class ContentService {
  private logDev(...args: any[]) {
    try {
      // Only log verbose details in local development
      if ((import.meta as any)?.env?.DEV) console.error('[ui-dev]', ...args);
    } catch {}
  }

  private friendlyMessage(status: number, endpoint: string): string {
    if (status === 0) return `Tidak bisa menghubungi server (${endpoint}). Periksa koneksi internet Anda.`;
    if (status >= 500) return `Server sedang bermasalah (${status}) saat memanggil ${endpoint}. Coba lagi beberapa saat.`;
    if (status === 404) return `Sumber ${endpoint} tidak ditemukan. Pastikan server dev berjalan.`;
    if (status === 400) return `Permintaan ke ${endpoint} tidak valid. Mohon cek input.`;
    return `Terjadi kesalahan (${status}) saat memanggil ${endpoint}.`;
  }

  private async parseError(res: Response): Promise<string> {
    try {
      const type = res.headers.get('Content-Type') || '';
      if (type.includes('application/json')) {
        const j = await res.json();
        const basic = j?.error || j?.message || res.statusText;
        const details = j?.details ? ` | detail: ${j.details}` : '';
        return `${basic}${details}`;
      }
      const t = await res.text();
      return t || res.statusText || `HTTP ${res.status}`;
    } catch {
      return res.statusText || `HTTP ${res.status}`;
    }
  }

  /**
   * Fetch the indexed documents metadata
   */
  async getIndex(): Promise<{ docs: Array<{ id: string; title: string; publicPath: string; chunkCount: number }> }>{
    try {
      const res = await fetch('/api/content/index');
      if (!res.ok) {
        const detail = await this.parseError(res);
        this.logDev('getIndex failed:', res.status, detail);
        throw new Error(this.friendlyMessage(res.status, 'index'));
      }
      return res.json();
    } catch (e: any) {
      if (e?.name === 'TypeError' && String(e?.message || '').includes('fetch')) {
        this.logDev('getIndex network error:', e);
        throw new Error(this.friendlyMessage(0, 'index'));
      }
      this.logDev('getIndex unexpected error:', e);
      throw new Error(e?.message || 'Gagal mengambil indeks dokumen');
    }
  }

  /**
   * Trigger a rescan of public/content
   */
  async rescan(): Promise<{ ok: boolean; docs: number }>{
    try {
      const res = await fetch('/api/content/rescan', { method: 'POST' });
      if (!res.ok) {
        const detail = await this.parseError(res);
        this.logDev('rescan failed:', res.status, detail);
        throw new Error(this.friendlyMessage(res.status, 'rescan'));
      }
      return res.json();
    } catch (e: any) {
      if (e?.name === 'TypeError' && String(e?.message || '').includes('fetch')) {
        this.logDev('rescan network error:', e);
        throw new Error(this.friendlyMessage(0, 'rescan'));
      }
      this.logDev('rescan unexpected error:', e);
      throw new Error(e?.message || 'Gagal memindai ulang konten');
    }
  }

  /**
   * Query RAG for relevant chunks
   */
  async queryRag(question: string, topK: number = 5): Promise<RagAnswer[]> {
    try {
      const res = await fetch('/api/rag/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, topK })
      });
      if (!res.ok) {
        const detail = await this.parseError(res);
        this.logDev('queryRag failed:', res.status, detail);
        throw new Error(this.friendlyMessage(res.status, 'rag/query'));
      }
      const data = await res.json();
      return data.answers || [];
    } catch (e: any) {
      if (e?.name === 'TypeError' && String(e?.message || '').includes('fetch')) {
        this.logDev('queryRag network error:', e);
        throw new Error(this.friendlyMessage(0, 'rag/query'));
      }
      this.logDev('queryRag unexpected error:', e);
      throw new Error(e?.message || 'Gagal melakukan pencarian RAG');
    }
  }

  /**
   * Fetch all summaries (chunks) for preloading into the AI session
   */
  async getAllSummaries(): Promise<{ summaries: Array<{ id: string; title: string; chunks: Array<{ id: string; docId: string; text: string }> }> }>{
    try {
      const res = await fetch('/api/content/summaries');
      if (!res.ok) {
        const detail = await this.parseError(res);
        this.logDev('getAllSummaries failed:', res.status, detail);
        throw new Error(this.friendlyMessage(res.status, 'content/summaries'));
      }
      return res.json();
    } catch (e: any) {
      if (e?.name === 'TypeError' && String(e?.message || '').includes('fetch')) {
        this.logDev('getAllSummaries network error:', e);
        throw new Error(this.friendlyMessage(0, 'content/summaries'));
      }
      this.logDev('getAllSummaries unexpected error:', e);
      throw new Error(e?.message || 'Gagal mengambil konten dokumen dari server');
    }
  }
}