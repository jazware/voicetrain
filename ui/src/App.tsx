import { NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { clsx } from 'clsx'
import { Settings2 } from 'lucide-react'
import { ScriptsPage } from '@/pages/ScriptsPage'
import { PracticePage } from '@/pages/PracticePage'
import { HistoryPage } from '@/pages/HistoryPage'
import { RecordingDetailPage } from '@/pages/RecordingDetailPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { RoutinePage } from '@/pages/RoutinePage'

const navClass = (active: boolean) =>
  clsx(
    'flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors sm:px-4',
    active ? 'bg-rose-soft text-rose-deep' : 'text-ink-soft hover:bg-rose-whisper hover:text-ink',
  )

export default function App() {
  const { pathname } = useLocation()
  const practicing = pathname === '/' || pathname.startsWith('/practice') || pathname.startsWith('/routine')
  const reviewing = pathname.startsWith('/history') || pathname.startsWith('/recordings')

  return (
    <div className="mx-auto min-h-screen max-w-6xl px-4 pb-16 sm:px-6">
      <header className="flex items-center justify-between gap-3 py-5 sm:py-6">
        <NavLink to="/" className="flex items-baseline gap-2" aria-label="voicetrain home">
          <span className="text-2xl" aria-hidden>
            🌅
          </span>
          <span className="font-display text-2xl font-bold tracking-tight text-ink max-sm:sr-only">
            voicetrain
          </span>
        </NavLink>
        <nav className="flex items-center gap-1">
          <NavLink to="/" className={navClass(practicing)} aria-current={practicing ? 'page' : undefined}>
            Practice
          </NavLink>
          <NavLink to="/history" className={navClass(reviewing)} aria-current={reviewing ? 'page' : undefined}>
            Progress
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => navClass(isActive)} aria-label="Settings">
            <Settings2 size={16} />
          </NavLink>
        </nav>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<ScriptsPage />} />
          <Route path="/practice/:scriptId" element={<PracticePage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/recordings/:id" element={<RecordingDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/routine" element={<RoutinePage />} />
        </Routes>
      </main>
    </div>
  )
}
