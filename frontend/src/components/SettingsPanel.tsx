import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { ArrowLeft, Save, Wifi, Eye, EyeOff, Check, AlertCircle, Type } from 'lucide-react'

interface Config {
  base_url: string
  api_key: string
  model: string
}

export default function SettingsPanel() {
  const navigate = useNavigate()
  const [config, setConfig] = useState<Config>({
    base_url: 'https://api.openai.com/v1',
    api_key: '',
    model: 'gpt-4o-mini',
  })
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const [testStatus, setTestStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)

  useEffect(() => {
    axios.get('/api/settings').then(({ data }) => {
      setConfig({
        base_url: data.base_url || '',
        api_key: data.api_key_set ? '••••••••' : '',
        model: data.model || '',
      })
    }).catch(() => {})
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setSaveStatus(null)
    try {
      await axios.post('/api/settings', config)
      setSaveStatus({ type: 'success', msg: '配置已保存' })
    } catch (e: any) {
      setSaveStatus({ type: 'error', msg: e.response?.data?.detail || '保存失败' })
    } finally { setSaving(false) }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestStatus(null)
    try {
      const { data } = await axios.post('/api/settings/test')
      setTestStatus({ type: 'success', msg: data.message })
    } catch (e: any) {
      setTestStatus({ type: 'error', msg: e.response?.data?.detail || '连接失败' })
    } finally { setTesting(false) }
  }

  return (
    <div style={{ minHeight: '100dvh', background: '#09090f', color: '#eeeef8' }}>

      {/* Header */}
      <header style={{ background: '#0d0d1c', borderBottom: '1px solid #1a1a30' }}
        className="flex items-center gap-3 px-4 md:px-6 py-3 md:py-3.5">
        <button onClick={() => navigate('/')}
          className="w-8 h-8 rounded-xl flex items-center justify-center"
          style={{ background: '#13132a', color: '#6060a0', border: '1px solid #1a1a35' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#a0a0d8' }}
          onMouseLeave={e => { e.currentTarget.style.color = '#6060a0' }}>
          <ArrowLeft size={15} />
        </button>

        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #6366f1 0%, #818cf8 100%)' }}>
            <Type size={13} color="white" />
          </div>
          <span className="font-semibold text-sm" style={{ color: '#c7c7f0', letterSpacing: '-0.01em' }}>
            MangaTrans
          </span>
        </div>

        <span className="text-sm" style={{ color: '#3a3a60' }}>/</span>
        <span className="text-sm" style={{ color: '#7070a0' }}>LLM 配置</span>
      </header>

      {/* Content */}
      <div className="max-w-lg mx-auto px-4 md:px-6 py-8 md:py-12">

        {/* Card */}
        <div className="rounded-2xl overflow-hidden"
          style={{ background: '#0d0d1c', border: '1px solid #1a1a30' }}>

          {/* Card header */}
          <div className="px-6 py-5" style={{ borderBottom: '1px solid #141428' }}>
            <h2 className="text-base font-semibold mb-1" style={{ color: '#d0d0f0' }}>
              API 连接配置
            </h2>
            <p className="text-xs leading-relaxed" style={{ color: '#3a3a60' }}>
              配置 OpenAI 兼容的 LLM 接口，支持 OpenAI、DeepSeek、通义千问等服务。
            </p>
          </div>

          {/* Form */}
          <div className="px-6 py-5 flex flex-col gap-4">

            <FormField label="API Base URL">
              <input
                type="text"
                value={config.base_url}
                onChange={e => setConfig({ ...config, base_url: e.target.value })}
                placeholder="https://api.openai.com/v1"
                className="w-full px-3.5 py-2.5 rounded-xl text-sm outline-none"
                style={{ background: '#111122', border: '1px solid #1a1a35', color: '#c0c0e8' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'rgba(99,102,241,0.5)')}
                onBlur={e => (e.currentTarget.style.borderColor = '#1a1a35')}
              />
            </FormField>

            <FormField label="API Key">
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={config.api_key}
                  onChange={e => setConfig({ ...config, api_key: e.target.value })}
                  placeholder="sk-..."
                  className="w-full px-3.5 py-2.5 pr-10 rounded-xl text-sm outline-none"
                  style={{ background: '#111122', border: '1px solid #1a1a35', color: '#c0c0e8' }}
                  onFocus={e => (e.currentTarget.style.borderColor = 'rgba(99,102,241,0.5)')}
                  onBlur={e => (e.currentTarget.style.borderColor = '#1a1a35')}
                />
                <button onClick={() => setShowKey(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center"
                  style={{ color: '#3a3a60' }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#6060a0')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#3a3a60')}>
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </FormField>

            <FormField label="模型">
              <input
                type="text"
                value={config.model}
                onChange={e => setConfig({ ...config, model: e.target.value })}
                placeholder="gpt-4o-mini"
                className="w-full px-3.5 py-2.5 rounded-xl text-sm outline-none"
                style={{ background: '#111122', border: '1px solid #1a1a35', color: '#c0c0e8' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'rgba(99,102,241,0.5)')}
                onBlur={e => (e.currentTarget.style.borderColor = '#1a1a35')}
              />
            </FormField>
          </div>

          {/* Actions */}
          <div className="px-6 pb-6 flex flex-col gap-3">
            <div className="flex gap-2.5">
              <button onClick={handleSave} disabled={saving}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium flex-1 justify-center disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #5254e8 0%, #7c7ef0 100%)', color: '#fff' }}>
                {saving ? <span className="spinner" /> : <Save size={14} />}
                {saving ? '保存中...' : '保存配置'}
              </button>

              <button onClick={handleTest} disabled={testing}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium disabled:opacity-50"
                style={{ background: '#111122', border: '1px solid #1a1a35', color: '#6060a0' }}
                onMouseEnter={e => { if (!testing) e.currentTarget.style.color = '#a0a0d8' }}
                onMouseLeave={e => { e.currentTarget.style.color = '#6060a0' }}>
                {testing ? <span className="spinner" /> : <Wifi size={14} />}
                {testing ? '测试中...' : '测试连接'}
              </button>
            </div>

            {/* Status messages */}
            {saveStatus && (
              <StatusBadge type={saveStatus.type} msg={saveStatus.msg} onClose={() => setSaveStatus(null)} />
            )}
            {testStatus && (
              <StatusBadge type={testStatus.type} msg={testStatus.msg} onClose={() => setTestStatus(null)} />
            )}
          </div>
        </div>

        {/* Hint */}
        <p className="text-center text-xs mt-6" style={{ color: '#252540' }}>
          配置仅保存在服务端 .env 文件，不会上传到任何第三方
        </p>
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium mb-1.5" style={{ color: '#404070' }}>{label}</label>
      {children}
    </div>
  )
}

function StatusBadge({ type, msg, onClose }: { type: 'success' | 'error'; msg: string; onClose: () => void }) {
  return (
    <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-sm fade-in"
      style={{
        background: type === 'success' ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
        border: `1px solid ${type === 'success' ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
        color: type === 'success' ? '#4ade80' : '#f87171',
      }}>
      {type === 'success' ? <Check size={13} /> : <AlertCircle size={13} />}
      <span className="flex-1 text-xs">{msg}</span>
      <button onClick={onClose} style={{ opacity: 0.5 }} onMouseEnter={e => (e.currentTarget.style.opacity = '1')} onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}>
        ×
      </button>
    </div>
  )
}
