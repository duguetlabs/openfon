import { useEffect } from "react";
import type { ReactNode } from "react";
import { Icon } from "./icons";
export function Button({
  children,
  onClick,
  kind = "primary",
  disabled = false,
  type = "button",
  icon,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "primary" | "quiet" | "danger" | "line";
  disabled?: boolean;
  type?: "button" | "submit";
  icon?: string;
}) {
  return (
    <button
      type={type}
      className={`of-button ${kind}`}
      onClick={onClick}
      disabled={disabled}
    >
      {icon && <Icon name={icon} />} {children}
    </button>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="of-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`of-notice ${error ? "error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
export const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
export function Loading() {
  return (
    <div className="of-loading" role="status" aria-label="Loading">
      <div />
      <div />
      <div />
      <span>Opening your desk…</span>
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="of-empty">
      <Icon name="message" size={30} />
      <div>
        <h3>{title}</h3>
        <div className="of-empty-copy">{children}</div>
      </div>
    </div>
  );
}

export function canLeave() {
  return window.dispatchEvent(new Event("openfon:leave", { cancelable: true }));
}
export function useDirtyGuard(dirty: boolean) {
  useEffect(() => {
    const guard = (e: Event) => {
      if (
        dirty &&
        !window.confirm(
          "You have unsaved changes. Discard them and leave this page?",
        )
      )
        e.preventDefault();
    };
    const unload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("openfon:leave", guard);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("openfon:leave", guard);
      window.removeEventListener("beforeunload", unload);
    };
  }, [dirty]);
}
