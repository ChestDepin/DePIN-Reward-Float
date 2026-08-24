import { NavLink, Outlet } from 'react-router-dom'

const NAV = [
  { to: '/lookup', label: 'LOOKUP' },
  { to: '/history', label: 'HISTORY' },
  { to: '/limit', label: 'LIMIT' },
  { to: '/offer', label: 'OFFER' },
]

const Terminal = () => {
  return (
    <div className="min-h-screen bg-ground text-ink">
      <div className="mx-auto w-full max-w-3xl px-5 sm:px-8">
        <header className="border-b border-rule py-5">
          <nav className="flex flex-wrap items-center gap-x-1 gap-y-2 text-[12px] sm:text-[13px] tracking-[0.14em]">
            {NAV.map((item, i) => (
              <span key={item.to} className="flex items-center">
                {i > 0 && <span className="px-2 text-dim">·</span>}
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    isActive
                      ? 'text-ink underline underline-offset-[6px] decoration-1'
                      : 'text-dim hover:text-ink transition-none'
                  }
                >
                  {item.label}
                </NavLink>
              </span>
            ))}
          </nav>
        </header>

        <main className="py-10 sm:py-14">
          <Outlet />
        </main>

        <footer className="border-t border-rule py-6 text-[11px] leading-relaxed text-dim">
          Reads public payout history. Nothing is signed. No wallet is connected.
          <br />
          Network names appear only as the source of the payout data being read. All addresses and
          figures shown are fictional demonstration data.
        </footer>
      </div>
    </div>
  )
}

export default Terminal
