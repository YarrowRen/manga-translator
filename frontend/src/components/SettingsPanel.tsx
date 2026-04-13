import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { ArrowLeft, Save, Wifi, Eye, EyeOff } from 'lucide-react'

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
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestStatus(null)
    try {
      const { data } = await axios.post('/api/settings/test')
      setTestStatus({ type: 'success', msg: data.message })
    } catch (e: any) {
      setTestStatus({ type: 'error', msg: e.response?.data?.detail || '连接失败' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="min-h-screen" style={{ background: '#0f0f1a', color: '#e8e8f0' }}>
      {/* Header */}
      <div
        className="flex items-center gap-3 px-6 py-4 border-b"
        style={{ borderColor: '#2e2e4a', background: '#161627' }}
      >
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg transition-colors"
          style={{ color: '#9898b8', background: '#1c1c30' }}
          onMouseEnter={e => (e.currentTarget.style.color = '#e8e8f0')}
          onMouseLeave={e => (e.currentTarget.style.color = '#9898b8')}
        >
          <ArrowLeft size={15} />
          返回
        </button>
        <h1 className="text-lg font-semibold" style={{ color: '#e8e8f0' }}>LLM 配置</h1>
      </div>

      {/* Form */}
      <div className="max-w-xl mx-auto mt-12 px-6">
        <div
          className="rounded-2xl p-8"
          style={{ background: '#161627', border: '1px solid #2e2e4a' }}
        >
          <p className="text-sm mb-8" style={{ color: '#9898b8' }}>
            配置 OpenAI 兼容的 LLM 接口，用于漫画文字的批量翻译。
          </p>

          {/* Base URL */}
          <div className="mb-5">
            <label className="block text-sm font-medium mb-2" style={{ color: '#9898b8' }}>
              API Base URL
            </label>
            <input
              type="text"
              value={config.base_url}
              onChange={e => setConfig({ ...config, base_url: e.target.value })}
              placeholder="https://api.openai.com/v1"
              className="w-full px-4 py-2.5 rounded-lg text-sm outline-none transition-all"
              style={{
                background: '#1c1c30',
                border: '1px solid #2e2e4a',
                color: '#e8e8f0',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = '#6366f1')}
              onBlur={e => (e.currentTarget.style.borderColor = '#2e2e4a')}
            />
          </div>

          {/* API Key */}
          <div className="mb-5">
            <label className="block text-sm font-medium mb-2" style={{ color: '#9898b8' }}>
              API Key
            </label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={config.api_key}
                onChange={e => setConfig({ ...config, api_key: e.target.value })}
                placeholder="sk-..."
                className="w-full px-4 py-2.5 pr-10 rounded-lg text-sm outline-none transition-all"
                style={{
                  background: '#1c1c30',
                  border: '1px solid #2e2e4a',
                  color: '#e8e8f0',
                }}
                onFocus={e => (e.currentTarget.style.borderColor = '#6366f1')}
                onBlur={e => (e.currentTarget.style.borderColor = '#2e2e4a')}
              />
              <button
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2"
                style={{ color: '#5a5a7a' }}
              >
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          {/* Model */}
          <div className="mb-8">
            <label className="block text-sm font-medium mb-2" style={{ color: '#9898b8' }}>
              模型
            </label>
            <input
              type="text"
              value={config.model}
              onChange={e => setConfig({ ...config, model: e.target.value })}
              placeholder="gpt-4o-mini"
              className="w-full px-4 py-2.5 rounded-lg text-sm outline-none transition-all"
              style={{
                background: '#1c1c30',
                border: '1px solid #2e2e4a',
                color: '#e8e8f0',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = '#6366f1')}
              onBlur={e => (e.currentTarget.style.borderColor = '#2e2e4a')}
            />
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              style={{ background: '#6366f1', color: '#fff' }}
              onMouseEnter={e => !saving && (e.currentTarget.style.background = '#818cf8')}
              onMouseLeave={e => (e.currentTarget.style.background = '#6366f1')}
            >
              <Save size={15} />
              {saving ? '保存中...' : '保存配置'}
            </button>
            <button
              onClick={handleTest}
              disabled={testing}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              style={{ background: '#1c1c30', border: '1px solid #2e2e4a', color: '#9898b8' }}
              onMouseEnter={e => !testing && (e.currentTarget.style.color = '#e8e8f0')}
              onMouseLeave={e => (e.currentTarget.style.color = '#9898b8')}
            >
              <Wifi size={15} />
              {testing ? '测试中...' : '测试连接'}
            </button>
          </div>

          {/* Status messages */}
          {saveStatus && (
            <div
              className="mt-4 px-4 py-2.5 rounded-lg text-sm"
              style={{
                background: saveStatus.type === 'success' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                color: saveStatus.type === 'success' ? '#22c55e' : '#ef4444',
                border: `1px solid ${saveStatus.type === 'success' ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
              }}
            >
              {saveStatus.msg}
            </div>
          )}
          {testStatus && (
            <div
              className="mt-3 px-4 py-2.5 rounded-lg text-sm"
              style={{
                background: testStatus.type === 'success' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                color: testStatus.type === 'success' ? '#22c55e' : '#ef4444',
                border: `1px solid ${testStatus.type === 'success' ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
              }}
            >
              {testStatus.msg}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
