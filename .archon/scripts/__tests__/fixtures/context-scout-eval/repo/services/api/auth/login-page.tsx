import { useState } from 'react';

/** The sign-in form. It only collects what the user types and posts it. */
export function LoginPage({ action }: { action: string }) {
  const [email, setEmail] = useState('');
  const [showHint, setShowHint] = useState(false);

  return (
    <main className="login">
      <h1>Sign in</h1>
      <form method="post" action={action}>
        <label>
          Email
          <input name="email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" />
        </label>
        <button type="submit">Continue</button>
      </form>
      <button type="button" className="link" onClick={() => setShowHint(!showHint)}>
        Trouble signing in?
      </button>
      {showHint && <p>Ask your workspace owner to send you a new invitation.</p>}
    </main>
  );
}
