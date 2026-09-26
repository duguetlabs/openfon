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
import { confirmDiscardUnsaved, useUnsavedNavigationGuard } from './unsaved-edits';
import { studioSetupPending } from './session-gate';

interface Session {
  me: Me | null;
  business: Business | null;
  workspaceReady: boolean;
  firstAssistant: BootstrapAssistant | null;
  firstAssistantReady: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  deleteAccount: (input: Parameters<typeof api.deleteAccount>[0]) => Promise<void>;
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
  deleteAccount: async () => {},
  signOutPending: false,
  signOutWarning: null,
  signOutLocalRecovery: false,
});
export const useSession = () => useContext(SessionCtx);

export default function App() {
  useUnsavedNavigationGuard();
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

  const deleteAccount = useCallback(async (input: Parameters<typeof api.deleteAccount>[0]) => {
    await sessionCoordinator.deleteAccount(() => api.deleteAccount(input), {
      clearLocal: () => { clearSession(); setSignOutPending(false); },
      confirmed: () => {
        setSignOutPending(false);
        setSignOutWarning(null);
        setSignOutLocalRecovery(false);
      },
      failed: error => showRecovery(error instanceof SignOutRecoveryError ? error.recovery : 'local'),
    });
  }, [clearSession, sessionCoordinator, showRecovery]);

  useEffect(() => {
    void refresh().catch(() => {}); // Initial signed-out/unavailable load has no saving page.
    return () => sessionCoordinator.invalidate();
  }, [refresh, sessionCoordinator]);

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
        deleteAccount,
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
  const { signOut, business } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const menu = navigation.current;
    const active = menu?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!menu || !active) return;
    const revealCurrent = () => {
      if (menu.scrollWidth <= menu.clientWidth) return;
      const container = menu.getBoundingClientRect(), link = active.getBoundingClientRect();
      if (link.left < container.left) menu.scrollLeft += link.left - container.left;
      else if (link.right > container.right) menu.scrollLeft += link.right - container.right;
    };
    revealCurrent();
    const observer = new ResizeObserver(revealCurrent);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [loc.pathname]);
  const tab = (path: string, label: string) => (
    <Link
      to={path}
      aria-current={(loc.pathname === path || loc.pathname.startsWith(path + '/')) ? 'page' : undefined}
      className="workspace-nav-link"
    >
      {label}
    </Link>
  );
  return (
    <div className="studio-theme workspace-shell min-h-screen bg-base">
      <a className="studio-skip" href="#workspace-content">Skip to workspace content</a>
      <header className="workspace-sidebar">
        <div className="studio-shell-header">
          <Link to="/overview" className="workspace-brand" aria-label="OpenFon overview"><Logo /></Link>
          <p className="workspace-name">{business?.name || 'Your workspace'}</p>
          <nav ref={navigation} className="studio-nav" aria-label="Workspace">
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
              className="workspace-signout"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>
      <main id="workspace-content" tabIndex={-1} className="studio-shell-main">{children}</main>
      <footer className="workspace-footer">
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
          <p className="text-xs text-ink-faint">self-hosted · MIT licensed</p>
        </div>
      </footer>
    </div>
  );
}
