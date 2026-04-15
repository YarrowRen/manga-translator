import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Save, Wifi, Eye, EyeOff, Check, AlertCircle, ChevronDown } from 'lucide-react'
import { loadLLMConfig, saveLLMConfig, type LLMConfig } from '../services/llmConfig'
import { loadOCRConfig, saveOCRConfig, type OCRConfig } from '../services/ocrConfig'
import { loadEhentaiConfig, saveEhentaiConfig, type EhentaiConfig } from '../services/ehentaiConfig'
import { testLLMConnection } from '../services/translationService'
import { redeemCode } from '../services/redeemService'
import { useTheme, type ThemeMode } from '../hooks/useTheme'

const THEME_ORDER: ThemeMode[] = ['light', 'dark', 'system']
const THEME_ICON: Record<ThemeMode, string> = { light: '☀', dark: '☾', system: '⊙' }
const THEME_LABEL: Record<ThemeMode, string> = { light: '浅色', dark: '深色', system: '跟随系统' }

export default function SettingsPanel() {
  const navigate = useNavigate()
  const { mode: themeMode, setMode: setThemeMode } = useTheme()

  const [isSmall, setIsSmall] = useState(() => window.innerWidth < 640)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const handler = (e: MediaQueryListEvent) => setIsSmall(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const cycleTheme = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(themeMode) + 1) % THEME_ORDER.length]
    setThemeMode(next)
  }

  // LLM 配置
  const [config, setConfig] = useState<LLMConfig>(loadLLMConfig)
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const [testStatus, setTestStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)

  // OCR 配置
  const [ocrConfig, setOcrConfig] = useState<OCRConfig>(loadOCRConfig)
  const [showToken, setShowToken] = useState(false)
  const [ocrSaving, setOcrSaving] = useState(false)
  const [ocrSaveStatus, setOcrSaveStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const [ocrAdvanced, setOcrAdvanced] = useState(false)

  // 兑换码
  const [redeemCodeInput, setRedeemCodeInput] = useState('')
  const [redeeming, setRedeeming] = useState(false)
  const [redeemStatus, setRedeemStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)

  const handleRedeem = async () => {
    if (!redeemCodeInput.trim()) return
    setRedeeming(true); setRedeemStatus(null)
    try {
      const result = await redeemCode(redeemCodeInput.trim())
      if (result.config.llm)      { saveLLMConfig(result.config.llm);      setConfig(result.config.llm) }
      if (result.config.ocr)      { saveOCRConfig(result.config.ocr);      setOcrConfig(result.config.ocr) }
      if (result.config.ehentai)  { saveEhentaiConfig(result.config.ehentai); setEhConfig(result.config.ehentai) }
      setRedeemStatus({ type: 'success', msg: `兑换成功${result.label ? `（${result.label}）` : ''}，配置已自动填入` })
      setRedeemCodeInput('')
    } catch (e: any) {
      setRedeemStatus({ type: 'error', msg: e.message || '兑换失败' })
    } finally {
      setRedeeming(false)
    }
  }

  // ExHentai 配置
  const [ehConfig, setEhConfig] = useState<EhentaiConfig>(loadEhentaiConfig)
  const [showPassHash, setShowPassHash] = useState(false)
  const [ehSaving, setEhSaving] = useState(false)
  const [ehSaveStatus, setEhSaveStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)

  const handleEhSave = () => {
    setEhSaving(true); setEhSaveStatus(null)
    try { saveEhentaiConfig(ehConfig); setEhSaveStatus({ type: 'success', msg: 'ExHentai 配置已保存' }) }
    catch { setEhSaveStatus({ type: 'error', msg: '保存失败' }) }
    finally { setEhSaving(false) }
  }

  const handleOCRSave = () => {
    setOcrSaving(true); setOcrSaveStatus(null)
    try { saveOCRConfig(ocrConfig); setOcrSaveStatus({ type: 'success', msg: 'OCR 配置已保存' }) }
    catch { setOcrSaveStatus({ type: 'error', msg: '保存失败' }) }
    finally { setOcrSaving(false) }
  }

  const handleSave = () => {
    setSaving(true); setSaveStatus(null)
    try { saveLLMConfig(config); setSaveStatus({ type: 'success', msg: '配置已保存' }) }
    catch { setSaveStatus({ type: 'error', msg: '保存失败' }) }
    finally { setSaving(false) }
  }

  const handleTest = async () => {
    setTesting(true); setTestStatus(null)
    saveLLMConfig(config)
    try {
      const { model } = await testLLMConnection()
      setTestStatus({ type: 'success', msg: `连接成功，模型: ${model}` })
    } catch (e: any) {
      setTestStatus({ type: 'error', msg: e.message || '连接失败' })
    } finally {
      setTesting(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', borderRadius: 6,
    border: '1px solid var(--border)', background: 'var(--elevated)',
    color: 'var(--text-1)', fontSize: 13, fontFamily: 'inherit', outline: 'none',
  }

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg)', color: 'var(--text-1)' }}>

      {/* Header */}
      <header style={{
        height: 56, display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 24px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface)', flexShrink: 0, boxShadow: 'var(--shadow-sm)',
      }}>
        <button onClick={() => navigate('/')}
          style={{ width: 34, height: 34, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--shadow-sm)', flexShrink: 0 }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--elevated)'; e.currentTarget.style.color = 'var(--text-1)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.color = 'var(--text-2)' }}>
          <ArrowLeft size={15} />
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 15, color: 'var(--text-1)' }}>
          MangaTrans
        </div>
        <div style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />
        <span style={{ fontSize: 13, color: 'var(--text-2)' }}>设置</span>

        <div style={{ flex: 1 }} />

        {/* Theme toggle */}
        {isSmall ? (
          <button onClick={cycleTheme} title={THEME_LABEL[themeMode]}
            style={{ width: 34, height: 34, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, flexShrink: 0 }}>
            {THEME_ICON[themeMode]}
          </button>
        ) : (
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            {THEME_ORDER.map(m => (
              <button key={m} onClick={() => setThemeMode(m)} title={THEME_LABEL[m]}
                style={{
                  padding: '5px 9px', fontSize: 13, cursor: 'pointer', border: 'none', fontFamily: 'inherit',
                  background: themeMode === m ? 'var(--accent)' : 'var(--surface)',
                  color: themeMode === m ? '#fff' : 'var(--text-2)',
                }}>
                {THEME_ICON[m]}
              </button>
            ))}
          </div>
        )}
      </header>

      {/* Content */}
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '32px 16px' }}>

        {/* LLM Card */}
        <SettingsCard
          title="API 连接配置"
          description="配置 OpenAI 兼容的 LLM 接口，支持 OpenAI、DeepSeek、通义千问等。配置保存在浏览器本地。">
          <FormField label="API Base URL">
            <input type="text" value={config.base_url}
              onChange={e => setConfig({ ...config, base_url: e.target.value })}
              placeholder="https://api.openai.com/v1" style={inputStyle}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')} />
          </FormField>
          <FormField label="API Key">
            <div style={{ position: 'relative' }}>
              <input type={showKey ? 'text' : 'password'} value={config.api_key}
                onChange={e => setConfig({ ...config, api_key: e.target.value })}
                placeholder="sk-..." style={{ ...inputStyle, paddingRight: 36 }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')} />
              <button onClick={() => setShowKey(v => !v)}
                style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', display: 'flex', padding: 0 }}>
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </FormField>
          <FormField label="模型">
            <input type="text" value={config.model}
              onChange={e => setConfig({ ...config, model: e.target.value })}
              placeholder="gpt-4o-mini" style={inputStyle}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')} />
          </FormField>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSave} disabled={saving}
              style={{ flex: 1, height: 40, borderRadius: 6, background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'inherit', opacity: saving ? 0.6 : 1 }}>
              {saving ? <span className="spinner" /> : <Save size={14} />}
              {saving ? '保存中...' : '保存配置'}
            </button>
            <button onClick={handleTest} disabled={testing}
              style={{ height: 40, padding: '0 16px', borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)', fontSize: 13, fontWeight: 500, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'inherit', boxShadow: 'var(--shadow-sm)', opacity: testing ? 0.6 : 1 }}
              onMouseEnter={e => { if (!testing) { e.currentTarget.style.background = 'var(--elevated)'; e.currentTarget.style.color = 'var(--text-1)' } }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.color = 'var(--text-2)' }}>
              {testing ? <span className="spinner" /> : <Wifi size={14} />}
              {testing ? '测试中...' : '测试连接'}
            </button>
          </div>
          {saveStatus && <StatusBadge type={saveStatus.type} msg={saveStatus.msg} onClose={() => setSaveStatus(null)} />}
          {testStatus && <StatusBadge type={testStatus.type} msg={testStatus.msg} onClose={() => setTestStatus(null)} />}
        </SettingsCard>

        {/* OCR Card */}
        <SettingsCard
          title="OCR 配置"
          description="调用 PaddleOCR 官方云端 API，需要 AI Studio API Token。从 aistudio.baidu.com 获取。"
          style={{ marginTop: 16 }}>
          <FormField label="API Token">
            <div style={{ position: 'relative' }}>
              <input type={showToken ? 'text' : 'password'} value={ocrConfig.api_token}
                onChange={e => setOcrConfig(c => ({ ...c, api_token: e.target.value }))}
                placeholder="ae6e707c..." style={{ ...inputStyle, paddingRight: 36 }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')} />
              <button onClick={() => setShowToken(v => !v)}
                style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', display: 'flex', padding: 0 }}>
                {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </FormField>
          <FormField label="模型">
            <input type="text" value={ocrConfig.model}
              onChange={e => setOcrConfig(c => ({ ...c, model: e.target.value }))}
              placeholder="PP-OCRv5" style={inputStyle}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')} />
          </FormField>

          {/* 高级配置折叠区 */}
          <button onClick={() => setOcrAdvanced(v => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--text-2)', fontSize: 12, fontWeight: 500, cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-1)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-2)')}>
            <ChevronDown size={13} style={{ transition: 'transform 0.15s', transform: ocrAdvanced ? 'rotate(180deg)' : 'none' }} />
            高级配置
          </button>

          {ocrAdvanced && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 4, paddingLeft: 12, borderLeft: '2px solid var(--border)' }}>
              <FormField label="上传前压缩">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={ocrConfig.compress_enabled}
                    onChange={e => setOcrConfig(c => ({ ...c, compress_enabled: e.target.checked }))}
                    style={{ accentColor: 'var(--accent)', width: 14, height: 14 }} />
                  <span style={{ fontSize: 13, color: 'var(--text-1)' }}>启用图片压缩</span>
                </label>
              </FormField>

              <FormField label={`最长边限制（px）— 当前: ${ocrConfig.compress_max_side === 0 ? '不限' : ocrConfig.compress_max_side}`}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <input type="range" min={512} max={4096} step={256}
                    value={ocrConfig.compress_max_side === 0 ? 4096 : ocrConfig.compress_max_side}
                    disabled={!ocrConfig.compress_enabled}
                    onChange={e => setOcrConfig(c => ({ ...c, compress_max_side: Number(e.target.value) }))}
                    style={{ flex: 1, accentColor: 'var(--accent)' }} />
                  <button onClick={() => setOcrConfig(c => ({ ...c, compress_max_side: 0 }))}
                    disabled={!ocrConfig.compress_enabled}
                    style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4, border: '1px solid var(--border)', background: ocrConfig.compress_max_side === 0 ? 'var(--accent)' : 'var(--surface)', color: ocrConfig.compress_max_side === 0 ? '#fff' : 'var(--text-2)', cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
                    不限
                  </button>
                </div>
              </FormField>

              <FormField label={`JPEG 质量 — 当前: ${Math.round(ocrConfig.compress_quality * 100)}%`}>
                <input type="range" min={50} max={100} step={5}
                  value={Math.round(ocrConfig.compress_quality * 100)}
                  disabled={!ocrConfig.compress_enabled}
                  onChange={e => setOcrConfig(c => ({ ...c, compress_quality: Number(e.target.value) / 100 }))}
                  style={{ width: '100%', accentColor: 'var(--accent)' }} />
              </FormField>
            </div>
          )}

          <button onClick={handleOCRSave} disabled={ocrSaving}
            style={{ width: '100%', height: 40, borderRadius: 6, background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'inherit', opacity: ocrSaving ? 0.6 : 1 }}>
            {ocrSaving ? <span className="spinner" /> : <Save size={14} />}
            {ocrSaving ? '保存中...' : '保存 OCR 配置'}
          </button>
          {ocrSaveStatus && <StatusBadge type={ocrSaveStatus.type} msg={ocrSaveStatus.msg} onClose={() => setOcrSaveStatus(null)} />}
        </SettingsCard>

        {/* ExHentai Card */}
        <SettingsCard
          title="E-hentai / ExHentai 配置"
          description="用于通过 URL 加载画廊。从浏览器登录后的 Cookie 中获取以下字段。"
          style={{ marginTop: 16 }}>
          <FormField label="member_id">
            <input type="text" value={ehConfig.member_id}
              onChange={e => setEhConfig(c => ({ ...c, member_id: e.target.value }))}
              placeholder="123456" style={{ ...inputStyle, fontFamily: 'monospace' }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')} />
          </FormField>
          <FormField label="pass_hash">
            <div style={{ position: 'relative' }}>
              <input type={showPassHash ? 'text' : 'password'} value={ehConfig.pass_hash}
                onChange={e => setEhConfig(c => ({ ...c, pass_hash: e.target.value }))}
                placeholder="a1b2c3d4e5..." style={{ ...inputStyle, paddingRight: 36, fontFamily: 'monospace' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')} />
              <button onClick={() => setShowPassHash(v => !v)}
                style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', display: 'flex', padding: 0 }}>
                {showPassHash ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </FormField>
          <FormField label="igneous（ExHentai 专用，可选）">
            <input type="text" value={ehConfig.igneous}
              onChange={e => setEhConfig(c => ({ ...c, igneous: e.target.value }))}
              placeholder="留空则仅访问 e-hentai" style={{ ...inputStyle, fontFamily: 'monospace' }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')} />
          </FormField>
          <button onClick={handleEhSave} disabled={ehSaving}
            style={{ width: '100%', height: 40, borderRadius: 6, background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'inherit', opacity: ehSaving ? 0.6 : 1 }}>
            {ehSaving ? <span className="spinner" /> : <Save size={14} />}
            {ehSaving ? '保存中...' : '保存配置'}
          </button>
          {ehSaveStatus && <StatusBadge type={ehSaveStatus.type} msg={ehSaveStatus.msg} onClose={() => setEhSaveStatus(null)} />}
        </SettingsCard>

        {/* Redeem Card */}
        <SettingsCard
          title="兑换码"
          description="输入兑换码后，填入预设配置信息"
          style={{ marginTop: 16 }}>
          <FormField label="兑换码">
            <input type="text" value={redeemCodeInput}
              onChange={e => setRedeemCodeInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleRedeem()}
              placeholder="输入兑换码..." style={{ ...inputStyle, letterSpacing: '0.05em' }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')} />
          </FormField>
          <button onClick={handleRedeem} disabled={redeeming || !redeemCodeInput.trim()}
            style={{ width: '100%', height: 40, borderRadius: 6, background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', cursor: redeeming || !redeemCodeInput.trim() ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'inherit', opacity: redeeming || !redeemCodeInput.trim() ? 0.6 : 1 }}>
            {redeeming ? <span className="spinner" /> : null}
            {redeeming ? '兑换中...' : '立即兑换'}
          </button>
          {redeemStatus && <StatusBadge type={redeemStatus.type} msg={redeemStatus.msg} onClose={() => setRedeemStatus(null)} />}
        </SettingsCard>

        <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-3)', marginTop: 24 }}>
          配置仅保存在浏览器 localStorage，不会上传到任何服务器
        </p>
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SettingsCard({ title, description, children, style }: {
  title: string; description: string; children: React.ReactNode; style?: React.CSSProperties
}) {
  return (
    <div style={{ borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', overflow: 'hidden', boxShadow: 'var(--shadow-sm)', ...style }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-1)', marginBottom: 4 }}>{title}</h2>
        <p style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6 }}>{description}</p>
      </div>
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {children}
      </div>
    </div>
  )
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text-2)', marginBottom: 6 }}>
        {label}
      </label>
      {children}
    </div>
  )
}

function StatusBadge({ type, msg, onClose }: { type: 'success' | 'error'; msg: string; onClose: () => void }) {
  return (
    <div className="fade-in" style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 6, fontSize: 12,
      background: type === 'success' ? 'var(--green-bg)' : 'var(--red-bg)',
      border: `1px solid ${type === 'success' ? 'rgba(26,127,55,0.3)' : 'rgba(207,34,46,0.25)'}`,
      color: type === 'success' ? 'var(--green)' : 'var(--red)',
    }}>
      {type === 'success' ? <Check size={13} /> : <AlertCircle size={13} />}
      <span style={{ flex: 1 }}>{msg}</span>
      <button onClick={onClose}
        style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', opacity: 0.6, fontSize: 16, lineHeight: 1, padding: 0 }}
        onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
        onMouseLeave={e => (e.currentTarget.style.opacity = '0.6')}>
        ×
      </button>
    </div>
  )
}
