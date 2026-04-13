import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type RefCallback,
} from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import {
  Upload,
  FolderOpen,
  ScanText,
  Languages,
  Type,
  Trash2,
  Settings,
  ChevronLeft,
  ChevronRight,
  X,
  Eraser,
  Zap,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OcrResult {
  id: number
  text: string
  confidence: number
  bbox: [number, number, number, number]
  polygon: [number, number][] | null   // 精确多边形，用于 inpaint
  is_merged: boolean
  original_count: number
  original_texts: string[]
  translation: string | null
}

interface OcrParams {
  det_limit_type: 'max' | 'min'
  det_limit_side_len: number
  confidence_threshold: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

// ---------------------------------------------------------------------------
// Text fit algorithm (ported from AutoTranslate.vue)
// ---------------------------------------------------------------------------

function fitTextToContainer(el: HTMLElement, text: string) {
  const container = el.parentElement
  if (!container) return

  container.offsetHeight // force reflow
  const style = window.getComputedStyle(container)
  const cw =
    container.clientWidth -
    parseFloat(style.paddingLeft) -
    parseFloat(style.paddingRight)
  const ch =
    container.clientHeight -
    parseFloat(style.paddingTop) -
    parseFloat(style.paddingBottom)

  if (cw <= 0 || ch <= 0) return

  el.textContent = text
  el.style.overflow = 'hidden'
  el.style.width = '100%'
  el.style.height = '100%'
  el.style.display = 'flex'
  el.style.alignItems = 'center'
  el.style.justifyContent = 'center'
  el.style.textAlign = 'center'
  el.style.writingMode = 'horizontal-tb'
  el.style.whiteSpace = 'pre-wrap'
  el.style.wordBreak = 'break-word'

  let lo = 6,
    hi = 100,
    best = lo
  let attempts = 0
  while (lo <= hi && attempts < 20) {
    attempts++
    const mid = Math.floor((lo + hi) / 2)
    el.style.fontSize = mid + 'px'
    el.style.lineHeight = '1.2'
    el.offsetHeight
    if (el.scrollWidth <= cw && el.scrollHeight <= ch) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  el.style.fontSize = best + 'px'

  // optimise line-height
  for (const lh of [1.0, 1.1, 1.2, 1.3, 1.4]) {
    el.style.lineHeight = String(lh)
    el.offsetHeight
    if (el.scrollWidth <= cw && el.scrollHeight <= ch) {
      // keep going
    } else {
      el.style.lineHeight = String(Math.max(1.0, lh - 0.1))
      break
    }
  }

  el.style.opacity = '1'
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function Workbench() {
  const navigate = useNavigate()

  // image management
  const [images, setImages] = useState<File[]>([])
  const [currentIdx, setCurrentIdx] = useState(0)
  const [imageUrl, setImageUrl] = useState<string>('')

  // OCR
  const [ocrResults, setOcrResults] = useState<OcrResult[]>([])
  const [ocrProcessing, setOcrProcessing] = useState(false)
  const [showBoxes, setShowBoxes] = useState(true)
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [deleteMode, setDeleteMode] = useState(false)
  const [selectedForDelete, setSelectedForDelete] = useState<Set<number>>(new Set())
  const [sourceLanguage, setSourceLanguage] = useState('japan')
  const [targetLanguage, setTargetLanguage] = useState('zh')
  const [ocrParams, setOcrParams] = useState<OcrParams>({
    det_limit_type: 'max',
    det_limit_side_len: 960,
    confidence_threshold: 0.7,
  })
  const [showAdvanced, setShowAdvanced] = useState(false)

  // translation
  const [translating, setTranslating] = useState(false)

  // inpaint
  const [inpainting, setInpainting] = useState(false)
  const [inpaintedUrl, setInpaintedUrl] = useState<string>('')   // base64 消除后图片

  // full pipeline
  const [pipelineRunning, setPipelineRunning] = useState(false)

  // text replace
  const [textReplaceMode, setTextReplaceMode] = useState(false)
  const textFitRefs = useRef<Record<number, HTMLElement | null>>({})
  const textFitApplied = useRef<Set<number>>(new Set())

  // status
  const [status, setStatus] = useState<{ msg: string; type: 'info' | 'success' | 'error' } | null>(null)
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // image refs
  const imgRef = useRef<HTMLImageElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // file inputs
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  // ---------------------------------------------------------------------------
  // Status helper
  // ---------------------------------------------------------------------------

  const showStatus = useCallback((msg: string, type: 'info' | 'success' | 'error' = 'info') => {
    setStatus({ msg, type })
    if (statusTimer.current) clearTimeout(statusTimer.current)
    if (type !== 'error') {
      statusTimer.current = setTimeout(() => setStatus(null), 3000)
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Image loading
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (images.length === 0) {
      setImageUrl('')
      return
    }
    const url = URL.createObjectURL(images[currentIdx])
    setImageUrl(url)
    setOcrResults([])
    setTextReplaceMode(false)
    setInpaintedUrl('')
    textFitRefs.current = {}
    textFitApplied.current = new Set()
    return () => URL.revokeObjectURL(url)
  }, [images, currentIdx])

  // ---------------------------------------------------------------------------
  // File upload handlers
  // ---------------------------------------------------------------------------

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(isImageFile)
    if (files.length === 0) return
    setImages(files)
    setCurrentIdx(0)
    showStatus(`已加载 ${files.length} 张图片`, 'success')
    e.target.value = ''
  }

  const handleFolderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
      .filter(isImageFile)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    if (files.length === 0) {
      showStatus('文件夹中没有找到图片', 'error')
      return
    }
    setImages(files)
    setCurrentIdx(0)
    showStatus(`已加载文件夹，共 ${files.length} 张图片`, 'success')
    e.target.value = ''
  }

  // ---------------------------------------------------------------------------
  // OCR
  // ---------------------------------------------------------------------------

  const performOCR = async () => {
    if (!images[currentIdx]) {
      showStatus('请先上传图片', 'error')
      return
    }
    setOcrProcessing(true)
    showStatus('正在进行 OCR 识别...', 'info')
    try {
      const base64 = await fileToBase64(images[currentIdx])
      const { data } = await axios.post('/api/ocr/recognize', {
        image_url: base64,
        language: sourceLanguage,
        ...ocrParams,
      })
      if (data.success) {
        setOcrResults(
          data.results.map((r: any, i: number) => ({
            id: i,
            text: r.text,
            confidence: r.confidence,
            bbox: r.bbox,
            polygon: r.polygon || null,
            is_merged: r.is_merged || false,
            original_count: r.original_count || 1,
            original_texts: r.original_texts || [r.text],
            translation: null,
          }))
        )
        showStatus(`识别完成，共 ${data.results.length} 个文本区域`, 'success')
      } else {
        showStatus('OCR 识别失败: ' + data.error, 'error')
      }
    } catch (e: any) {
      showStatus('OCR 出错: ' + (e.response?.data?.detail || e.message), 'error')
    } finally {
      setOcrProcessing(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Translation
  // ---------------------------------------------------------------------------

  const translateAll = async () => {
    if (ocrResults.length === 0) {
      showStatus('没有可翻译的文本', 'error')
      return
    }
    setTranslating(true)
    showStatus(`翻译中，共 ${ocrResults.length} 个文本...`, 'info')
    try {
      const { data } = await axios.post('/api/ocr/translate/batch', {
        texts: ocrResults.map(r => r.text),
        source_language: sourceLanguage,
        target_language: targetLanguage,
      })
      if (data.success) {
        setOcrResults(prev =>
          prev.map((r, i) => ({ ...r, translation: data.translations[i] ?? null }))
        )
        showStatus('翻译完成', 'success')
      }
    } catch (e: any) {
      showStatus('翻译出错: ' + (e.response?.data?.detail || e.message), 'error')
    } finally {
      setTranslating(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Inpaint
  // ---------------------------------------------------------------------------

  const performInpaint = async () => {
    if (!images[currentIdx] || ocrResults.length === 0) {
      showStatus('请先完成 OCR 识别', 'error')
      return
    }
    setInpainting(true)
    showStatus('正在消除文字...', 'info')
    try {
      const base64 = await fileToBase64(images[currentIdx])
      const { data } = await axios.post('/api/ocr/inpaint', {
        image_url: base64,
        bboxes: ocrResults.map(r => r.bbox),
        polygons: ocrResults.map(r => r.polygon),
        padding: 2,
      })
      if (data.success) {
        setInpaintedUrl(data.image)
        showStatus(`文字消除完成，耗时 ${data.processing_time}s`, 'success')
      }
    } catch (e: any) {
      showStatus('文字消除失败: ' + (e.response?.data?.detail || e.message), 'error')
    } finally {
      setInpainting(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Full pipeline
  // ---------------------------------------------------------------------------

  const runFullPipeline = async () => {
    if (!images[currentIdx]) {
      showStatus('请先上传图片', 'error')
      return
    }
    setPipelineRunning(true)
    setTextReplaceMode(false)
    setInpaintedUrl('')
    textFitRefs.current = {}
    textFitApplied.current = new Set()

    try {
      const base64 = await fileToBase64(images[currentIdx])

      // Step 1: OCR
      showStatus('1/4 OCR 识别中...', 'info')
      const ocrRes = await axios.post('/api/ocr/recognize', {
        image_url: base64,
        language: sourceLanguage,
        ...ocrParams,
      })
      if (!ocrRes.data.success) {
        showStatus('OCR 识别失败: ' + ocrRes.data.error, 'error')
        return
      }
      const results: OcrResult[] = ocrRes.data.results.map((r: any, i: number) => ({
        id: i,
        text: r.text,
        confidence: r.confidence,
        bbox: r.bbox,
        polygon: r.polygon || null,
        is_merged: r.is_merged || false,
        original_count: r.original_count || 1,
        original_texts: r.original_texts || [r.text],
        translation: null,
      }))
      setOcrResults(results)

      if (results.length === 0) {
        showStatus('未检测到文字', 'info')
        return
      }

      // Step 2: 翻译
      showStatus(`2/4 翻译 ${results.length} 个文本...`, 'info')
      const transRes = await axios.post('/api/ocr/translate/batch', {
        texts: results.map(r => r.text),
        source_language: sourceLanguage,
        target_language: targetLanguage,
      })
      let translated = results
      if (transRes.data.success) {
        translated = results.map((r, i) => ({
          ...r,
          translation: transRes.data.translations[i] ?? null,
        }))
        setOcrResults(translated)
      }

      // Step 3: 消除文字
      showStatus('3/4 消除原文...', 'info')
      const inpaintRes = await axios.post('/api/ocr/inpaint', {
        image_url: base64,
        bboxes: translated.map(r => r.bbox),
        polygons: translated.map(r => r.polygon),
        padding: 2,
      })
      if (inpaintRes.data.success) {
        setInpaintedUrl(inpaintRes.data.image)
      }

      // Step 4: 开启文字替换
      showStatus('4/4 应用文字替换...', 'info')
      textFitApplied.current = new Set()
      setTextReplaceMode(true)

      showStatus('完成！', 'success')
    } catch (e: any) {
      showStatus('流程出错: ' + (e.response?.data?.detail || e.message), 'error')
    } finally {
      setPipelineRunning(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Delete mode
  // ---------------------------------------------------------------------------

  const toggleDeleteMode = () => {
    if (deleteMode) {
      if (selectedForDelete.size > 0) {
        const indices = Array.from(selectedForDelete).sort((a, b) => b - a)
        setOcrResults(prev => {
          const next = [...prev]
          indices.forEach(i => next.splice(i, 1))
          return next.map((r, i) => ({ ...r, id: i }))
        })
        showStatus(`已删除 ${selectedForDelete.size} 个识别结果`, 'success')
      }
      setDeleteMode(false)
      setSelectedForDelete(new Set())
    } else {
      setDeleteMode(true)
      setSelectedIdx(null)
      setSelectedForDelete(new Set())
      showStatus('进入删除模式，点击选择要删除的文本', 'info')
    }
  }

  const toggleSelectForDelete = (idx: number) => {
    setSelectedForDelete(prev => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
  }

  // ---------------------------------------------------------------------------
  // Text replace mode
  // ---------------------------------------------------------------------------

  const hasTranslations = ocrResults.some(r => r.translation?.trim())

  const toggleTextReplace = () => {
    if (textReplaceMode) {
      setTextReplaceMode(false)
      textFitRefs.current = {}
      textFitApplied.current = new Set()
    } else {
      if (!hasTranslations) {
        showStatus('请先完成翻译', 'error')
        return
      }
      textFitApplied.current = new Set()
      setTextReplaceMode(true)
      showStatus('已进入文字替换模式', 'success')
    }
  }

  // Run text fit whenever a new ref is attached
  const setTextFitRef: (idx: number) => RefCallback<HTMLElement> = (idx) => (el) => {
    textFitRefs.current[idx] = el
    if (el && !textFitApplied.current.has(idx)) {
      const result = ocrResults.find(r => r.id === idx)
      if (result?.translation) {
        // delay to ensure container is rendered
        requestAnimationFrame(() => {
          if (el) {
            fitTextToContainer(el, result.translation!)
            textFitApplied.current.add(idx)
          }
        })
      }
    }
  }

  // Re-apply text fit when entering replace mode
  useEffect(() => {
    if (!textReplaceMode) return
    textFitApplied.current = new Set()
    // Give DOM time to render the overlay elements
    setTimeout(() => {
      ocrResults.forEach(r => {
        if (r.translation) {
          const el = textFitRefs.current[r.id]
          if (el) {
            fitTextToContainer(el, r.translation)
            textFitApplied.current.add(r.id)
          }
        }
      })
    }, 80)
  }, [textReplaceMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // OCR box positioning
  // ---------------------------------------------------------------------------

  const getBoxStyle = (bbox: [number, number, number, number]): React.CSSProperties => {
    const img = imgRef.current
    const cont = containerRef.current
    if (!img || !cont) return { display: 'none' }
    if (!img.naturalWidth || !img.naturalHeight) return { display: 'none' }

    const imgRect = img.getBoundingClientRect()
    const contRect = cont.getBoundingClientRect()

    const relX = imgRect.left - contRect.left
    const relY = imgRect.top - contRect.top
    const scaleX = img.clientWidth / img.naturalWidth
    const scaleY = img.clientHeight / img.naturalHeight

    const [x1, y1, x2, y2] = bbox
    return {
      position: 'absolute',
      left: Math.round(relX + x1 * scaleX) + 'px',
      top: Math.round(relY + y1 * scaleY) + 'px',
      width: Math.round((x2 - x1) * scaleX) + 'px',
      height: Math.round((y2 - y1) * scaleY) + 'px',
    }
  }

  // ---------------------------------------------------------------------------
  // Click handlers
  // ---------------------------------------------------------------------------

  const handleBoxClick = (idx: number) => {
    if (deleteMode) {
      toggleSelectForDelete(idx)
    } else {
      setSelectedIdx(prev => (prev === idx ? null : idx))
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const currentImage = images[currentIdx]

  return (
    <div
      className="flex flex-col"
      style={{ height: '100vh', background: '#0f0f1a', color: '#e8e8f0', overflow: 'hidden' }}
    >
      {/* ── Top Toolbar ── */}
      <div
        className="flex items-center gap-3 px-4 py-2.5 shrink-0"
        style={{ background: '#161627', borderBottom: '1px solid #2e2e4a' }}
      >
        {/* Brand */}
        <span className="font-bold text-base mr-2" style={{ color: '#818cf8' }}>
          MangaTrans
        </span>

        {/* File upload */}
        <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />
        <input
          ref={folderInputRef}
          type="file"
          // @ts-expect-error webkitdirectory is non-standard
          webkitdirectory=""
          className="hidden"
          onChange={handleFolderChange}
        />

        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors"
          style={{ background: '#1c1c30', color: '#9898b8', border: '1px solid #2e2e4a' }}
          onMouseEnter={e => (e.currentTarget.style.color = '#e8e8f0')}
          onMouseLeave={e => (e.currentTarget.style.color = '#9898b8')}
        >
          <Upload size={14} />
          上传图片
        </button>

        <button
          onClick={() => folderInputRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors"
          style={{ background: '#1c1c30', color: '#9898b8', border: '1px solid #2e2e4a' }}
          onMouseEnter={e => (e.currentTarget.style.color = '#e8e8f0')}
          onMouseLeave={e => (e.currentTarget.style.color = '#9898b8')}
        >
          <FolderOpen size={14} />
          上传文件夹
        </button>

        {/* Page navigation */}
        {images.length > 0 && (
          <div className="flex items-center gap-2 ml-2">
            <button
              onClick={() => setCurrentIdx(i => Math.max(0, i - 1))}
              disabled={currentIdx === 0}
              className="p-1 rounded disabled:opacity-30"
              style={{ color: '#9898b8' }}
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm" style={{ color: '#9898b8' }}>
              {currentIdx + 1} / {images.length}
            </span>
            <button
              onClick={() => setCurrentIdx(i => Math.min(images.length - 1, i + 1))}
              disabled={currentIdx === images.length - 1}
              className="p-1 rounded disabled:opacity-30"
              style={{ color: '#9898b8' }}
            >
              <ChevronRight size={16} />
            </button>
            {currentImage && (
              <span className="text-xs ml-1 truncate max-w-40" style={{ color: '#5a5a7a' }}>
                {currentImage.name}
              </span>
            )}
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Settings */}
        <button
          onClick={() => navigate('/settings')}
          className="p-2 rounded-lg transition-colors"
          style={{ color: '#9898b8' }}
          title="LLM 配置"
          onMouseEnter={e => (e.currentTarget.style.color = '#e8e8f0')}
          onMouseLeave={e => (e.currentTarget.style.color = '#9898b8')}
        >
          <Settings size={16} />
        </button>
      </div>

      {/* ── Main Content ── */}
      <div className="flex flex-1 min-h-0">
        {/* Left: image preview */}
        <div
          className="relative flex items-center justify-center"
          style={{ width: '50%', background: '#0a0a14', borderRight: '1px solid #2e2e4a' }}
          ref={containerRef}
        >
          {imageUrl ? (
            <>
              <img
                ref={imgRef}
                src={inpaintedUrl || imageUrl}
                alt="manga page"
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
              />

              {/* OCR overlay */}
              {(showBoxes || textReplaceMode) && ocrResults.length > 0 && (
                <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                  {ocrResults.map((result, i) => {
                    const boxStyle = getBoxStyle(result.bbox)
                    const isSelected = selectedIdx === i
                    const isDelSel = selectedForDelete.has(i)
                    // 文字替换模式下：有消除底图则透明（底图已干净），无则黑色遮原文
                    const inReplaceWithTranslation = textReplaceMode && result.translation
                    const borderColor = isDelSel
                      ? '#ef4444'
                      : isSelected
                      ? '#818cf8'
                      : inReplaceWithTranslation
                      ? 'transparent'
                      : !showBoxes
                      ? 'transparent'
                      : 'rgba(99, 102, 241, 0.6)'
                    const bg = isDelSel
                      ? 'rgba(239, 68, 68, 0.15)'
                      : isSelected
                      ? 'rgba(129, 140, 248, 0.1)'
                      : inReplaceWithTranslation
                      ? (inpaintedUrl ? 'transparent' : 'rgba(0,0,0,0.82)')
                      : !showBoxes
                      ? 'transparent'
                      : 'rgba(99, 102, 241, 0.05)'

                    return (
                      <div
                        key={result.id}
                        style={{
                          ...boxStyle,
                          border: `1.5px solid ${borderColor}`,
                          background: bg,
                          cursor: 'pointer',
                          pointerEvents: 'all',
                          overflow: 'hidden',
                        }}
                        onClick={() => handleBoxClick(i)}
                      >
                        {textReplaceMode && result.translation && (
                          <div
                            ref={setTextFitRef(result.id)}
                            style={{
                              width: '100%',
                              height: '100%',
                              // 有消除底图（白底）用深色文字；无底图（黑色遮罩）用白色文字
                              color: inpaintedUrl ? '#111' : '#fff',
                              opacity: 0,
                              padding: '2px',
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
            <div
              className="flex flex-col items-center gap-3 p-8 rounded-2xl cursor-pointer"
              style={{ border: '2px dashed #2e2e4a', color: '#5a5a7a' }}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={32} />
              <p className="text-sm">点击上传图片，或使用上方按钮</p>
            </div>
          )}
        </div>

        {/* Right: controls + results */}
        <div
          className="flex flex-col"
          style={{ width: '50%', background: '#161627' }}
        >
          {/* Control panel */}
          <div
            className="shrink-0 p-4"
            style={{ borderBottom: '1px solid #2e2e4a' }}
          >
            {/* Action buttons */}
            <div className="flex flex-wrap gap-2 mb-3">
              <ActionBtn
                icon={<Zap size={14} />}
                label={pipelineRunning ? '处理中...' : '一键翻译'}
                onClick={runFullPipeline}
                disabled={!imageUrl || pipelineRunning}
                primary
              />
              <ActionBtn
                icon={<ScanText size={14} />}
                label={ocrProcessing ? '识别中...' : '开始识别'}
                onClick={performOCR}
                disabled={!imageUrl || ocrProcessing}
                primary
              />
              <ActionBtn
                icon={<Languages size={14} />}
                label={translating ? '翻译中...' : '翻译全部'}
                onClick={translateAll}
                disabled={ocrResults.length === 0 || translating}
              />
              <ActionBtn
                icon={<Type size={14} />}
                label={textReplaceMode ? '退出替换' : '文字替换'}
                onClick={toggleTextReplace}
                disabled={!hasTranslations}
                active={textReplaceMode}
              />
              <ActionBtn
                icon={<Eraser size={14} />}
                label={inpainting ? '消除中...' : inpaintedUrl ? '重新消除' : '消除文字'}
                onClick={performInpaint}
                disabled={ocrResults.length === 0 || inpainting}
                active={!!inpaintedUrl}
              />
              <ActionBtn
                icon={<Trash2 size={14} />}
                label={
                  deleteMode
                    ? selectedForDelete.size > 0
                      ? `删除 (${selectedForDelete.size})`
                      : '取消'
                    : '删除'
                }
                onClick={toggleDeleteMode}
                disabled={ocrResults.length === 0}
                active={deleteMode}
                danger={deleteMode && selectedForDelete.size > 0}
              />
            </div>

            {/* Language selectors + show-boxes toggle */}
            <div className="flex items-center gap-3 flex-wrap">
              <LangSelect
                value={sourceLanguage}
                onChange={setSourceLanguage}
                options={[
                  { value: 'japan', label: '日语' },
                  { value: 'en', label: '英语' },
                  { value: 'ch', label: '简体中文' },
                  { value: 'chinese_cht', label: '繁体中文' },
                ]}
              />
              <span style={{ color: '#5a5a7a', fontSize: 12 }}>→</span>
              <LangSelect
                value={targetLanguage}
                onChange={setTargetLanguage}
                options={[
                  { value: 'zh', label: '中文' },
                  { value: 'en', label: '英语' },
                  { value: 'ja', label: '日语' },
                ]}
              />

              <label className="flex items-center gap-1.5 ml-auto cursor-pointer">
                <input
                  type="checkbox"
                  checked={showBoxes}
                  onChange={e => setShowBoxes(e.target.checked)}
                  className="accent-indigo-500"
                />
                <span className="text-xs" style={{ color: '#9898b8' }}>显示框框</span>
              </label>
            </div>

            {/* Advanced params toggle */}
            <button
              className="mt-2 text-xs flex items-center gap-1"
              style={{ color: '#5a5a7a' }}
              onClick={() => setShowAdvanced(v => !v)}
            >
              {showAdvanced ? '▲' : '▼'} 高级参数
            </button>
            {showAdvanced && (
              <div className="mt-2 grid grid-cols-3 gap-2">
                <div>
                  <label className="text-xs block mb-1" style={{ color: '#5a5a7a' }}>检测模式</label>
                  <select
                    value={ocrParams.det_limit_type}
                    onChange={e => setOcrParams(p => ({ ...p, det_limit_type: e.target.value as 'max' | 'min' }))}
                    className="w-full text-xs px-2 py-1 rounded"
                    style={{ background: '#1c1c30', border: '1px solid #2e2e4a', color: '#e8e8f0' }}
                  >
                    <option value="max">max</option>
                    <option value="min">min</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs block mb-1" style={{ color: '#5a5a7a' }}>边长限制</label>
                  <input
                    type="number"
                    value={ocrParams.det_limit_side_len}
                    min={320}
                    max={2880}
                    step={40}
                    onChange={e => setOcrParams(p => ({ ...p, det_limit_side_len: +e.target.value }))}
                    className="w-full text-xs px-2 py-1 rounded"
                    style={{ background: '#1c1c30', border: '1px solid #2e2e4a', color: '#e8e8f0' }}
                  />
                </div>
                <div>
                  <label className="text-xs block mb-1" style={{ color: '#5a5a7a' }}>置信度阈值</label>
                  <input
                    type="number"
                    value={ocrParams.confidence_threshold}
                    min={0}
                    max={1}
                    step={0.05}
                    onChange={e => setOcrParams(p => ({ ...p, confidence_threshold: +e.target.value }))}
                    className="w-full text-xs px-2 py-1 rounded"
                    style={{ background: '#1c1c30', border: '1px solid #2e2e4a', color: '#e8e8f0' }}
                  />
                </div>
              </div>
            )}

            {/* Status bar */}
            {status && (
              <div
                className="mt-3 px-3 py-1.5 rounded-lg text-xs flex items-center justify-between"
                style={{
                  background:
                    status.type === 'success'
                      ? 'rgba(34,197,94,0.1)'
                      : status.type === 'error'
                      ? 'rgba(239,68,68,0.1)'
                      : 'rgba(99,102,241,0.1)',
                  color:
                    status.type === 'success'
                      ? '#22c55e'
                      : status.type === 'error'
                      ? '#ef4444'
                      : '#818cf8',
                  border: `1px solid ${
                    status.type === 'success'
                      ? 'rgba(34,197,94,0.3)'
                      : status.type === 'error'
                      ? 'rgba(239,68,68,0.3)'
                      : 'rgba(99,102,241,0.3)'
                  }`,
                }}
              >
                <span>{status.msg}</span>
                <button onClick={() => setStatus(null)}>
                  <X size={12} />
                </button>
              </div>
            )}
          </div>

          {/* Results list */}
          <div className="flex-1 overflow-y-auto p-3">
            {ocrResults.length === 0 ? (
              <div
                className="flex items-center justify-center h-full text-sm"
                style={{ color: '#5a5a7a' }}
              >
                {imageUrl ? '点击"开始识别"来提取文字' : '请先上传图片'}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="text-xs mb-1" style={{ color: '#5a5a7a' }}>
                  识别结果 ({ocrResults.length})
                </div>
                {ocrResults.map((result, i) => {
                  const isSelected = selectedIdx === i
                  const isDelSel = selectedForDelete.has(i)
                  return (
                    <div
                      key={result.id}
                      onClick={() => handleBoxClick(i)}
                      className="rounded-xl p-3 cursor-pointer transition-all text-sm"
                      style={{
                        background: isDelSel
                          ? 'rgba(239,68,68,0.1)'
                          : isSelected
                          ? 'rgba(99,102,241,0.12)'
                          : '#1c1c30',
                        border: `1px solid ${
                          isDelSel
                            ? 'rgba(239,68,68,0.4)'
                            : isSelected
                            ? 'rgba(99,102,241,0.5)'
                            : '#2e2e4a'
                        }`,
                      }}
                    >
                      {/* Header row */}
                      <div className="flex items-center gap-2 mb-1.5">
                        <span
                          className="text-xs px-1.5 py-0.5 rounded"
                          style={{ background: '#2e2e4a', color: '#9898b8' }}
                        >
                          #{i + 1}
                        </span>
                        <span className="text-xs" style={{ color: '#5a5a7a' }}>
                          {(result.confidence * 100).toFixed(0)}%
                        </span>
                        {result.is_merged && (
                          <span
                            className="text-xs px-1.5 py-0.5 rounded"
                            style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8' }}
                          >
                            合并×{result.original_count}
                          </span>
                        )}
                      </div>

                      {/* Original text */}
                      <p
                        className="text-xs leading-relaxed"
                        style={{ color: '#9898b8', wordBreak: 'break-all' }}
                      >
                        {result.text}
                      </p>

                      {/* Translation */}
                      {result.translation && (
                        <p
                          className="text-xs leading-relaxed mt-1.5 pt-1.5"
                          style={{
                            color: '#e8e8f0',
                            wordBreak: 'break-all',
                            borderTop: '1px solid #2e2e4a',
                          }}
                        >
                          {result.translation}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ActionBtn({
  icon,
  label,
  onClick,
  disabled,
  primary,
  active,
  danger,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  primary?: boolean
  active?: boolean
  danger?: boolean
}) {
  const bg = danger
    ? 'rgba(239,68,68,0.15)'
    : active
    ? 'rgba(99,102,241,0.2)'
    : primary
    ? '#6366f1'
    : '#1c1c30'
  const border = danger
    ? 'rgba(239,68,68,0.4)'
    : active
    ? 'rgba(99,102,241,0.5)'
    : '#2e2e4a'
  const color = danger ? '#ef4444' : active ? '#818cf8' : primary ? '#fff' : '#9898b8'

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-40"
      style={{ background: bg, border: `1px solid ${border}`, color }}
    >
      {icon}
      {label}
    </button>
  )
}

function LangSelect({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="text-xs px-2 py-1.5 rounded-lg outline-none"
      style={{ background: '#1c1c30', border: '1px solid #2e2e4a', color: '#9898b8' }}
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
