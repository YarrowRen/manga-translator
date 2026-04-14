import {
  createContext, useContext, useState, useCallback, useEffect,
  type ReactNode,
} from 'react'
import {
  computeFileHash,
  saveOcrResults, loadOcrResults, removeOcrResults,
  saveInpaintedUrl, loadInpaintedUrl, removeInpaintedUrl,
  cleanupExpired,
} from './storage'

export interface OcrResult {
  id: number
  text: string
  confidence: number
  bbox: [number, number, number, number]
  polygon: [number, number][] | null
  is_merged: boolean
  original_count: number
  original_texts: string[]
  translation: string | null
}

interface ImageCache {
  ocrResults: OcrResult[]
  inpaintedUrl: string
}

interface WorkbenchContextValue {
  images: File[]
  imageIds: string[]       // parallel to images; computed hash, '' while pending
  currentIdx: number
  ocrResults: OcrResult[]  // for current image
  inpaintedUrl: string     // for current image
  hashedAll: boolean       // true once all current images have IDs

  addImages: (files: File[]) => Promise<void>
  clearImages: () => void
  setCurrentIdx: (idx: number) => void
  setOcrResults: (imageId: string, results: OcrResult[] | ((prev: OcrResult[]) => OcrResult[])) => void
  setInpaintedUrl: (imageId: string, url: string) => void
  resetPageData: (imageId: string) => void
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null)

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [images, setImages] = useState<File[]>([])
  const [imageIds, setImageIds] = useState<string[]>([])
  // In-memory cache: imageId → { ocrResults, inpaintedUrl }
  const [cache, setCache] = useState<Record<string, ImageCache>>({})
  const [currentIdx, setCurrentIdxState] = useState(0)

  // Cleanup stale localStorage entries on mount
  useEffect(() => { cleanupExpired() }, [])

  // Derived
  const currentId = imageIds[currentIdx] ?? ''
  const currentCache = cache[currentId] ?? { ocrResults: [], inpaintedUrl: '' }
  const hashedAll = images.length > 0 && imageIds.length === images.length && imageIds.every(Boolean)

  // ── Add images ──────────────────────────────────────────────────────────────

  const addImages = useCallback(async (files: File[]) => {
    // Compute hashes in parallel
    const hashes = await Promise.all(files.map(computeFileHash))

    // Deduplicate against already-loaded images
    const existingIds = new Set(imageIds)
    const newFiles: File[] = []
    const newIds: string[] = []
    hashes.forEach((id, i) => {
      if (!existingIds.has(id)) {
        newFiles.push(files[i])
        newIds.push(id)
      }
    })
    if (newFiles.length === 0) return

    // Load any previously cached OCR/inpaint data for these files
    const newCache: Record<string, ImageCache> = {}
    newIds.forEach(id => {
      newCache[id] = {
        ocrResults: loadOcrResults(id),
        inpaintedUrl: loadInpaintedUrl(id),
      }
    })

    setImages(prev => [...prev, ...newFiles])
    setImageIds(prev => [...prev, ...newIds])
    setCache(prev => ({ ...prev, ...newCache }))
  }, [imageIds])

  // ── Clear all images ────────────────────────────────────────────────────────

  const clearImages = useCallback(() => {
    setImages([])
    setImageIds([])
    setCache({})
    setCurrentIdxState(0)
  }, [])

  // ── Navigation ──────────────────────────────────────────────────────────────

  const setCurrentIdx = useCallback((idx: number) => {
    setCurrentIdxState(idx)
  }, [])

  // ── OCR results ─────────────────────────────────────────────────────────────

  const setOcrResults = useCallback((
    imageId: string,
    results: OcrResult[] | ((prev: OcrResult[]) => OcrResult[])
  ) => {
    setCache(prev => {
      const existing = prev[imageId] ?? { ocrResults: [], inpaintedUrl: '' }
      const next = typeof results === 'function' ? results(existing.ocrResults) : results
      saveOcrResults(imageId, next)
      return { ...prev, [imageId]: { ...existing, ocrResults: next } }
    })
  }, [])

  // ── Inpainted URL ───────────────────────────────────────────────────────────

  const setInpaintedUrl = useCallback((imageId: string, url: string) => {
    setCache(prev => {
      const existing = prev[imageId] ?? { ocrResults: [], inpaintedUrl: '' }
      saveInpaintedUrl(imageId, url)
      return { ...prev, [imageId]: { ...existing, inpaintedUrl: url } }
    })
  }, [])

  // ── Reset per-image data ────────────────────────────────────────────────────

  const resetPageData = useCallback((imageId: string) => {
    removeOcrResults(imageId)
    removeInpaintedUrl(imageId)
    setCache(prev => ({
      ...prev,
      [imageId]: { ocrResults: [], inpaintedUrl: '' },
    }))
  }, [])

  return (
    <WorkbenchContext.Provider value={{
      images,
      imageIds,
      currentIdx,
      ocrResults: currentCache.ocrResults,
      inpaintedUrl: currentCache.inpaintedUrl,
      hashedAll,
      addImages,
      clearImages,
      setCurrentIdx,
      setOcrResults,
      setInpaintedUrl,
      resetPageData,
    }}>
      {children}
    </WorkbenchContext.Provider>
  )
}

export function useWorkbench() {
  const ctx = useContext(WorkbenchContext)
  if (!ctx) throw new Error('useWorkbench must be used inside WorkbenchProvider')
  return ctx
}
