import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { WorkbenchProvider } from './store/workbenchContext'
import Workbench from './components/Workbench'
import SettingsPanel from './components/SettingsPanel'

export default function App() {
  return (
    <BrowserRouter>
      <WorkbenchProvider>
        <Routes>
          <Route path="/" element={<Workbench />} />
          <Route path="/settings" element={<SettingsPanel />} />
        </Routes>
      </WorkbenchProvider>
    </BrowserRouter>
  )
}
