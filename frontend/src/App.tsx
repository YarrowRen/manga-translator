import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Workbench from './components/Workbench'
import SettingsPanel from './components/SettingsPanel'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Workbench />} />
        <Route path="/settings" element={<SettingsPanel />} />
      </Routes>
    </BrowserRouter>
  )
}
