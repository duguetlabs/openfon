import { useCallback, useEffect, useState, createContext, useContext } from 'react';
import { Routes, Route, Navigate, useNavigate, Link, useLocation } from 'react-router-dom';
import { api, type Business, type Me } from './api';
import { Logo, Spinner } from './ui';
import AuthPage from './pages/Auth';
import Onboarding from './pages/Onboarding';
import Dashboard from './pages/Dashboard';
import CallDetailPage from './pages/CallDetail';
import Settings from './pages/Settings';
import Widget from './pages/Widget';

interface Session {
  me: Me | null;
  business: Business | null;
  refresh: () => Promise<void>;
}

const SessionCtx = createContext<Session>({ me: null, business: null, refresh: async () => {} });
export const useSession = () => useContext(SessionCtx);

export default function App() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<Me | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);

  const refresh = useCallback(async () => {
    try {
      const m = await api.me();
      setMe(m);
      setBusiness(await api.business());
    } catch {
      setMe(null);
      setBusiness(null);
    }
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <Spinner />
      </div>
    );
  }

  return (
    <SessionCtx.Provider value={{ me, business, refresh }}>
      <Routes>
        <Route path="/call/:slug" element={<Widget />} />
        <Route path="/auth" element={me ? <Navigate to="/" replace /> : <AuthPage />} />
        <Route
          path="/*"
          element={
            !me ? (
              <Navigate to="/auth" replace />
            ) : !business ? (
              <Onboarding />
            ) : (
              <Shell>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/calls/:callId" element={<CallDetailPage />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Shell>
            )
          }
        />
      </Routes>
    </SessionCtx.Provider>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { business, refresh } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const tab = (path: string, label: string) => (
    <Link
      to={path}
      className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
        loc.pathname === path ? 'bg-pine text-paper' : 'text-ink-soft hover:bg-paper-2 hover:text-pine'
      }`}
    >
      {label}
    </Link>
  );
  return (
    <div className="grain min-h-screen bg-paper">
      <header className="sticky top-0 z-10 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3">
          <Link to="/">
            <Logo />
          </Link>
          <nav className="flex items-center gap-1">
            {tab('/', 'Calls')}
            {tab('/settings', 'Settings')}
            {business && (
              <a
                href={`/call/${business.slug}`}
                target="_blank"
                rel="noreferrer"
                className="ml-2 rounded-full border border-ring/40 px-4 py-1.5 text-sm font-semibold text-ring transition-colors hover:bg-ring hover:text-paper"
              >
                Test call ↗
              </a>
            )}
            <button
              onClick={() => {
                void api.logout().then(refresh);
                nav('/auth');
              }}
              className="ml-1 px-3 py-1.5 text-sm text-ink-soft hover:text-ink"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-8">{children}</main>
      <footer className="mx-auto max-w-5xl px-5 pb-8">
        <div className="callline mb-4" />
        <p className="text-xs text-ink-soft">
          OpenFon — open-source AI phone agent.{' '}
          <a className="underline hover:text-pine" href="https://github.com/duguetlabs/openfon" target="_blank" rel="noreferrer">
            github.com/duguetlabs/openfon
          </a>
        </p>
      </footer>
    </div>
  );
}
