import { type ReactNode, useState } from 'react'
import {
  LayoutDashboard, Bot, CreditCard, ShieldCheck, Code2, Menu, X, Zap
} from 'lucide-react'
import { ConnectKitButton } from 'connectkit'
import { cn } from '@/lib/utils'

export type NavPage = 'overview' | 'agents' | 'payments' | 'policy' | 'developer'

interface Props {
  children: ReactNode
  page: NavPage
  onNav: (p: NavPage) => void
}

const NAV = [
  { id: 'overview' as NavPage,   label: 'Overview',    icon: LayoutDashboard },
  { id: 'agents' as NavPage,     label: 'Agents',      icon: Bot },
  { id: 'payments' as NavPage,   label: 'Payments',    icon: CreditCard },
  { id: 'policy' as NavPage,     label: 'Policy',      icon: ShieldCheck },
  { id: 'developer' as NavPage,  label: 'Developer',   icon: Code2 },
]

export function Layout({ children, page, onNav }: Props) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="flex min-h-dvh">
      {/* Sidebar */}
      <aside className={cn(
        'fixed inset-y-0 left-0 z-40 w-60 flex flex-col border-r transition-transform duration-200',
        'bg-white/90 backdrop-blur-xl border-[var(--border)]',
        mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
      )}>
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-5 py-5 border-b border-[var(--border)]">
          <div className="w-8 h-8 rounded-lg bg-[var(--accent)] flex items-center justify-center">
            <Zap size={16} className="text-white" />
          </div>
          <span className="display font-700 text-[var(--ink)] text-base tracking-tight">AgentPay</span>
        </div>

        {/* Nav links */}
        <nav className="flex-1 py-4 px-3 space-y-0.5">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => { onNav(id); setMobileOpen(false) }}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all',
                page === id
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--ink)]',
              )}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>

        {/* Network badge */}
        <div className="px-5 pb-5">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-xs font-medium text-emerald-700">Arc Testnet</span>
          </div>
        </div>
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col lg:ml-60">
        {/* Topbar */}
        <header className="sticky top-0 z-20 bg-white/80 backdrop-blur-xl border-b border-[var(--border)] h-14 flex items-center px-4 lg:px-6 gap-4">
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="lg:hidden p-2 rounded-lg hover:bg-[var(--surface-muted)] text-[var(--muted)]"
          >
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          <div className="flex-1" />
          <ConnectKitButton />
        </header>

        {/* Content */}
        <main className="flex-1 p-4 lg:p-6 max-w-6xl w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  )
}
