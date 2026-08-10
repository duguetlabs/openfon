import { useCallback, useEffect, useState, createContext, useContext } from 'react';
import { Routes, Route, Navigate, useNavigate, Link, useLocation } from 'react-router-dom';
import { api, type Assistant, type Business, type Me } from './api';
import { Logo, Spinner } from './ui';
import AuthPage from './pages/Auth';
import Onboarding from './pages/Onboarding';
import Dashboard from './pages/Dashboard';
import CallDetailPage from './pages/CallDetail';
import Settings from './pages/Settings';
import Widget from './pages/Widget';
import { compatibilityAssistant, compatibilitySetupPending } from './session-gate';

interface Session {
  me: Me | null;
  business: Business | null;
  workspaceReady: boolean;
  firstAssistant: Assistant | null;
  firstAssistantReady: boolean;
  refresh: () => Promise<void>;
}

const SessionCtx = createContext<Session>({
  me: null,
  business: null,
  workspaceReady: false,
  firstAssistant: null,
  firstAssistantReady: false,
  refresh: async () => {},
});
export const useSession = () => useContext(SessionCtx);

export default function App() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<Me | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [firstAssistant, setFirstAssistant] = useState<Assistant | null>(null);
  const [firstAssistantReady, setFirstAssistantReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const m = await api.me();
      setMe(m);
      // Both endpoints run the compatibility reconciler. Keep them ordered so
      // a resumed onboarding load cannot launch two repairs for the same
      // partially-created workspace.
      const nextBusiness = await api.business();
      const bootstrap = await api.bootstrap();
      setBusiness(nextBusiness);
      setWorkspaceReady(bootstrap.setup.workspace);
      setFirstAssistant(compatibilityAssistant(nextBusiness, bootstrap.assistants));
      setFirstAssistantReady(bootstrap.setup.firstAssistant);
    } catch {
      setMe(null);
      setBusiness(null);
      setWorkspaceReady(false);
      setFirstAssistant(null);
      setFirstAssistantReady(false);
    }
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base">
        <Spinner />
      </div>
    );
  }

  return (
    <SessionCtx.Provider
      value={{ me, business, workspaceReady, firstAssistant, firstAssistantReady, refresh }}
    >
      <Routes>
        <Route path="/call/:slug" element={<Widget />} />
        <Route path="/auth" element={me ? <Navigate to="/" replace /> : <AuthPage />} />
        <Route
          path="/*"
          element={
            !me ? (
              <Navigate to="/auth" replace />
            ) : compatibilitySetupPending(business, workspaceReady, firstAssistantReady, firstAssistant) ? (
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
      className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors ${
        loc.pathname === path
          ? 'bg-wash-iris text-iris shadow-[inset_0_0_0_1px_rgb(88_73_190/0.18)]'
          : 'text-ink-soft hover:bg-wash-iris/60 hover:text-ink'
      }`}
    >
      {label}
    </Link>
  );
  return (
    <div className="atmosphere flex min-h-screen flex-col bg-base">
      <header className="sticky top-0 z-10 border-b border-line bg-base/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-3">
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
                className="ml-2 hidden rounded-lg border border-iris/30 bg-surface px-3.5 py-1.5 text-sm font-semibold text-iris shadow-lift transition-colors hover:border-iris hover:bg-iris hover:text-white sm:block"
              >
                Test call ↗
              </a>
            )}
            <button
              onClick={() => {
                void api.logout().then(refresh);
                nav('/auth');
              }}
              className="ml-1 rounded-lg px-3 py-1.5 text-sm text-ink-soft transition-colors hover:text-ink"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-10">{children}</main>
      <footer className="mx-auto w-full max-w-5xl px-5 pb-8">
        <div className="callline mb-5" />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-ink-soft">
            OpenFon — open-source AI phone agent.{' '}
            <a
              className="font-medium text-ink-soft underline decoration-line-strong underline-offset-2 transition-colors hover:text-iris"
              href="https://github.com/duguetlabs/openfon"
              target="_blank"
              rel="noreferrer"
            >
              github.com/duguetlabs/openfon
            </a>
          </p>
          <p className="font-mono text-[11px] text-ink-faint">self-hosted · MIT licensed</p>
        </div>
      </footer>
    </div>
  );
}
