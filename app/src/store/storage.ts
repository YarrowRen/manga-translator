import type { OcrResult } from './workbenchContext'

const PREFIX = 'mt:'
const TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

interface Stored<T> {
  data: T
  expiresAt: number
}

// ── File hash ─────────────────────────────────────────────────────────────────
// SHA-1 of first 64 KB — fast, content-based, practically collision-free

export async function computeFileHash(file: File): Promise<string> {
  const buf = await file.slice(0, 65536).arrayBuffer()
  const hash = await crypto.subtle.digest('SHA-1', buf)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

// ── OCR results → localStorage (24 h TTL) ────────────────────────────────────

export function saveOcrResults(imageId: string, results: OcrResult[]): void {
  const item: Stored<OcrResult[]> = { data: results, expiresAt: Date.now() + TTL_MS }
  try {
    localStorage.setItem(`${PREFIX}ocr:${imageId}`, JSON.stringify(item))
  } catch {
    // quota exceeded — silently skip, in-memory cache still works
  }
}

export function loadOcrResults(imageId: string): OcrResult[] {
  try {
    const raw = localStorage.getItem(`${PREFIX}ocr:${imageId}`)
    if (!raw) return []
    const item: Stored<OcrResult[]> = JSON.parse(raw)
    if (Date.now() > item.expiresAt) {
      localStorage.removeItem(`${PREFIX}ocr:${imageId}`)
      return []
    }
    return item.data
  } catch {
    return []
  }
}

export function removeOcrResults(imageId: string): void {
  localStorage.removeItem(`${PREFIX}ocr:${imageId}`)
}

// ── Inpainted URL → sessionStorage (tab lifetime) ────────────────────────────

export function saveInpaintedUrl(imageId: string, url: string): void {
  try {
    sessionStorage.setItem(`${PREFIX}inpaint:${imageId}`, url)
  } catch {
    // base64 too large — skip
  }
}

export function loadInpaintedUrl(imageId: string): string {
  return sessionStorage.getItem(`${PREFIX}inpaint:${imageId}`) ?? ''
}

export function removeInpaintedUrl(imageId: string): void {
  sessionStorage.removeItem(`${PREFIX}inpaint:${imageId}`)
}

// ── Cleanup expired localStorage entries (call on app boot) ──────────────────

export function cleanupExpired(): void {
  const toDelete: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(PREFIX)) continue
    try {
      const item = JSON.parse(localStorage.getItem(key)!)
      if (item?.expiresAt && Date.now() > item.expiresAt) toDelete.push(key)
    } catch {
      toDelete.push(key)
    }
  }
  toDelete.forEach(k => localStorage.removeItem(k))
}
