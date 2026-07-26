import { NavLink, Route, Routes } from 'react-router-dom'
import { clsx } from 'clsx'
import { ScriptsPage } from '@/pages/ScriptsPage'
import { PracticePage } from '@/pages/PracticePage'
import { HistoryPage } from '@/pages/HistoryPage'
import { RecordingDetailPage } from '@/pages/RecordingDetailPage'

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        clsx(
          'rounded-full px-4 py-1.5 text-sm font-semibold transition-colors',
          isActive
            ? 'bg-rose-soft text-rose-deep'
            : 'text-ink-soft hover:bg-rose-whisper hover:text-ink',
        )
      }
    >
      {children}
    </NavLink>
  )
}

export default function App() {
  return (
    <div className="mx-auto min-h-screen max-w-5xl px-4 pb-24 sm:px-6">
      <header className="flex items-center justify-between py-6">
        <NavLink to="/" className="flex items-baseline gap-2">
          <span className="text-2xl" aria-hidden>
            🌅
          </span>
          <span className="font-display text-2xl font-bold tracking-tight text-ink">
            voicetrain
          </span>
        </NavLink>
        <nav className="flex items-center gap-1.5">
          <NavItem to="/">Practice</NavItem>
          <NavItem to="/history">History</NavItem>
        </nav>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<ScriptsPage />} />
          <Route path="/practice/:scriptId" element={<PracticePage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/recordings/:id" element={<RecordingDetailPage />} />
        </Routes>
      </main>
    </div>
  )
}
