import {
  useState, useRef, useEffect, useCallback,
  type RefCallback,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { useWorkbench, type OcrResult } from '../store/workbenchContext'
import { translateBatch } from '../services/translationService'
import { inpaintRegions } from '../services/inpaintService'
import { recognizeText } from '../services/ocrService'
import {
  parseGalleryUrl, fetchGalleryInfo, fetchGalleryPages,
  type GalleryInfo,
} from '../services/ehentaiService'
import {
  Upload, FolderOpen, ScanText, Languages, Type,
  Trash2, Settings, ChevronLeft, ChevronRight, X,
  Zap, ChevronDown, Check, AlertCircle, Info, Link,
} from 'lucide-react'
import { useTheme, type ThemeMode } from '../hooks/useTheme'

// ─────────────────────────────────────────────────────────────────────────────
// Constants & types
// ─────────────────────────────────────────────────────────────────────────────

interface OcrParams {
  det_limit_type: 'max' | 'min'
  det_limit_side_len: number
  confidence_threshold: number
}

interface MergeParams {
  mergeExpandRatio: number
  mergeMaxDistance: number
  mergeMinGroupSize: number
}

type ToastType = 'info' | 'success' | 'error'

interface Toast {
  id: number
  msg: string
  type: ToastType
}

const PIPELINE_LABELS = ['OCR 识别', '翻译文字', '消除原文', '文字替换']

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function isImageFile(f: File) { return f.type.startsWith('image/') }

// ─────────────────────────────────────────────────────────────────────────────
// Text fit (ported from AutoTranslate.vue)
// ─────────────────────────────────────────────────────────────────────────────

function fitTextToContainer(el: HTMLElement, text: string) {
  const container = el.parentElement
  if (!container) return
  container.offsetHeight
  const s = window.getComputedStyle(container)
  const cw = container.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)
  const ch = container.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)
  if (cw <= 0 || ch <= 0) return

  el.textContent = text
  Object.assign(el.style, {
    overflow: 'hidden', width: '100%', height: '100%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    textAlign: 'center', writingMode: 'horizontal-tb',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  })

  let lo = 6, hi = 100, best = lo, attempts = 0
  while (lo <= hi && attempts < 20) {
    attempts++
    const mid = Math.floor((lo + hi) / 2)
    el.style.fontSize = mid + 'px'
    el.style.lineHeight = '1.2'
    el.offsetHeight
    if (el.scrollWidth <= cw && el.scrollHeight <= ch) { best = mid; lo = mid + 1 }
    else hi = mid - 1
  }
  el.style.fontSize = best + 'px'
  for (const lh of [1.0, 1.1, 1.2, 1.3, 1.4]) {
    el.style.lineHeight = String(lh)
    el.offsetHeight
    if (el.scrollWidth > cw || el.scrollHeight > ch) {
      el.style.lineHeight = String(Math.max(1.0, lh - 0.1))
      break
    }
  }
  el.style.opacity = '1'
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export default function Workbench() {
  const navigate = useNavigate()
  const {
    images, imageIds, currentIdx, ocrResults, inpaintedUrl, hashedAll,
    addImages, clearImages, setCurrentIdx, setOcrResults, setInpaintedUrl, resetPageData,
  } = useWorkbench()

  const { mode: themeMode, setMode: setThemeMode } = useTheme()

  const [isSmall, setIsSmall] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    setIsSmall(mq.matches)
    const handler = (e: MediaQueryListEvent) => setIsSmall(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const themeCycle: ThemeMode[] = ['light', 'dark', 'system']
  const themeIcon: Record<ThemeMode, string> = { light: '☀', dark: '☾', system: '⊙' }
  const cycleTheme = () => {
    const next = themeCycle[(themeCycle.indexOf(themeMode) + 1) % themeCycle.length]
    setThemeMode(next)
  }

  const currentImage = images[currentIdx]
  const currentId = imageIds[currentIdx] ?? ''

  // Image preview URL
  const [imageUrl, setImageUrl] = useState('')
  useEffect(() => {
    if (!currentImage) { setImageUrl(''); return }
    const url = URL.createObjectURL(currentImage)
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [currentImage])

  // Mobile drawer (results panel)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)

  // Processing states
  const [ocrProcessing, setOcrProcessing] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [inpainting, setInpainting] = useState(false)
  const [pipelineRunning, setPipelineRunning] = useState(false)
  const [pipelineStep, setPipelineStep] = useState(-1)

  // UI states
  const [showBoxes, setShowBoxes] = useState(true)
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [deleteMode, setDeleteMode] = useState(false)
  const [selectedForDelete, setSelectedForDelete] = useState<Set<number>>(new Set())
  const [textReplaceMode, setTextReplaceMode] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Language
  const [sourceLanguage, setSourceLanguage] = useState('japan')
  const [targetLanguage, setTargetLanguage] = useState('zh')

  // OCR params
  const [ocrParams, setOcrParams] = useState<OcrParams>({
    det_limit_type: 'max',
    det_limit_side_len: 960,
    confidence_threshold: 0.7,
  })

  // Merge params
  const [mergeParams, setMergeParams] = useState<MergeParams>({
    mergeExpandRatio: 1.05,
    mergeMaxDistance: 10,
    mergeMinGroupSize: 2,
  })

  // Text fit
  const textFitRefs = useRef<Record<number, HTMLElement | null>>({})
  const textFitApplied = useRef<Set<number>>(new Set())

  // Per-box text color (auto-detected from background brightness)
  const [boxTextColors, setBoxTextColors] = useState<Record<number, string>>({})

  // Force re-render tick (used by ResizeObserver to re-calculate box positions)
  const [, setRenderTick] = useState(0)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Toast notifications
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastCounter = useRef(0)

  const showToast = useCallback((msg: string, type: ToastType = 'info', duration = 3000) => {
    const id = ++toastCounter.current
    setToasts(prev => [...prev.slice(-2), { id, msg, type }])
    if (type !== 'error') setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration)
  }, [])

  // Gallery (e-hentai / exhentai URL 加载)
  const [galleryUrlInput, setGalleryUrlInput] = useState('')
  const [galleryLoading, setGalleryLoading] = useState(false)
  const [gallery, setGallery] = useState<GalleryInfo & { loadedCount: number } | null>(null)
  const [showUrlInput, setShowUrlInput] = useState(false)

  // 当接近已加载末尾时，自动加载后续页
  useEffect(() => {
    if (!gallery || galleryLoading) return
    const remaining = gallery.totalPages - gallery.loadedCount
    if (remaining <= 0) return
    if (currentIdx >= gallery.loadedCount - 2) {
      const from = gallery.loadedCount + 1
      const to = Math.min(from + 2, gallery.totalPages)
      setGalleryLoading(true)
      fetchGalleryPages(gallery, from, to, p => showToast(`加载第 ${p} 页...`, 'info', 1500))
        .then(files => {
          if (files.length) addImages(files)
          setGallery(g => g ? { ...g, loadedCount: g.loadedCount + files.length } : g)
        })
        .catch(e => showToast(`加载失败: ${e.message}`, 'error'))
        .finally(() => setGalleryLoading(false))
    }
  }, [currentIdx, gallery]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleGalleryLoad = async () => {
    const parsed = parseGalleryUrl(galleryUrlInput.trim())
    if (!parsed) { showToast('URL 格式不正确，应为 e-hentai.org/g/{id}/{token}/', 'error'); return }
    setGalleryLoading(true)
    try {
      const info = await fetchGalleryInfo(parsed.gid, parsed.token, parsed.isEx)
      clearImages()
      setGallery(null)
      showToast(`加载画廊：${info.title}（共 ${info.totalPages} 页）`, 'info', 4000)
      const preloadTo = Math.min(3, info.totalPages)
      const files = await fetchGalleryPages(info, 1, preloadTo, p => showToast(`加载第 ${p} 页...`, 'info', 1500))
      await addImages(files)
      setGallery({ ...info, loadedCount: files.length })
      setCurrentIdx(0)
      setShowUrlInput(false)
      setGalleryUrlInput('')
    } catch (e: any) {
      showToast(e.message || '画廊加载失败', 'error')
    } finally {
      setGalleryLoading(false)
    }
  }

  // Refs
  const imgRef = useRef<HTMLImageElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  // ── Reset UI on image switch ──────────────────────────────────────────────

  const prevIdxRef = useRef(-1)
  useEffect(() => {
    if (prevIdxRef.current === currentIdx) return
    prevIdxRef.current = currentIdx
    setSelectedIdx(null)
    setDeleteMode(false)
    setSelectedForDelete(new Set())
    textFitRefs.current = {}
    textFitApplied.current = new Set()
    // Auto-restore text replace if this page already has translations + inpaint
    const hasData = ocrResults.some(r => r.translation) && !!inpaintedUrl
    setTextReplaceMode(hasData)
  }, [currentIdx]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── ResizeObserver: re-render boxes + re-fit text on container resize ───────

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const ro = new ResizeObserver(() => {
      setRenderTick(n => n + 1)
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => {
        if (!textReplaceMode) return
        textFitApplied.current = new Set()
        ocrResults.forEach(r => {
          if (r.translation) {
            const fitEl = textFitRefs.current[r.id]
            if (fitEl) {
              fitTextToContainer(fitEl, r.translation)
              textFitApplied.current.add(r.id)
            }
          }
        })
      }, 150)
    })

    ro.observe(el)
    return () => {
      ro.disconnect()
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
    }
  }, [textReplaceMode, ocrResults]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Upload handlers ───────────────────────────────────────────────────────

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(isImageFile)
    if (!files.length) return
    await addImages(files)
    showToast(`已加载 ${files.length} 张图片`, 'success')
    e.target.value = ''
  }

  const handleFolderChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
      .filter(isImageFile)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    if (!files.length) { showToast('文件夹中没有找到图片', 'error'); return }
    await addImages(files)
    showToast(`已加载文件夹，共 ${files.length} 张图片`, 'success')
    e.target.value = ''
  }

  // ── OCR ───────────────────────────────────────────────────────────────────

  const performOCR = async () => {
    if (!currentImage || !currentId) { showToast('请先上传图片', 'error'); return }
    setOcrProcessing(true)
    showToast('正在进行 OCR 识别...', 'info')
    try {
      const base64 = await fileToBase64(currentImage)
      const rawResults = await recognizeText(base64, { language: sourceLanguage, ...ocrParams, ...mergeParams })
      const results: OcrResult[] = rawResults.map((r, i) => ({
        id: i, text: r.text, confidence: r.confidence,
        bbox: r.bbox as [number, number, number, number],
        polygon: r.polygon as [number, number][] | null,
        is_merged: r.is_merged || false,
        original_count: r.original_count || 1,
        original_texts: r.original_texts || [r.text],
        translation: null,
      }))
      setOcrResults(currentId, results)
      showToast(`识别完成，共 ${results.length} 个文本区域`, 'success')
    } catch (e: any) {
      showToast('OCR 出错: ' + e.message, 'error')
    } finally { setOcrProcessing(false) }
  }

  // ── Translation ───────────────────────────────────────────────────────────

  const translateAll = async () => {
    if (!currentId || !ocrResults.length) { showToast('没有可翻译的文本', 'error'); return }
    setTranslating(true)
    showToast(`翻译中，共 ${ocrResults.length} 个文本...`, 'info')
    try {
      const translations = await translateBatch(
        ocrResults.map(r => r.text),
        sourceLanguage,
        targetLanguage,
      )
      setOcrResults(currentId, prev =>
        prev.map((r, i) => ({ ...r, translation: translations[i] ?? null }))
      )
      showToast('翻译完成', 'success')
    } catch (e: any) {
      showToast('翻译出错: ' + e.message, 'error')
    } finally { setTranslating(false) }
  }

  // ── Inpaint (internal, returns success flag) ─────────────────────────────

  const performInpaint = async (): Promise<boolean> => {
    if (!currentImage || !currentId || !ocrResults.length) {
      showToast('请先完成 OCR 识别', 'error'); return false
    }
    setInpainting(true)
    showToast('正在消除文字...', 'info')
    const t0 = performance.now()
    try {
      const base64 = await fileToBase64(currentImage)
      const resultUrl = await inpaintRegions(
        base64,
        ocrResults.map(r => r.bbox),
        ocrResults.map(r => r.polygon),
      )
      setInpaintedUrl(currentId, resultUrl)
      showToast(`消除完成，耗时 ${((performance.now() - t0) / 1000).toFixed(2)}s`, 'success')
      return true
    } catch (e: any) {
      showToast('消除失败: ' + e.message, 'error')
      return false
    } finally { setInpainting(false) }
  }

  // ── Full pipeline ─────────────────────────────────────────────────────────

  const runFullPipeline = async () => {
    if (!currentImage || !currentId) { showToast('请先上传图片', 'error'); return }
    setPipelineRunning(true)
    setPipelineStep(0)
    setTextReplaceMode(false)
    textFitRefs.current = {}
    textFitApplied.current = new Set()
    resetPageData(currentId)

    try {
      const base64 = await fileToBase64(currentImage)

      // Step 1: OCR
      const rawResults = await recognizeText(base64, { language: sourceLanguage, ...ocrParams, ...mergeParams })
      if (!rawResults.length) { showToast('未检测到文字', 'info'); return }
      const results: OcrResult[] = rawResults.map((r, i) => ({
        id: i, text: r.text, confidence: r.confidence,
        bbox: r.bbox as [number, number, number, number],
        polygon: r.polygon as [number, number][] | null,
        is_merged: r.is_merged || false,
        original_count: r.original_count || 1,
        original_texts: r.original_texts || [r.text],
        translation: null,
      }))
      setOcrResults(currentId, results)

      // Step 2: Translate
      setPipelineStep(1)
      const translations = await translateBatch(results.map(r => r.text), sourceLanguage, targetLanguage)
      const translated = results.map((r, i) => ({ ...r, translation: translations[i] ?? null }))
      setOcrResults(currentId, translated)

      // Step 3: Inpaint
      setPipelineStep(2)
      setInpainting(true)
      const resultUrl = await inpaintRegions(
        base64,
        translated.map(r => r.bbox),
        translated.map(r => r.polygon),
      )
      setInpaintedUrl(currentId, resultUrl)
      setInpainting(false)

      // Step 4: Text replace
      setPipelineStep(3)
      textFitApplied.current = new Set()
      setTextReplaceMode(true)
      showToast('一键翻译完成', 'success')
    } catch (e: any) {
      showToast('流程出错: ' + e.message, 'error')
      setInpainting(false)
    } finally {
      setPipelineRunning(false)
      setPipelineStep(-1)
    }
  }

  // ── Delete mode ───────────────────────────────────────────────────────────

  const toggleDeleteMode = () => {
    if (deleteMode) {
      if (selectedForDelete.size > 0) {
        const indices = Array.from(selectedForDelete).sort((a, b) => b - a)
        setOcrResults(currentId, prev => {
          const next = [...prev]
          indices.forEach(i => next.splice(i, 1))
          return next.map((r, i) => ({ ...r, id: i }))
        })
        setInpaintedUrl(currentId, '')
        if (textReplaceMode) {
          setTextReplaceMode(false)
          textFitRefs.current = {}
          textFitApplied.current = new Set()
        }
        showToast(`已删除 ${selectedForDelete.size} 个识别结果`, 'success')
      }
      setDeleteMode(false)
      setSelectedForDelete(new Set())
    } else {
      setDeleteMode(true)
      setSelectedIdx(null)
      setSelectedForDelete(new Set())
      showToast('点击文本框选择要删除的结果', 'info')
    }
  }

  const toggleSelectForDelete = (idx: number) => {
    setSelectedForDelete(prev => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
  }

  // ── Text replace mode ─────────────────────────────────────────────────────

  const hasTranslations = ocrResults.some(r => r.translation?.trim())

  const toggleTextReplace = async () => {
    if (textReplaceMode) {
      setTextReplaceMode(false)
      textFitRefs.current = {}
      textFitApplied.current = new Set()
      return
    }
    if (!hasTranslations) { showToast('请先完成翻译', 'error'); return }
    if (!inpaintedUrl) {
      const ok = await performInpaint()
      if (!ok) return
    }
    textFitApplied.current = new Set()
    setTextReplaceMode(true)
  }

  const setTextFitRef: (idx: number) => RefCallback<HTMLElement> = idx => el => {
    textFitRefs.current[idx] = el
    if (el && !textFitApplied.current.has(idx)) {
      const r = ocrResults.find(r => r.id === idx)
      if (r?.translation) {
        requestAnimationFrame(() => {
          if (el) { fitTextToContainer(el, r.translation!); textFitApplied.current.add(idx) }
        })
      }
    }
  }

  useEffect(() => {
    if (!textReplaceMode) return
    textFitApplied.current = new Set()
    setTimeout(() => {
      ocrResults.forEach(r => {
        if (r.translation) {
          const el = textFitRefs.current[r.id]
          if (el) { fitTextToContainer(el, r.translation); textFitApplied.current.add(r.id) }
        }
      })
    }, 80)
  }, [textReplaceMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-detect text color from background brightness ────────────────────

  useEffect(() => {
    if (!textReplaceMode) { setBoxTextColors({}); return }
    const imgSrc = inpaintedUrl || imageUrl
    if (!imgSrc || !ocrResults.length) return

    const tempImg = new Image()
    tempImg.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = tempImg.naturalWidth
      canvas.height = tempImg.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(tempImg, 0, 0)
      const colors: Record<number, string> = {}
      for (const result of ocrResults) {
        const [x1, y1, x2, y2] = result.bbox
        const sw = Math.max(1, Math.round(x2 - x1))
        const sh = Math.max(1, Math.round(y2 - y1))
        try {
          const data = ctx.getImageData(Math.round(x1), Math.round(y1), sw, sh)
          let rSum = 0, gSum = 0, bSum = 0
          const n = data.data.length / 4
          for (let i = 0; i < data.data.length; i += 4) {
            rSum += data.data[i]; gSum += data.data[i + 1]; bSum += data.data[i + 2]
          }
          const lum = (rSum / n * 0.299 + gSum / n * 0.587 + bSum / n * 0.114) / 255
          colors[result.id] = lum > 0.5 ? '#111' : '#fff'
        } catch {
          colors[result.id] = '#111'
        }
      }
      setBoxTextColors(colors)
    }
    tempImg.src = imgSrc
  }, [textReplaceMode, inpaintedUrl, imageUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Box positioning ───────────────────────────────────────────────────────

  const getBoxStyle = (bbox: [number, number, number, number]): React.CSSProperties => {
    const img = imgRef.current, cont = containerRef.current
    if (!img || !cont || !img.naturalWidth) return { display: 'none' }
    const ir = img.getBoundingClientRect(), cr = cont.getBoundingClientRect()
    const sx = img.clientWidth / img.naturalWidth, sy = img.clientHeight / img.naturalHeight
    const [x1, y1, x2, y2] = bbox
    return {
      position: 'absolute',
      left: Math.round(ir.left - cr.left + x1 * sx) + 'px',
      top: Math.round(ir.top - cr.top + y1 * sy) + 'px',
      width: Math.round((x2 - x1) * sx) + 'px',
      height: Math.round((y2 - y1) * sy) + 'px',
    }
  }

  const handleBoxClick = (idx: number) => {
    if (deleteMode) toggleSelectForDelete(idx)
    else setSelectedIdx(prev => prev === idx ? null : idx)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  const busy = ocrProcessing || translating || inpainting || pipelineRunning

  return (
    <div className="flex flex-col" style={{ height: '100dvh', background: 'var(--bg)', color: 'var(--text-1)', overflow: 'hidden' }}>

      {/* ── Hidden file inputs ── */}
      <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />
      <input ref={folderInputRef} type="file"
        // @ts-expect-error non-standard
        webkitdirectory="" className="hidden" onChange={handleFolderChange} />

      {/* ── Header ── */}
      <header style={{
        height: 56, display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 16px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface)', flexShrink: 0, boxShadow: 'var(--shadow-sm)',
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 15, color: 'var(--text-1)', flexShrink: 0 }}>
          <span className="hidden sm:inline">MangaTrans</span>
        </div>

        {/* Divider */}
        <div className="hidden sm:block" style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px', flexShrink: 0 }} />

        {/* Upload buttons */}
        <HeaderBtn icon={<Upload size={14} />} label="上传图片" onClick={() => fileInputRef.current?.click()} />
        <HeaderBtn icon={<FolderOpen size={14} />} label="上传文件夹" onClick={() => folderInputRef.current?.click()} />
        <HeaderBtn icon={<Link size={14} />} label="URL" onClick={() => setShowUrlInput(v => !v)} />

        {/* URL input popup */}
        {showUrlInput && (
          <div className="flex items-center gap-1.5 fade-in">
            <input
              type="text"
              value={galleryUrlInput}
              onChange={e => setGalleryUrlInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !galleryLoading && handleGalleryLoad()}
              placeholder="https://e-hentai.org/g/..."
              autoFocus
              style={{
                height: 32, padding: '0 10px', borderRadius: 6,
                border: '1px solid var(--border)', background: 'var(--surface)',
                color: 'var(--text-1)', fontSize: 13, outline: 'none', width: 240,
              }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
            <button
              onClick={handleGalleryLoad}
              disabled={galleryLoading || !galleryUrlInput.trim()}
              style={{ height: 32, padding: '0 12px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}>
              {galleryLoading ? '加载中...' : '加载'}
            </button>
            <button onClick={() => setShowUrlInput(false)}
              style={{ width: 32, height: 32, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <X size={13} />
            </button>
          </div>
        )}

        {/* Gallery info badge */}
        {gallery && !showUrlInput && (
          <span className="hidden md:inline text-xs px-2 py-1 rounded truncate max-w-[200px]"
            style={{ background: 'var(--accent-bg)', color: 'var(--accent)', border: '1px solid var(--accent-border)' }}>
            {gallery.title}
          </span>
        )}

        {/* Page navigation */}
        {images.length > 0 && (
          <div className="flex items-center gap-1" style={{ marginLeft: 4 }}>
            <button
              onClick={() => setCurrentIdx(Math.max(0, currentIdx - 1))}
              disabled={currentIdx === 0}
              style={{ width: 32, height: 32, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--shadow-sm)' }}
              onMouseEnter={e => { if (!e.currentTarget.disabled) { e.currentTarget.style.background = 'var(--elevated)'; e.currentTarget.style.color = 'var(--text-1)' } }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.color = 'var(--text-2)' }}>
              <ChevronLeft size={14} />
            </button>
            <span style={{ fontSize: 13, color: 'var(--text-2)', padding: '0 8px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {currentIdx + 1}
              <span style={{ color: 'var(--text-3)' }}>/</span>
              {gallery ? gallery.totalPages : images.length}
              {gallery && gallery.loadedCount < gallery.totalPages && (
                <span style={{ color: 'var(--text-3)', fontSize: 11 }}> ({gallery.loadedCount}↓)</span>
              )}
            </span>
            <button
              onClick={() => setCurrentIdx(Math.min(images.length - 1, currentIdx + 1))}
              disabled={currentIdx === images.length - 1}
              style={{ width: 32, height: 32, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--shadow-sm)' }}
              onMouseEnter={e => { if (!e.currentTarget.disabled) { e.currentTarget.style.background = 'var(--elevated)'; e.currentTarget.style.color = 'var(--text-1)' } }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.color = 'var(--text-2)' }}>
              <ChevronRight size={14} />
            </button>
            {currentImage && (
              <span className="hidden lg:inline text-xs ml-1 truncate max-w-[140px]" style={{ color: 'var(--text-3)' }}>
                {currentImage.name}
              </span>
            )}
            {!hashedAll && images.length > 0 && (
              <span className="text-xs ml-1 pulse" style={{ color: 'var(--text-3)' }}>●</span>
            )}
          </div>
        )}

        <div style={{ flex: 1 }} />

        {/* Theme toggle */}
        {isSmall ? (
          <button onClick={cycleTheme} title={themeMode}
            style={{ width: 34, height: 34, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, flexShrink: 0 }}>
            {themeIcon[themeMode]}
          </button>
        ) : (
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', flexShrink: 0 }}>
            {themeCycle.map(m => (
              <button key={m} onClick={() => setThemeMode(m)}
                title={m === 'light' ? '浅色' : m === 'dark' ? '深色' : '跟随系统'}
                style={{
                  padding: '5px 9px', fontSize: 13, cursor: 'pointer', border: 'none', fontFamily: 'inherit',
                  background: themeMode === m ? 'var(--accent)' : 'var(--surface)',
                  color: themeMode === m ? '#fff' : 'var(--text-2)',
                }}>
                {themeIcon[m]}
              </button>
            ))}
          </div>
        )}

        {/* Settings */}
        <button onClick={() => navigate('/settings')}
          style={{ width: 34, height: 34, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--shadow-sm)', flexShrink: 0 }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--elevated)'; e.currentTarget.style.color = 'var(--text-1)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.color = 'var(--text-2)' }}>
          <Settings size={15} />
        </button>
      </header>

      {/* ── Pipeline progress bar ── */}
      {pipelineRunning && pipelineStep >= 0 && (
        <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexShrink: 0, padding: '8px 16px' }}
          className="fade-in">
          <div className="flex items-center gap-3 flex-wrap">
            {PIPELINE_LABELS.map((label, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium ${i === pipelineStep ? 'pulse' : ''}`}
                  style={{
                    background: i < pipelineStep ? 'var(--green-bg)' : i === pipelineStep ? 'var(--accent-bg)' : 'var(--elevated)',
                    color: i < pipelineStep ? 'var(--green)' : i === pipelineStep ? 'var(--accent)' : 'var(--text-3)',
                    border: `1px solid ${i < pipelineStep ? 'rgba(26,127,55,0.3)' : i === pipelineStep ? 'var(--accent-border)' : 'var(--border)'}`,
                  }}>
                  {i < pipelineStep ? <Check size={10} /> : i + 1}
                </div>
                <span className="text-xs hidden sm:inline"
                  style={{ color: i < pipelineStep ? 'var(--green)' : i === pipelineStep ? 'var(--accent)' : 'var(--text-3)' }}>
                  {label}
                </span>
                {i < 3 && <div className="w-4 h-px hidden sm:block" style={{ background: 'var(--border)' }} />}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Main content ── */}
      <div className="flex flex-col md:flex-row flex-1 min-h-0">

        {/* ── Image area ── */}
        <div className="flex flex-col flex-1 min-h-0">

          <ImagePanelWrapper
            containerRef={containerRef}
            imgRef={imgRef}
            imageUrl={imageUrl}
            inpaintedUrl={inpaintedUrl}
            ocrResults={ocrResults}
            showBoxes={showBoxes}
            textReplaceMode={textReplaceMode}
            selectedIdx={selectedIdx}
            selectedForDelete={selectedForDelete}
            boxTextColors={boxTextColors}
            getBoxStyle={getBoxStyle}
            handleBoxClick={handleBoxClick}
            setTextFitRef={setTextFitRef}
            onUploadClick={() => fileInputRef.current?.click()}
          />

          {/* ── Mobile-only: action bar below image ── */}
          <div className="md:hidden shrink-0" style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)' }}>
            {/* Primary action row */}
            <div style={{ padding: '12px 12px 6px' }}>
              <MobileActionBtn
                icon={pipelineRunning ? <span className="spinner" /> : <Zap size={15} />}
                label={pipelineRunning ? `${PIPELINE_LABELS[pipelineStep] ?? '处理中'}...` : '一键翻译'}
                onClick={runFullPipeline} disabled={!imageUrl || !currentId || busy} variant="primary" fullWidth
              />
            </div>
            {/* Secondary actions row */}
            <div style={{ padding: '0 12px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <MobileActionBtn
                icon={ocrProcessing ? <span className="spinner" /> : <ScanText size={14} />}
                label={ocrProcessing ? '识别中' : '识别'}
                onClick={performOCR} disabled={!imageUrl || !currentId || busy} variant="default"
              />
              <MobileActionBtn
                icon={translating ? <span className="spinner" /> : <Languages size={14} />}
                label={translating ? '翻译中' : '翻译'}
                onClick={translateAll} disabled={!ocrResults.length || busy} variant="default"
              />
              <MobileActionBtn
                icon={inpainting ? <span className="spinner" /> : <Type size={14} />}
                label={inpainting ? '消除中' : textReplaceMode ? '退出' : '替换'}
                onClick={toggleTextReplace} disabled={!hasTranslations || busy}
                variant={textReplaceMode ? 'active' : 'default'}
              />
              <MobileActionBtn
                icon={<Trash2 size={14} />}
                label={deleteMode ? (selectedForDelete.size > 0 ? `删除${selectedForDelete.size}` : '取消') : '删除'}
                onClick={toggleDeleteMode} disabled={!ocrResults.length}
                variant={deleteMode ? (selectedForDelete.size > 0 ? 'danger' : 'active') : 'default'}
              />
              {/* Results drawer toggle */}
              <button
                onClick={() => setMobileDrawerOpen(v => !v)}
                className="flex items-center justify-center gap-1 shrink-0 ml-auto"
                style={{
                  minWidth: 44, height: 44, borderRadius: 6,
                  background: mobileDrawerOpen ? 'var(--accent-light)' : 'var(--surface)',
                  border: `1px solid ${mobileDrawerOpen ? 'var(--accent-border)' : 'var(--border)'}`,
                  color: mobileDrawerOpen ? 'var(--accent)' : 'var(--text-2)',
                  cursor: 'pointer',
                }}>
                {ocrResults.length > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'inherit' }}>{ocrResults.length}</span>
                )}
                <ChevronDown size={13} style={{ transform: mobileDrawerOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.25s' }} />
              </button>
            </div>
          </div>

          {/* ── Mobile-only: collapsible results drawer ── */}
          <div className="md:hidden shrink-0 overflow-hidden"
            style={{
              maxHeight: mobileDrawerOpen ? '48dvh' : 0,
              transition: 'max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
              background: 'var(--surface)',
              borderTop: mobileDrawerOpen ? '1px solid var(--border)' : 'none',
            }}>
            {/* Lang + controls row */}
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <LangSelect value={sourceLanguage} onChange={setSourceLanguage} options={[
                { value: 'japan', label: '日语' }, { value: 'en', label: '英语' },
                { value: 'ch', label: '中文' },
              ]} />
              <span style={{ color: 'var(--text-3)', fontSize: 12 }}>→</span>
              <LangSelect value={targetLanguage} onChange={setTargetLanguage} options={[
                { value: 'zh', label: '中文' },
              ]} />
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                <div onClick={() => setShowBoxes(v => !v)} style={{ width: 32, height: 16, borderRadius: 8, background: showBoxes ? 'var(--accent)' : 'var(--border)', cursor: 'pointer', position: 'relative', flexShrink: 0 }}>
                  <div style={{ position: 'absolute', top: 2, width: 12, height: 12, borderRadius: '50%', background: '#fff', transition: 'left 0.15s', left: showBoxes ? 18 : 2 }} />
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-2)' }}>框</span>
              </div>
            </div>
            {/* Results */}
            <div style={{ overflowY: 'auto', padding: '12px 16px', maxHeight: 'calc(48dvh - 58px)' }}>
              <ResultsList
                ocrResults={ocrResults} hasImage={!!imageUrl}
                selectedIdx={selectedIdx} selectedForDelete={selectedForDelete}
                handleBoxClick={handleBoxClick}
              />
            </div>
          </div>
        </div>

        {/* ── Desktop-only: controls + results side panel ── */}
        <div className="hidden md:flex flex-col min-h-0"
          style={{ width: 420, background: 'var(--surface)', borderLeft: '1px solid var(--border)' }}>

          {/* Action bar */}
          <div style={{ flexShrink: 0, padding: '16px 16px', borderBottom: '1px solid var(--border)' }}>
            {/* Primary button */}
            <ActionBtn
              icon={pipelineRunning ? <span className="spinner" /> : <Zap size={14} />}
              label={pipelineRunning ? `${PIPELINE_LABELS[pipelineStep] ?? '处理中'}...` : '一键翻译'}
              onClick={runFullPipeline} disabled={!imageUrl || !currentId || busy} variant="primary" fullWidth
            />
            {/* Secondary buttons */}
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <ActionBtn
                icon={ocrProcessing ? <span className="spinner" /> : <ScanText size={14} />}
                label={ocrProcessing ? '识别中...' : '识别'}
                onClick={performOCR} disabled={!imageUrl || !currentId || busy} variant="default" grow
              />
              <ActionBtn
                icon={translating ? <span className="spinner" /> : <Languages size={14} />}
                label={translating ? '翻译中...' : '翻译'}
                onClick={translateAll} disabled={!ocrResults.length || busy} variant="default" grow
              />
              <ActionBtn
                icon={inpainting ? <span className="spinner" /> : <Type size={14} />}
                label={inpainting ? '消除中...' : textReplaceMode ? '退出替换' : '替换'}
                onClick={toggleTextReplace} disabled={!hasTranslations || busy}
                variant={textReplaceMode ? 'active' : 'default'} grow
              />
              <ActionBtn
                icon={<Trash2 size={14} />}
                label={deleteMode ? (selectedForDelete.size > 0 ? `删除(${selectedForDelete.size})` : '取消') : '删除'}
                onClick={toggleDeleteMode} disabled={!ocrResults.length}
                variant={deleteMode ? (selectedForDelete.size > 0 ? 'danger' : 'active') : 'default'} grow
              />
            </div>

            {/* Language + toggles */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <LangSelect value={sourceLanguage} onChange={setSourceLanguage} options={[
                { value: 'japan', label: '日语' }, { value: 'en', label: '英语' },
                { value: 'ch', label: '中文' },
              ]} />
              <span style={{ color: 'var(--text-3)', fontSize: 12 }}>→</span>
              <LangSelect value={targetLanguage} onChange={setTargetLanguage} options={[
                { value: 'zh', label: '中文' },
              ]} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', cursor: 'pointer' }}>
                <div onClick={() => setShowBoxes(v => !v)} style={{ width: 32, height: 16, borderRadius: 8, background: showBoxes ? 'var(--accent)' : 'var(--border)', cursor: 'pointer', position: 'relative', flexShrink: 0 }}>
                  <div style={{ position: 'absolute', top: 2, width: 12, height: 12, borderRadius: '50%', background: '#fff', transition: 'left 0.15s', left: showBoxes ? 18 : 2 }} />
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-2)', userSelect: 'none' }}>框</span>
              </label>
              <button onClick={() => setShowAdvanced(v => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, padding: '4px 8px', borderRadius: 6, background: 'transparent', border: '1px solid transparent', color: 'var(--text-3)', cursor: 'pointer', fontFamily: 'inherit' }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-2)'; e.currentTarget.style.borderColor = 'var(--border)' }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-3)'; e.currentTarget.style.borderColor = 'transparent' }}>
                高级
                <ChevronDown size={11} style={{ transform: showAdvanced ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
              </button>
            </div>

            {showAdvanced && (
              <div style={{ marginTop: 12, background: 'var(--elevated)', borderRadius: 6, padding: '12px', border: '1px solid var(--border)' }}
                className="fade-in">
                {/* OCR params */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                  {[
                    {
                      label: '检测模式', type: 'select' as const,
                      value: ocrParams.det_limit_type,
                      options: [{ value: 'max', label: 'max' }, { value: 'min', label: 'min' }],
                      onChange: (v: string) => setOcrParams(p => ({ ...p, det_limit_type: v as 'max' | 'min' })),
                    },
                    {
                      label: '边长限制', type: 'number' as const,
                      value: ocrParams.det_limit_side_len,
                      min: 320, max: 2880, step: 40,
                      onChange: (v: string) => setOcrParams(p => ({ ...p, det_limit_side_len: +v })),
                    },
                    {
                      label: '置信度', type: 'number' as const,
                      value: ocrParams.confidence_threshold,
                      min: 0, max: 1, step: 0.05,
                      onChange: (v: string) => setOcrParams(p => ({ ...p, confidence_threshold: +v })),
                    },
                  ].map(f => (
                    <div key={f.label}>
                      <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 4 }}>{f.label}</label>
                      {f.type === 'select' ? (
                        <select value={f.value as string} onChange={e => f.onChange(e.target.value)}
                          style={{ width: '100%', fontSize: 12, borderRadius: 4, outline: 'none', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-1)', padding: '5px 6px' }}
                          onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                          onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}>
                          {f.options!.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      ) : (
                        <input type="number" value={f.value as number}
                          min={f.min} max={f.max} step={f.step}
                          onChange={e => f.onChange(e.target.value)}
                          style={{ width: '100%', fontSize: 12, borderRadius: 4, outline: 'none', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-1)', padding: '5px 6px' }}
                          onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                          onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')} />
                      )}
                    </div>
                  ))}
                </div>

                {/* Merge params */}
                <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 10 }}>
                  <p style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 8, fontWeight: 500 }}>气泡合并</p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                    {[
                      { label: '扩展比例', value: mergeParams.mergeExpandRatio, min: 1.0, max: 2.0, step: 0.05, onChange: (v: string) => setMergeParams(p => ({ ...p, mergeExpandRatio: +v })) },
                      { label: '最大距离', value: mergeParams.mergeMaxDistance, min: 0, max: 100, step: 1, onChange: (v: string) => setMergeParams(p => ({ ...p, mergeMaxDistance: +v })) },
                      { label: '最小组大小', value: mergeParams.mergeMinGroupSize, min: 2, max: 10, step: 1, onChange: (v: string) => setMergeParams(p => ({ ...p, mergeMinGroupSize: +v })) },
                    ].map(f => (
                      <div key={f.label}>
                        <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 4 }}>{f.label}</label>
                        <input type="number" value={f.value} min={f.min} max={f.max} step={f.step}
                          onChange={e => f.onChange(e.target.value)}
                          style={{ width: '100%', fontSize: 12, borderRadius: 4, outline: 'none', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-1)', padding: '5px 6px' }}
                          onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                          onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Desktop results list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
            <ResultsList
              ocrResults={ocrResults} hasImage={!!imageUrl}
              selectedIdx={selectedIdx} selectedForDelete={selectedForDelete}
              handleBoxClick={handleBoxClick}
            />
          </div>
        </div>
      </div>

      {/* ── Toast notifications ── */}
      <div className="fixed bottom-6 left-1/2 z-50 flex flex-col gap-2 pointer-events-none"
        style={{ transform: 'translateX(-50%)' }}>
        {toasts.map(toast => (
          <div key={toast.id}
            className="toast flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm pointer-events-auto whitespace-nowrap"
            style={{
              background: 'var(--surface)',
              border: `1px solid ${toast.type === 'error' ? 'rgba(207,34,46,0.3)' : toast.type === 'success' ? 'rgba(26,127,55,0.3)' : 'var(--border)'}`,
              color: toast.type === 'error' ? 'var(--red)' : toast.type === 'success' ? 'var(--green)' : 'var(--text-1)',
              boxShadow: 'var(--shadow)',
            }}>
            {toast.type === 'success' ? <Check size={13} /> : toast.type === 'error' ? <AlertCircle size={13} /> : <Info size={13} />}
            {toast.msg}
            <button style={{ marginLeft: 4, opacity: 0.5, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex' }}
              onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}
              onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}>
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ImagePanelWrapper
// ─────────────────────────────────────────────────────────────────────────────

type ImagePanelProps = {
  containerRef: React.RefObject<HTMLDivElement | null>
  imgRef: React.RefObject<HTMLImageElement | null>
  imageUrl: string
  inpaintedUrl: string
  ocrResults: OcrResult[]
  showBoxes: boolean
  textReplaceMode: boolean
  selectedIdx: number | null
  selectedForDelete: Set<number>
  boxTextColors: Record<number, string>
  getBoxStyle: (bbox: [number, number, number, number]) => React.CSSProperties
  handleBoxClick: (idx: number) => void
  setTextFitRef: (idx: number) => RefCallback<HTMLElement>
  onUploadClick: () => void
}

function ImagePanelWrapper(props: ImagePanelProps) {
  return (
    <div className="flex-1 min-h-0">
      <ImagePanel {...props} />
    </div>
  )
}

function ImagePanel({
  containerRef, imgRef, imageUrl, inpaintedUrl, ocrResults,
  showBoxes, textReplaceMode, selectedIdx, selectedForDelete,
  boxTextColors, getBoxStyle, handleBoxClick, setTextFitRef, onUploadClick,
}: ImagePanelProps) {
  return (
    <div
      ref={containerRef}
      className="w-full h-full relative flex items-center justify-center"
      style={{ background: 'var(--elevated)' }}
    >
      {imageUrl ? (
        <>
          <img
            ref={imgRef}
            src={textReplaceMode ? (inpaintedUrl || imageUrl) : imageUrl}
            alt="manga page"
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block', boxShadow: 'var(--shadow)' }}
          />

          {(showBoxes || textReplaceMode) && ocrResults.length > 0 && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              {ocrResults.map((result, i) => {
                const isSelected = selectedIdx === i
                const isDelSel = selectedForDelete.has(i)
                const inReplace = textReplaceMode && result.translation
                const borderColor = isDelSel ? 'var(--red)'
                  : isSelected ? 'var(--accent)'
                  : inReplace ? 'transparent'
                  : !showBoxes ? 'transparent'
                  : 'rgba(47,129,247,0.5)'
                const bg = isDelSel ? 'var(--red-bg)'
                  : isSelected ? 'var(--accent-bg)'
                  : inReplace ? (inpaintedUrl ? 'transparent' : 'rgba(0,0,0,0.85)')
                  : !showBoxes ? 'transparent'
                  : 'rgba(47,129,247,0.04)'
                const shadow = isSelected && !inReplace ? '0 0 0 2px var(--accent-border)' : 'none'

                return (
                  <div key={result.id}
                    className="ocr-box"
                    style={{
                      ...getBoxStyle(result.bbox),
                      border: `1.5px solid ${borderColor}`,
                      background: bg,
                      cursor: 'pointer',
                      pointerEvents: 'all',
                      overflow: 'hidden',
                      boxShadow: shadow,
                      borderRadius: '2px',
                    }}
                    onClick={() => handleBoxClick(i)}>
                    {textReplaceMode && result.translation && (
                      <div
                        ref={setTextFitRef(result.id)}
                        style={{
                          width: '100%', height: '100%',
                          color: boxTextColors[result.id] ?? (inpaintedUrl ? '#111' : '#fff'),
                          opacity: 0, padding: '2px',
                        }}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      ) : (
        <button
          onClick={onUploadClick}
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: 32, borderRadius: 12, border: '2px dashed var(--border)', background: 'var(--surface)', cursor: 'pointer', transition: 'all 0.2s' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-bg)' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--surface)' }}>
          <div style={{ width: 48, height: 48, borderRadius: 10, background: 'var(--elevated)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>
            🌸
          </div>
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-1)', marginBottom: 4 }}>上传漫画图片</p>
            <p style={{ fontSize: 12, color: 'var(--text-2)' }}>支持单张或整个文件夹</p>
          </div>
        </button>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ResultsList
// ─────────────────────────────────────────────────────────────────────────────

function ResultsList({ ocrResults, hasImage, selectedIdx, selectedForDelete, handleBoxClick }: {
  ocrResults: OcrResult[]
  hasImage: boolean
  selectedIdx: number | null
  selectedForDelete: Set<number>
  handleBoxClick: (idx: number) => void
}) {
  if (ocrResults.length === 0) return <EmptyState hasImage={hasImage} />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-2)' }}>
          识别结果
          <span style={{ marginLeft: 8, padding: '1px 6px', borderRadius: 10, fontSize: 11, background: 'var(--elevated)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
            {ocrResults.length}
          </span>
        </span>
        {ocrResults.some(r => r.translation) && (
          <span style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, color: 'var(--green)' }}>
            <Check size={11} />已翻译
          </span>
        )}
      </div>
      {ocrResults.map((result, i) => {
        const isSelected = selectedIdx === i
        const isDelSel = selectedForDelete.has(i)
        return (
          <div key={result.id} onClick={() => handleBoxClick(i)}
            className="ocr-box selectable"
            style={{
              borderRadius: 8,
              padding: '10px 12px',
              cursor: 'pointer',
              background: isDelSel ? 'var(--red-bg)' : isSelected ? 'var(--accent-bg)' : 'var(--surface)',
              border: `1px solid ${isDelSel ? 'rgba(207,34,46,0.25)' : isSelected ? 'var(--accent-border)' : 'var(--border)'}`,
              boxShadow: isSelected ? '0 0 0 1px var(--accent-border)' : 'var(--shadow-sm)',
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', background: 'var(--elevated)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px', flexShrink: 0 }}>
                {i + 1}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' }}>
                {(result.confidence * 100).toFixed(0)}%
              </span>
              {result.is_merged && (
                <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--accent-bg)', color: 'var(--accent)', border: '1px solid var(--accent-border)' }}>
                  合并 ×{result.original_count}
                </span>
              )}
              {result.translation && (
                <Check size={10} style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--green)', opacity: 0.8 }} />
              )}
            </div>
            <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-2)', wordBreak: 'break-all' }}>
              {result.text}
            </p>
            {result.translation && (
              <p style={{ fontSize: 12, lineHeight: 1.5, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', color: 'var(--accent)', wordBreak: 'break-all' }}>
                {result.translation}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// EmptyState
// ─────────────────────────────────────────────────────────────────────────────

function EmptyState({ hasImage }: { hasImage: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, padding: '32px 0' }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--elevated)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
        <ScanText size={18} style={{ color: 'var(--text-3)' }} />
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-2)' }}>
        {hasImage ? '点击「识别」或「一键翻译」开始' : '请先上传图片'}
      </p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function HeaderBtn({ icon, label, onClick }: {
  icon: React.ReactNode; label: string; onClick: () => void
}) {
  return (
    <button onClick={onClick}
      style={{
        height: 34, padding: '0 12px', borderRadius: 6,
        border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)',
        fontSize: 13, fontFamily: 'inherit', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 6,
        boxShadow: 'var(--shadow-sm)', fontWeight: 500, whiteSpace: 'nowrap',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--elevated)'; e.currentTarget.style.color = 'var(--text-1)'; e.currentTarget.style.borderColor = 'var(--border2)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.color = 'var(--text-2)'; e.currentTarget.style.borderColor = 'var(--border)' }}>
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}

type ActionVariant = 'default' | 'primary' | 'active' | 'danger'

function ActionBtn({ icon, label, onClick, disabled, variant = 'default', fullWidth, grow }: {
  icon: React.ReactNode; label: string; onClick: () => void
  disabled?: boolean; variant?: ActionVariant; fullWidth?: boolean; grow?: boolean
}) {
  const isPrimary = variant === 'primary'
  const isActive = variant === 'active'
  const isDanger = variant === 'danger'

  const bg = isPrimary ? 'var(--accent)' : isActive ? 'var(--accent-light)' : isDanger ? 'var(--red-bg)' : 'var(--surface)'
  const border = isPrimary ? 'rgba(0,0,0,0.1)' : isActive ? 'var(--accent-border)' : isDanger ? 'rgba(207,34,46,0.25)' : 'var(--border)'
  const color = isPrimary ? '#fff' : isActive ? 'var(--accent)' : isDanger ? 'var(--red)' : 'var(--text-2)'

  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        background: bg, border: `1px solid ${border}`, color,
        height: isPrimary ? 42 : 34, padding: '0 12px',
        borderRadius: 6, fontSize: isPrimary ? 14 : 12, fontWeight: isPrimary ? 600 : 500,
        fontFamily: 'inherit', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        boxShadow: 'var(--shadow-sm)', whiteSpace: 'nowrap',
        width: fullWidth ? '100%' : undefined,
        flex: grow ? 1 : undefined,
        opacity: disabled ? 0.4 : 1,
      }}
      onMouseEnter={e => { if (!disabled && !isPrimary && !isActive && !isDanger) { e.currentTarget.style.background = 'var(--elevated)'; e.currentTarget.style.color = 'var(--text-1)'; e.currentTarget.style.borderColor = 'var(--border2)' } else if (!disabled && isPrimary) { e.currentTarget.style.opacity = '0.88' } }}
      onMouseLeave={e => { e.currentTarget.style.background = bg; e.currentTarget.style.color = color; e.currentTarget.style.borderColor = border; e.currentTarget.style.opacity = disabled ? '0.4' : '1' }}>
      {icon}{label}
    </button>
  )
}

function MobileActionBtn({ icon, label, onClick, disabled, variant = 'default', fullWidth }: {
  icon: React.ReactNode; label: string; onClick: () => void
  disabled?: boolean; variant?: ActionVariant; fullWidth?: boolean
}) {
  const isPrimary = variant === 'primary'
  const isActive = variant === 'active'
  const isDanger = variant === 'danger'

  const bg = isPrimary ? 'var(--accent)' : isActive ? 'var(--accent-light)' : isDanger ? 'var(--red-bg)' : 'var(--surface)'
  const border = isPrimary ? 'rgba(0,0,0,0.1)' : isActive ? 'var(--accent-border)' : isDanger ? 'rgba(207,34,46,0.25)' : 'var(--border)'
  const color = isPrimary ? '#fff' : isActive ? 'var(--accent)' : isDanger ? 'var(--red)' : 'var(--text-2)'

  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        background: bg, border: `1px solid ${border}`, color,
        height: isPrimary ? 46 : 44,
        padding: isPrimary ? '0 16px' : '0 10px',
        borderRadius: 6, fontSize: isPrimary ? 14 : 12, fontWeight: isPrimary ? 600 : 500,
        fontFamily: 'inherit', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        width: fullWidth ? '100%' : undefined,
        flex: fullWidth ? undefined : 1,
        opacity: disabled ? 0.4 : 1,
        whiteSpace: 'nowrap',
      }}>
      {icon}
      <span>{label}</span>
    </button>
  )
}

function LangSelect({ value, onChange, options }: {
  value: string; onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{
        height: 34, padding: '0 8px', borderRadius: 6, outline: 'none',
        background: 'var(--surface)', border: '1px solid var(--border)',
        color: 'var(--text-1)', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer',
        boxShadow: 'var(--shadow-sm)',
      }}
      onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
      onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}
