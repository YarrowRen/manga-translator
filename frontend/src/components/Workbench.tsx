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
  Upload, FolderOpen, ScanText, Languages, Type,
  Trash2, Settings, ChevronLeft, ChevronRight, X,
  Zap, ChevronDown, Check, AlertCircle, Info,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Constants & types
// ─────────────────────────────────────────────────────────────────────────────

interface OcrParams {
  det_limit_type: 'max' | 'min'
  det_limit_side_len: number
  confidence_threshold: number
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
    addImages, setCurrentIdx, setOcrResults, setInpaintedUrl, resetPageData,
  } = useWorkbench()

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
    const hasData = ocrResults.some(r => r.translation) && !!inpaintedUrl
    setTextReplaceMode(hasData)
  }, [currentIdx]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── ResizeObserver: re-render boxes + re-fit text on container resize ───────

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const ro = new ResizeObserver(() => {
      // Immediately re-render to reposition OCR boxes
      setRenderTick(n => n + 1)

      // Debounce text re-fitting (expensive, wait for resize to settle)
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
      const rawResults = await recognizeText(base64, { language: sourceLanguage, ...ocrParams })
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
      const rawResults = await recognizeText(base64, { language: sourceLanguage, ...ocrParams })
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
      if (!results.length) { showToast('未检测到文字', 'info'); return }

      // Step 2: Translate
      setPipelineStep(1)
      const translations = await translateBatch(
        results.map(r => r.text),
        sourceLanguage,
        targetLanguage,
      )
      const translated = results.map((r, i) => ({
        ...r, translation: translations[i] ?? null,
      }))
      setOcrResults(currentId, translated)

      // Step 3: Inpaint
      setPipelineStep(2)
      const inpaintedDataUrl = await inpaintRegions(
        base64,
        translated.map(r => r.bbox),
        translated.map(r => r.polygon),
      )
      setInpaintedUrl(currentId, inpaintedDataUrl)

      // Step 4: Replace
      setPipelineStep(3)
      textFitApplied.current = new Set()
      setTextReplaceMode(true)
      showToast('一键翻译完成！', 'success')
    } catch (e: any) {
      showToast('流程出错: ' + (e.response?.data?.detail || e.message), 'error')
    } finally {
      setPipelineRunning(false)
      setPipelineStep(-1)
    }
  }

  // ── Delete mode ───────────────────────────────────────────────────────────

  const toggleDeleteMode = () => {
    if (deleteMode) {
      if (currentId && selectedForDelete.size > 0) {
        const indices = Array.from(selectedForDelete).sort((a, b) => b - a)
        setOcrResults(currentId, prev => {
          const next = [...prev]
          indices.forEach(i => next.splice(i, 1))
          return next.map((r, i) => ({ ...r, id: i }))
        })
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
    // Auto-inpaint if not already done
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
  // Samples each OCR box region from the inpainted/original image using a
  // canvas, computes luminance, chooses dark (#111) or light (#fff) text.
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
    <div className="flex flex-col" style={{ height: '100dvh', background: '#09090f', color: '#eeeef8', overflow: 'hidden' }}>

      {/* ── Hidden file inputs ── */}
      <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />
      <input ref={folderInputRef} type="file"
        // @ts-expect-error non-standard
        webkitdirectory="" className="hidden" onChange={handleFolderChange} />

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header style={{ background: '#0d0d1c', borderBottom: '1px solid #1a1a30' }}
        className="flex items-center gap-2 px-4 md:px-6 py-2.5 md:py-3 shrink-0">

        {/* Brand */}
        <div className="flex items-center gap-2 mr-1">
          <span className="text-lg leading-none">🌸</span>
          <span className="font-semibold text-sm md:text-base hidden sm:inline"
            style={{ color: '#c7c7f0', letterSpacing: '-0.01em' }}>
            MangaTrans
          </span>
        </div>

        {/* Upload buttons */}
        <HeaderBtn icon={<Upload size={13} />} label="上传图片" shortLabel onClick={() => fileInputRef.current?.click()} />
        <HeaderBtn icon={<FolderOpen size={13} />} label="上传文件夹" shortLabel onClick={() => folderInputRef.current?.click()} />

        {/* Page navigation */}
        {images.length > 0 && (
          <div className="flex items-center gap-1 ml-1">
            <button
              onClick={() => setCurrentIdx(Math.max(0, currentIdx - 1))}
              disabled={currentIdx === 0}
              className="w-7 h-7 rounded-lg flex items-center justify-center disabled:opacity-25"
              style={{ color: '#7070a0', background: '#13132a' }}>
              <ChevronLeft size={14} />
            </button>
            <span className="text-xs px-2 tabular-nums" style={{ color: '#6060a0' }}>
              {currentIdx + 1}<span style={{ color: '#3a3a60' }}>/</span>{images.length}
            </span>
            <button
              onClick={() => setCurrentIdx(Math.min(images.length - 1, currentIdx + 1))}
              disabled={currentIdx === images.length - 1}
              className="w-7 h-7 rounded-lg flex items-center justify-center disabled:opacity-25"
              style={{ color: '#7070a0', background: '#13132a' }}>
              <ChevronRight size={14} />
            </button>
            {currentImage && (
              <span className="hidden lg:inline text-xs ml-1 truncate max-w-[160px]"
                style={{ color: '#404060' }}>
                {currentImage.name}
              </span>
            )}
            {!hashedAll && images.length > 0 && (
              <span className="text-xs ml-1 pulse" style={{ color: '#404060' }}>●</span>
            )}
          </div>
        )}

        <div className="flex-1" />

        <button onClick={() => navigate('/settings')}
          className="w-8 h-8 rounded-xl flex items-center justify-center"
          style={{ color: '#5050a0', background: '#13132a' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#9898c8'; e.currentTarget.style.background = '#1e1e38' }}
          onMouseLeave={e => { e.currentTarget.style.color = '#5050a0'; e.currentTarget.style.background = '#13132a' }}>
          <Settings size={15} />
        </button>
      </header>

      {/* ── Pipeline progress bar ── */}
      {pipelineRunning && pipelineStep >= 0 && (
        <div style={{ background: '#0d0d1c', borderBottom: '1px solid #1a1a30' }}
          className="shrink-0 px-4 md:px-6 py-2 fade-in">
          <div className="flex items-center gap-3">
            {PIPELINE_LABELS.map((label, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium ${i === pipelineStep ? 'pulse' : ''}`}
                  style={{
                    background: i < pipelineStep ? 'rgba(34,197,94,0.2)' : i === pipelineStep ? 'rgba(99,102,241,0.3)' : 'rgba(255,255,255,0.05)',
                    color: i < pipelineStep ? '#22c55e' : i === pipelineStep ? '#818cf8' : '#3a3a60',
                    border: `1px solid ${i < pipelineStep ? 'rgba(34,197,94,0.4)' : i === pipelineStep ? 'rgba(99,102,241,0.5)' : '#1e1e35'}`,
                  }}>
                  {i < pipelineStep ? <Check size={10} /> : i + 1}
                </div>
                <span className="text-xs hidden sm:inline"
                  style={{ color: i < pipelineStep ? '#22c55e' : i === pipelineStep ? '#818cf8' : '#2a2a50' }}>
                  {label}
                </span>
                {i < 3 && <div className="w-4 h-px hidden sm:block" style={{ background: i < pipelineStep ? '#22c55e33' : '#1e1e35' }} />}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Main content ──────────────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row flex-1 min-h-0">

        {/* ── Image area (mobile: flex-1 fills screen; desktop: left column) ── */}
        <div className="flex flex-col flex-1 min-h-0">

          {/* Image fills all remaining space */}
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

          {/* ── Mobile-only: compact action bar below image ── */}
          <div className="md:hidden shrink-0 px-4 py-2.5"
            style={{ background: '#0d0d1c', borderTop: '1px solid #1a1a30' }}>
            <div className="flex items-center gap-1.5 overflow-x-auto scroll-x-hidden">
              <ActionBtn
                icon={pipelineRunning ? <span className="spinner" /> : <Zap size={13} />}
                label={pipelineRunning ? '处理中...' : '一键翻译'}
                onClick={runFullPipeline} disabled={!imageUrl || !currentId || busy} variant="primary"
              />
              <ActionBtn
                icon={ocrProcessing ? <span className="spinner" /> : <ScanText size={13} />}
                label={ocrProcessing ? '识别中...' : '识别'}
                onClick={performOCR} disabled={!imageUrl || !currentId || busy} variant="default"
              />
              <ActionBtn
                icon={translating ? <span className="spinner" /> : <Languages size={13} />}
                label={translating ? '翻译中...' : '翻译'}
                onClick={translateAll} disabled={!ocrResults.length || busy} variant="default"
              />
              <ActionBtn
                icon={inpainting ? <span className="spinner" /> : <Type size={13} />}
                label={inpainting ? '消除中...' : textReplaceMode ? '退出替换' : '替换'}
                onClick={toggleTextReplace} disabled={!hasTranslations || busy}
                variant={textReplaceMode ? 'active' : 'default'}
              />
              <ActionBtn
                icon={<Trash2 size={13} />}
                label={deleteMode ? (selectedForDelete.size > 0 ? `删除(${selectedForDelete.size})` : '取消') : '删除'}
                onClick={toggleDeleteMode} disabled={!ocrResults.length}
                variant={deleteMode ? (selectedForDelete.size > 0 ? 'danger' : 'active') : 'default'}
              />
              {/* Results drawer toggle */}
              <button
                onClick={() => setMobileDrawerOpen(v => !v)}
                className="flex items-center gap-1 px-2.5 py-2 rounded-xl text-xs shrink-0 ml-auto"
                style={{
                  background: mobileDrawerOpen ? 'rgba(99,102,241,0.15)' : '#111122',
                  border: `1px solid ${mobileDrawerOpen ? 'rgba(99,102,241,0.4)' : '#1a1a35'}`,
                  color: mobileDrawerOpen ? '#818cf8' : '#5050a0',
                }}>
                {ocrResults.length > 0 && (
                  <span className="w-4 h-4 rounded-md flex items-center justify-center text-xs"
                    style={{ background: '#1a1a35', color: '#6366f1', fontSize: 9 }}>
                    {ocrResults.length}
                  </span>
                )}
                <ChevronDown size={12} style={{
                  transform: mobileDrawerOpen ? 'rotate(180deg)' : 'none',
                  transition: 'transform 0.25s',
                }} />
              </button>
            </div>
          </div>

          {/* ── Mobile-only: collapsible results drawer ── */}
          <div className="md:hidden shrink-0 overflow-hidden"
            style={{
              maxHeight: mobileDrawerOpen ? '48dvh' : 0,
              transition: 'max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
              background: '#0d0d1c',
              borderTop: mobileDrawerOpen ? '1px solid #1a1a30' : 'none',
            }}>
            {/* Lang + controls row */}
            <div className="px-4 pt-3 pb-2.5 flex items-center gap-2 flex-wrap"
              style={{ borderBottom: '1px solid #141428' }}>
              <LangSelect value={sourceLanguage} onChange={setSourceLanguage} options={[
                { value: 'japan', label: '日语' }, { value: 'en', label: '英语' },
                { value: 'ch', label: '中文' }, { value: 'chinese_cht', label: '繁中' },
              ]} />
              <span style={{ color: '#2a2a50', fontSize: 11 }}>→</span>
              <LangSelect value={targetLanguage} onChange={setTargetLanguage} options={[
                { value: 'zh', label: '中文' }, { value: 'en', label: '英语' },
                { value: 'ja', label: '日语' },
              ]} />
              <div className="ml-auto flex items-center gap-2">
                <div onClick={() => setShowBoxes(v => !v)}
                  className="w-8 h-4 rounded-full relative cursor-pointer"
                  style={{ background: showBoxes ? '#4f4fe8' : '#1e1e38' }}>
                  <div className="absolute top-0.5 w-3 h-3 rounded-full transition-all"
                    style={{ background: '#fff', left: showBoxes ? '17px' : '2px' }} />
                </div>
                <span className="text-xs" style={{ color: '#4040a0' }}>框</span>
              </div>
            </div>
            {/* Results */}
            <div className="overflow-y-auto px-4 py-2.5" style={{ maxHeight: 'calc(48dvh - 54px)' }}>
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
          style={{ width: 420, background: '#0d0d1c', borderLeft: '1px solid #1a1a30' }}>

          {/* Action bar */}
          <div className="shrink-0 px-5 pt-5 pb-4" style={{ borderBottom: '1px solid #1a1a30' }}>
            <div className="flex gap-1.5 flex-wrap">
              <ActionBtn
                icon={pipelineRunning ? <span className="spinner" /> : <Zap size={13} />}
                label={pipelineRunning ? `${PIPELINE_LABELS[pipelineStep] ?? '处理中'}...` : '一键翻译'}
                onClick={runFullPipeline} disabled={!imageUrl || !currentId || busy} variant="primary"
              />
              <ActionBtn
                icon={ocrProcessing ? <span className="spinner" /> : <ScanText size={13} />}
                label={ocrProcessing ? '识别中...' : '识别'}
                onClick={performOCR} disabled={!imageUrl || !currentId || busy} variant="default"
              />
              <ActionBtn
                icon={translating ? <span className="spinner" /> : <Languages size={13} />}
                label={translating ? '翻译中...' : '翻译'}
                onClick={translateAll} disabled={!ocrResults.length || busy} variant="default"
              />
              <ActionBtn
                icon={inpainting ? <span className="spinner" /> : <Type size={13} />}
                label={inpainting ? '消除中...' : textReplaceMode ? '退出替换' : '替换'}
                onClick={toggleTextReplace} disabled={!hasTranslations || busy}
                variant={textReplaceMode ? 'active' : 'default'}
              />
              <ActionBtn
                icon={<Trash2 size={13} />}
                label={deleteMode ? (selectedForDelete.size > 0 ? `删除(${selectedForDelete.size})` : '取消') : '删除'}
                onClick={toggleDeleteMode} disabled={!ocrResults.length}
                variant={deleteMode ? (selectedForDelete.size > 0 ? 'danger' : 'active') : 'default'}
              />
            </div>

            {/* Language + toggles */}
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <LangSelect value={sourceLanguage} onChange={setSourceLanguage} options={[
                { value: 'japan', label: '日语' }, { value: 'en', label: '英语' },
                { value: 'ch', label: '中文' }, { value: 'chinese_cht', label: '繁中' },
              ]} />
              <span style={{ color: '#2a2a50', fontSize: 11 }}>→</span>
              <LangSelect value={targetLanguage} onChange={setTargetLanguage} options={[
                { value: 'zh', label: '中文' }, { value: 'en', label: '英语' },
                { value: 'ja', label: '日语' },
              ]} />
              <label className="flex items-center gap-1.5 ml-auto cursor-pointer select-none">
                <div onClick={() => setShowBoxes(v => !v)}
                  className="w-8 h-4 rounded-full relative cursor-pointer"
                  style={{ background: showBoxes ? '#4f4fe8' : '#1e1e38' }}>
                  <div className="absolute top-0.5 w-3 h-3 rounded-full transition-all"
                    style={{ background: '#fff', left: showBoxes ? '17px' : '2px' }} />
                </div>
                <span className="text-xs" style={{ color: '#5050a0' }}>框</span>
              </label>
              <button onClick={() => setShowAdvanced(v => !v)}
                className="flex items-center gap-0.5 text-xs"
                style={{ color: '#3a3a60' }}
                onMouseEnter={e => (e.currentTarget.style.color = '#6060a0')}
                onMouseLeave={e => (e.currentTarget.style.color = '#3a3a60')}>
                高级
                <ChevronDown size={11} style={{ transform: showAdvanced ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
              </button>
            </div>

            {showAdvanced && (
              <div className="mt-2.5 grid grid-cols-3 gap-2 fade-in">
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
                    <label className="block text-xs mb-1" style={{ color: '#3a3a60' }}>{f.label}</label>
                    {f.type === 'select' ? (
                      <select value={f.value as string} onChange={e => f.onChange(e.target.value)}
                        className="w-full text-xs px-2 py-1.5 rounded-lg outline-none"
                        style={{ background: '#13132a', border: '1px solid #1e1e38', color: '#8080c0' }}>
                        {f.options!.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : (
                      <input type="number" value={f.value as number}
                        min={f.min} max={f.max} step={f.step}
                        onChange={e => f.onChange(e.target.value)}
                        className="w-full text-xs px-2 py-1.5 rounded-lg outline-none"
                        style={{ background: '#13132a', border: '1px solid #1e1e38', color: '#8080c0' }} />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Desktop results list */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
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
            className="toast flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-sm pointer-events-auto whitespace-nowrap"
            style={{
              background: toast.type === 'success' ? 'rgba(17,24,20,0.95)' : toast.type === 'error' ? 'rgba(24,14,14,0.95)' : 'rgba(14,14,24,0.95)',
              border: `1px solid ${toast.type === 'success' ? 'rgba(34,197,94,0.3)' : toast.type === 'error' ? 'rgba(239,68,68,0.3)' : 'rgba(99,102,241,0.3)'}`,
              color: toast.type === 'success' ? '#4ade80' : toast.type === 'error' ? '#f87171' : '#a5b4fc',
              backdropFilter: 'blur(12px)',
              boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
            }}>
            {toast.type === 'success' ? <Check size={13} /> : toast.type === 'error' ? <AlertCircle size={13} /> : <Info size={13} />}
            {toast.msg}
            <button className="ml-1 opacity-50 hover:opacity-100 pointer-events-auto"
              onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}>
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ImagePanelWrapper — handles responsive height without inline style conflict
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
    // flex-1 min-h-0: fills remaining space in both mobile (flex-col) and desktop (flex-row)
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
      style={{ background: '#060610' }}
    >
      {imageUrl ? (
        <>
          <img
            ref={imgRef}
            src={inpaintedUrl || imageUrl}
            alt="manga page"
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
          />

          {(showBoxes || textReplaceMode) && ocrResults.length > 0 && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              {ocrResults.map((result, i) => {
                const isSelected = selectedIdx === i
                const isDelSel = selectedForDelete.has(i)
                const inReplace = textReplaceMode && result.translation
                const borderColor = isDelSel ? '#ef4444'
                  : isSelected ? '#818cf8'
                  : inReplace ? 'transparent'
                  : !showBoxes ? 'transparent'
                  : 'rgba(99,102,241,0.55)'
                const bg = isDelSel ? 'rgba(239,68,68,0.12)'
                  : isSelected ? 'rgba(129,140,248,0.08)'
                  : inReplace ? (inpaintedUrl ? 'transparent' : 'rgba(0,0,0,0.85)')
                  : !showBoxes ? 'transparent'
                  : 'rgba(99,102,241,0.04)'
                const shadow = isSelected && !inReplace ? '0 0 0 1px rgba(129,140,248,0.3), 0 0 12px rgba(99,102,241,0.15)' : 'none'

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
          className="flex flex-col items-center gap-3 p-8 rounded-2xl transition-all"
          style={{ border: '1.5px dashed #1a1a35', color: '#303060' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#4040a0'; e.currentTarget.style.color = '#6060c0' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#1a1a35'; e.currentTarget.style.color = '#303060' }}>
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center"
            style={{ background: '#0e0e20', border: '1px solid #1a1a35' }}>
            <Upload size={22} />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium mb-0.5">上传漫画图片</p>
            <p className="text-xs" style={{ color: '#252550' }}>支持单张或整个文件夹</p>
          </div>
        </button>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ResultsList — shared between mobile drawer and desktop panel
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
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium" style={{ color: '#3a3a60' }}>
          识别结果
          <span className="ml-1.5 px-1.5 py-0.5 rounded-md text-xs"
            style={{ background: '#13132a', color: '#5050a0' }}>
            {ocrResults.length}
          </span>
        </span>
        {ocrResults.some(r => r.translation) && (
          <span className="text-xs flex items-center gap-1" style={{ color: '#22c55e' }}>
            <Check size={10} />已翻译
          </span>
        )}
      </div>
      {ocrResults.map((result, i) => {
        const isSelected = selectedIdx === i
        const isDelSel = selectedForDelete.has(i)
        return (
          <div key={result.id} onClick={() => handleBoxClick(i)}
            className="ocr-box rounded-xl p-3.5 cursor-pointer selectable"
            style={{
              background: isDelSel ? 'rgba(239,68,68,0.07)' : isSelected ? 'rgba(99,102,241,0.1)' : '#111122',
              border: `1px solid ${isDelSel ? 'rgba(239,68,68,0.35)' : isSelected ? 'rgba(99,102,241,0.4)' : '#181830'}`,
              boxShadow: isSelected ? '0 0 0 1px rgba(99,102,241,0.2)' : 'none',
            }}>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs w-5 h-5 rounded-md flex items-center justify-center font-medium"
                style={{ background: '#1a1a35', color: '#5050a0', fontSize: 10 }}>
                {i + 1}
              </span>
              <span className="text-xs tabular-nums" style={{ color: '#2a2a50' }}>
                {(result.confidence * 100).toFixed(0)}%
              </span>
              {result.is_merged && (
                <span className="text-xs px-1.5 py-0.5 rounded-md"
                  style={{ background: 'rgba(99,102,241,0.12)', color: '#6366f1', fontSize: 10 }}>
                  合并 ×{result.original_count}
                </span>
              )}
              {result.translation && (
                <Check size={10} className="ml-auto" style={{ color: '#22c55e', opacity: 0.7 }} />
              )}
            </div>
            <p className="text-xs leading-relaxed" style={{ color: '#6060a0', wordBreak: 'break-all' }}>
              {result.text}
            </p>
            {result.translation && (
              <p className="text-xs leading-relaxed mt-2 pt-2"
                style={{ color: '#c0c0e8', wordBreak: 'break-all', borderTop: '1px solid #181830' }}>
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
    <div className="flex flex-col items-center justify-center h-full gap-2 py-8">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-1"
        style={{ background: '#0e0e20', border: '1px solid #1a1a30' }}>
        <ScanText size={18} style={{ color: '#252550' }} />
      </div>
      <p className="text-sm" style={{ color: '#303060' }}>
        {hasImage ? '点击「识别」或「一键翻译」开始' : '请先上传图片'}
      </p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function HeaderBtn({ icon, label, shortLabel, onClick }: {
  icon: React.ReactNode; label: string; shortLabel?: boolean; onClick: () => void
}) {
  return (
    <button onClick={onClick}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs"
      style={{ background: '#13132a', color: '#6060a0', border: '1px solid #1a1a35' }}
      onMouseEnter={e => { e.currentTarget.style.color = '#a0a0d8'; e.currentTarget.style.borderColor = '#2a2a48' }}
      onMouseLeave={e => { e.currentTarget.style.color = '#6060a0'; e.currentTarget.style.borderColor = '#1a1a35' }}>
      {icon}
      {shortLabel ? (
        <>
          <span className="hidden md:inline">{label}</span>
        </>
      ) : label}
    </button>
  )
}

type ActionVariant = 'default' | 'primary' | 'active' | 'danger'

function ActionBtn({ icon, label, onClick, disabled, variant = 'default' }: {
  icon: React.ReactNode; label: string; onClick: () => void
  disabled?: boolean; variant?: ActionVariant
}) {
  const styles: Record<ActionVariant, { bg: string; border: string; color: string; hover?: string }> = {
    default: { bg: '#111122', border: '#1a1a35', color: '#7070a0', hover: '#a0a0d0' },
    primary: { bg: 'linear-gradient(135deg, #5254e8 0%, #7c7ef0 100%)', border: 'rgba(99,102,241,0.4)', color: '#fff' },
    active:  { bg: 'rgba(99,102,241,0.15)', border: 'rgba(99,102,241,0.4)', color: '#818cf8' },
    danger:  { bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.35)', color: '#f87171' },
  }
  const s = styles[variant]

  return (
    <button onClick={onClick} disabled={disabled}
      className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium whitespace-nowrap shrink-0 disabled:opacity-30"
      style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color }}
      onMouseEnter={e => { if (!disabled && s.hover) e.currentTarget.style.color = s.hover }}
      onMouseLeave={e => { e.currentTarget.style.color = s.color }}>
      {icon}{label}
    </button>
  )
}

function LangSelect({ value, onChange, options }: {
  value: string; onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="text-xs px-2 py-1.5 rounded-lg outline-none"
      style={{ background: '#111122', border: '1px solid #1a1a35', color: '#6060a0' }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}
