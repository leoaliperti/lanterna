import { useState, type FormEvent } from "react";
import { Flame } from "lucide-react";
import { Banner, Button, SecureField, TextField } from "../ui";
import { loginErrorMessage } from "../api/client";
import { useSession } from "../session/SessionProvider";
import "./app.css";

/** Schermata di accesso. Nessun link di registrazione: gli account li crea solo l'admin. */
export function LoginScreen() {
  const { login } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const emailMissing = touched && email.trim() === "";
  const passwordMissing = touched && password === "";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (busy || email.trim() === "" || password === "") return;
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(loginErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="a-login" aria-labelledby="login-title">
      <div className="a-login__card a-enter">
        <div className="a-login__brand">
          <span className="a-login__logo" aria-hidden="true">
            <Flame size={32} />
          </span>
          <h1 id="login-title" className="t-title1">
            Lanterna
          </h1>
          <p className="t-subhead a-muted">Accedi per entrare al tavolo.</p>
        </div>

        <form className="a-form" onSubmit={onSubmit} noValidate>
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <TextField
            label="Email"
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={emailMissing ? "Inserisci la tua email." : undefined}
          />
          <SecureField
            label="Password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={passwordMissing ? "Inserisci la tua password." : undefined}
          />
          <Button type="submit" size="lg" fullWidth loading={busy}>
            {busy ? "Accesso in corso" : "Accedi"}
          </Button>
        </form>

        <p className="t-footnote a-muted a-login__note">Non hai un account? Chiedilo a chi gestisce il tavolo (il GM).</p>
      </div>
    </main>
  );
}
