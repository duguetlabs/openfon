import { useCallback, useEffect, useRef, useState, createContext, useContext } from 'react';
import { Routes, Route, Navigate, useNavigate, Link, useLocation } from 'react-router-dom';
import { api, type Assistant, type Business, type Me } from './api';
import { Logo, Spinner } from './ui';
import AuthPage from './pages/Auth';
import Onboarding from './pages/Onboarding';
import Dashboard from './pages/Dashboard';
import CallDetailPage from './pages/CallDetail';
import Settings from './pages/Settings';
import Widget from './pages/Widget';
import {
  CompatibilitySessionCoordinator,
  loadCompatibilitySession,
  SIGN_OUT_UNCONFIRMED_MESSAGE,
  type CompatibilitySessionSnapshot,
} from './session-load';
import { compatibilitySetupPending } from './session-gate';

interface Session {
  me: Me | null;
  business: Business | null;
  workspaceReady: boolean;
  firstAssistant: Assistant | null;
  firstAssistantReady: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  signOutPending: boolean;
  signOutWarning: string | null;
}

const SessionCtx = createContext<Session>({
  me: null,
  business: null,
  workspaceReady: false,
  firstAssistant: null,
  firstAssistantReady: false,
  refresh: async () => {},
  signOut: async () => {},
  signOutPending: false,
  signOutWarning: null,
});
export const useSession = () => useContext(SessionCtx);

export default function App() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<Me | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [firstAssistant, setFirstAssistant] = useState<Assistant | null>(null);
  const [firstAssistantReady, setFirstAssistantReady] = useState(false);
  const [signOutPending, setSignOutPending] = useState(false);
  const [signOutWarning, setSignOutWarning] = useState<string | null>(null);
  const sessionCoordinator = useRef(new CompatibilitySessionCoordinator());

  const clearSession = useCallback(() => {
    setMe(null);
    setBusiness(null);
    setWorkspaceReady(false);
    setFirstAssistant(null);
    setFirstAssistantReady(false);
  }, []);

  const publishSession = useCallback((snapshot: CompatibilitySessionSnapshot) => {
    // Publish the account and its workspace as one renderable snapshot. If
    // `me` lands first after sign-in, a resumable Onboarding mounts against a
    // transient null business and keeps those empty one-shot form values.
    setMe(snapshot.me);
    setBusiness(snapshot.business);
    setWorkspaceReady(snapshot.workspaceReady);
    setFirstAssistant(snapshot.firstAssistant);
    setFirstAssistantReady(snapshot.firstAssistantReady);
    // A confirmed authenticated refresh (including login/signup) supersedes a
    // previous unconfirmed logout attempt.
    setSignOutPending(false);
    setSignOutWarning(null);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    await sessionCoordinator.current.refresh(loadCompatibilitySession, publishSession, () => {
      clearSession();
      setSignOutPending(false);
      setLoading(false);
    });
  }, [clearSession, publishSession]);

  const signOut = useCallback(() => {
    setSignOutPending(true);
    return sessionCoordinator.current.signOut(api.logout, {
      clearLocal: clearSession,
      confirmed: () => {
        setSignOutPending(false);
        setSignOutWarning(null);
      },
      failed: () => {
        setSignOutPending(false);
        setSignOutWarning(SIGN_OUT_UNCONFIRMED_MESSAGE);
      },
    });
  }, [clearSession]);

  useEffect(() => {
    void refresh();
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
      value={{
        me,
        business,
        workspaceReady,
        firstAssistant,
        firstAssistantReady,
        refresh,
        signOut,
        signOutPending,
        signOutWarning,
      }}
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
  const { business, signOut } = useSession();
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
                void signOut().catch(() => {
                  // The persistent auth-screen warning owns this handled error.
                });
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
