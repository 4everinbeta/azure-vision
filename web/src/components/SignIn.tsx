import { useEffect, useState } from "react";

export interface AuthStatus {
  signedIn: boolean;
  user?: string;
  pending?: { userCode: string; verificationUri: string };
  error?: string;
}

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [status, setStatus] = useState<AuthStatus>({ signedIn: false });
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (!started) return;
    const t = setInterval(async () => {
      const s: AuthStatus = await (await fetch("/api/auth/status")).json();
      setStatus(s);
      if (s.signedIn) onSignedIn();
      if (s.error) setStarted(false);
    }, 1500);
    return () => clearInterval(t);
  }, [started, onSignedIn]);

  const start = async () => {
    setStarted(true);
    const res = await fetch("/api/auth/login", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as AuthStatus & { error?: string };
    if (!res.ok) {
      setStatus({ signedIn: false, error: body.error ?? `Sign-in failed (HTTP ${res.status})` });
      setStarted(false);
      return;
    }
    setStatus(body);
  };

  return (
    <div className="signin">
      <h2>Sign in to Azure</h2>
      {!started && <button onClick={start}>Sign in with Microsoft</button>}
      {status.error && <p className="error">{status.error}</p>}
      {started && !status.pending && <p>Requesting sign-in code…</p>}
      {started && status.pending && (
        <>
          <p>
            Open <a href={status.pending.verificationUri} target="_blank" rel="noreferrer">{status.pending.verificationUri}</a> and enter:
          </p>
          <div className="code">{status.pending.userCode}</div>
          <p>Waiting for you to finish signing in…</p>
          <p className="muted">Only enter codes you requested yourself on this page. Each browser signs in separately.</p>
        </>
      )}
    </div>
  );
}
