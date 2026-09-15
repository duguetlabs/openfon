import { useCallback, useEffect, useRef, useState, createContext, useContext } from 'react';
import { Routes, Route, Navigate, useNavigate, Link, useLocation } from 'react-router-dom';
import { api, ApiError, type BootstrapAssistant, type Business, type Me } from './api';
import { Logo, Spinner } from './ui';
import AuthPage from './pages/Auth';
import Onboarding from './pages/Onboarding';
import Landing from './pages/Landing';
import { Overview, Assistants, AssistantEditor, Calls, TestStudio, Knowledge } from './pages/Studio';
import CallDetailPage from './pages/CallDetail';
import Settings from './pages/Settings';
import Account from './pages/Account';
import Widget from './pages/Widget';
import {
  CompatibilitySessionCoordinator,
  loadCompatibilitySession,
  SIGN_OUT_UNCONFIRMED_MESSAGE,
  SIGN_OUT_STORAGE_UNKNOWN_MESSAGE,
  SIGN_OUT_LOCAL_CLEANUP_MESSAGE,
  SignOutRecoveryError,
  type SignOutRecovery,
  type CompatibilitySessionSnapshot,
} from './session-load';
import { browserLogoutIntentStorage } from './logout-intent';
import { confirmDiscardUnsaved } from './unsaved-edits';
import { studioSetupPending } from './session-gate';

interface Session {
  me: Me | null;
  business: Business | null;
  workspaceReady: boolean;
  firstAssistant: BootstrapAssistant | null;
  firstAssistantReady: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  signOutPending: boolean;
  signOutWarning: string | null;
  signOutLocalRecovery: boolean;
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
  signOutLocalRecovery: false,
});
export const useSession = () => useContext(SessionCtx);

export default function App() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<Me | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [firstAssistant, setFirstAssistant] = useState<BootstrapAssistant | null>(null);
  const [firstAssistantReady, setFirstAssistantReady] = useState(false);
  const [signOutPending, setSignOutPending] = useState(false);
  const [signOutWarning, setSignOutWarning] = useState<string | null>(null);
  const [signOutLocalRecovery, setSignOutLocalRecovery] = useState(false);
  const [sessionCoordinator] = useState(() => new CompatibilitySessionCoordinator(browserLogoutIntentStorage));
  const hasSession = useRef(false);

  const clearSession = useCallback(() => {
    hasSession.current = false;
    setMe(null);
    setBusiness(null);
    setWorkspaceReady(false);
    setFirstAssistant(null);
    setFirstAssistantReady(false);
  }, []);

  const publishSession = useCallback((snapshot: CompatibilitySessionSnapshot) => {
    hasSession.current = true;
    // Publish the account and its workspace as one renderable snapshot. If
    // `me` lands first after sign-in, a resumable Onboarding mounts against a
    // transient null business and keeps those empty one-shot form values.
    setMe(snapshot.me);
    setBusiness(snapshot.business);
    setWorkspaceReady(snapshot.workspaceReady);
    setFirstAssistant(snapshot.firstAssistant);
    setFirstAssistantReady(snapshot.firstAssistantReady);
    // The coordinator checked durable intent before loading and publishing.
    setSignOutPending(false);
    setSignOutWarning(null);
    setSignOutLocalRecovery(false);
    setLoading(false);
  }, []);

  const showRecovery = useCallback((recovery: SignOutRecovery) => {
    clearSession();
    setSignOutPending(recovery === 'pending');
    setSignOutLocalRecovery(recovery === 'local');
    setSignOutWarning(recovery === 'pending' ? null : recovery === 'local'
      ? SIGN_OUT_LOCAL_CLEANUP_MESSAGE : recovery === 'unknown'
        ? SIGN_OUT_STORAGE_UNKNOWN_MESSAGE : SIGN_OUT_UNCONFIRMED_MESSAGE);
    setLoading(false);
  }, [clearSession]);

  const refresh = useCallback(async () => {
    await sessionCoordinator.refresh(loadCompatibilitySession, publishSession, error => {
      // A temporary post-save read failure does not invalidate the authenticated
      // snapshot. Let the saving page report recovery without losing its state.
      if (!hasSession.current || (error instanceof ApiError && (error.status === 401 || error.status === 403))) clearSession();
      setSignOutPending(false);
      setLoading(false);
      throw error;
    }, showRecovery);
  }, [clearSession, publishSession, sessionCoordinator, showRecovery]);

  const signOut = useCallback(() => {
    setSignOutPending(true);
    return sessionCoordinator.signOut(api.logout, {
      clearLocal: clearSession,
      confirmed: () => {
        setSignOutPending(false);
        setSignOutWarning(null);
        setSignOutLocalRecovery(false);
      },
      failed: error => showRecovery(error instanceof SignOutRecoveryError ? error.recovery : 'unconfirmed'),
    });
  }, [clearSession, sessionCoordinator, showRecovery]);

  useEffect(() => {
    void refresh().catch(() => {}); // Initial signed-out/unavailable load has no saving page.
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
        signOutLocalRecovery,
      }}
    >
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/call/:slug" element={<Widget />} />
        <Route path="/auth" element={me ? <Navigate to="/overview" replace /> : <AuthPage />} />
        <Route
          path="/*"
          element={
            !me ? (
              <Navigate to="/auth" replace />
            ) : studioSetupPending(business, workspaceReady, firstAssistant) ? (
              <Onboarding />
            ) : (
              <Shell>
                <Routes>
                  <Route path="/overview" element={<Overview />} />
                  <Route path="/assistants" element={<Assistants />} />
                  <Route path="/assistants/:assistantId" element={<AssistantEditor />} />
                  <Route path="/test" element={<TestStudio />} />
                  <Route path="/knowledge" element={<Knowledge />} />
                  <Route path="/calls" element={<Calls />} />
                  <Route path="/calls/:callId" element={<CallDetailPage />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/account" element={<Account />} />
                  <Route path="*" element={<Navigate to="/overview" replace />} />
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
  const { signOut } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const tab = (path: string, label: string) => (
    <Link
      to={path}
      aria-current={(loc.pathname === path || loc.pathname.startsWith(path + '/')) ? 'page' : undefined}
      className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors ${
        (loc.pathname === path || (path !== '/overview' && loc.pathname.startsWith(path + '/')))
          ? 'bg-wash-iris text-iris shadow-[inset_0_0_0_1px_rgb(88_73_190/0.18)]'
          : 'text-ink-soft hover:bg-wash-iris/60 hover:text-ink'
      }`}
    >
      {label}
    </Link>
  );
  return (
    <div className="studio-theme atmosphere flex min-h-screen flex-col bg-base">
      <a className="studio-skip" href="#workspace-content">Skip to workspace content</a>
      <header className="sticky top-0 z-10 border-b border-line bg-base/85 backdrop-blur-md">
        <div className="studio-shell-header mx-auto w-full max-w-6xl px-5 py-3">
          <Link to="/overview">
            <Logo />
          </Link>
          <nav className="studio-nav" aria-label="Workspace">
            {tab('/overview', 'Overview')}
            {tab('/assistants', 'Assistants')}
            {tab('/test', 'Test Studio')}
            {tab('/calls', 'Calls')}
            {tab('/knowledge', 'Knowledge')}
            {tab('/settings', 'Settings')}
            {tab('/account', 'Account')}
            <button
              onClick={() => {
                if (!confirmDiscardUnsaved()) return;
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
      <main id="workspace-content" tabIndex={-1} className="studio-shell-main mx-auto w-full max-w-5xl flex-1 px-5 py-10">{children}</main>
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
