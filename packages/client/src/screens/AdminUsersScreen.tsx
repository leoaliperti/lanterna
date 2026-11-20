import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ChevronLeft, Ellipsis, KeyRound, Plus, ShieldCheck, Trash2, UserMinus, UserPlus, UserRound, Users } from "lucide-react";
import { USER_ROLES, type PublicUser, type UserRole } from "@lanterna/shared";
import {
  Alert,
  Avatar,
  Badge,
  Banner,
  Button,
  IconButton,
  List,
  ListRow,
  Menu,
  NavigationBar,
  SecureField,
  SegmentedControl,
  Sheet,
  Spinner,
  TextField,
  useToast,
  type MenuItemSpec
} from "../ui";
import { addCampaignMember, createUser, deleteUser, listMemberIds, listMyCampaigns, listUsers, removeCampaignMember, resetUserPassword, updateUserRole, userErrorMessage } from "../api/client";
import { useSession } from "../session/SessionProvider";
import { navigate } from "../router/hashRouter";
import { EmptyState } from "./EmptyState";
import { PASSWORD_REQUIREMENT, passwordProblem } from "./passwords";
import "./app.css";

const ROLE_LABEL: Record<UserRole, string> = { admin: "Admin (GM)", player: "Giocatore" };
const ROLE_OPTIONS = USER_ROLES.map((role) => ({ value: role, label: role === "admin" ? "Admin" : "Giocatore" }));

/**
 * Gestione utenti. La route e' raggiungibile solo da un admin (guardia in App), ma la sicurezza vera
 * e' sul server: ogni chiamata e' rifiutata con 403 a chi non e' admin.
 */
export function AdminUsersScreen() {
  const { user: me } = useSession();
  const toast = useToast();
  const [users, setUsers] = useState<PublicUser[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [resetFor, setResetFor] = useState<PublicUser | null>(null);
  const [deleteFor, setDeleteFor] = useState<PublicUser | null>(null);

  // Campagna del tavolo e chi ne fa parte: un giocatore vede il tavolo solo dopo essere stato aggiunto.
  const [campaign, setCampaign] = useState<{ id: string; name: string } | null>(null);
  const [memberIds, setMemberIds] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setUsers(await listUsers());
    } catch (err) {
      setLoadError(userErrorMessage(err));
      return;
    }
    // Il tavolo serve solo ad aggiungere i giocatori: se non si carica, l'elenco utenti resta usabile.
    try {
      const first = (await listMyCampaigns())[0];
      if (first) {
        setCampaign({ id: first.id, name: first.name });
        setMemberIds(new Set(await listMemberIds(first.id)));
      }
    } catch {
      setCampaign(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function changeRole(target: PublicUser, role: UserRole) {
    setActionError(null);
    try {
      const updated = await updateUserRole(target.id, role);
      setUsers((list) => list?.map((u) => (u.id === updated.id ? { ...u, role: updated.role } : u)) ?? list);
      toast.show({ title: `${target.name} ora è ${role === "admin" ? "admin" : "giocatore"}`, tone: "success" });
    } catch (err) {
      setActionError(userErrorMessage(err));
    }
  }

  async function toggleMember(target: PublicUser, join: boolean) {
    if (!campaign) return;
    setActionError(null);
    try {
      if (join) await addCampaignMember(campaign.id, target.id);
      else await removeCampaignMember(campaign.id, target.id);
      setMemberIds((ids) => {
        const next = new Set(ids);
        if (join) next.add(target.id);
        else next.delete(target.id);
        return next;
      });
      toast.show({ title: join ? `${target.name} è al tavolo` : `${target.name} non è più al tavolo`, tone: "success" });
    } catch (err) {
      setActionError(userErrorMessage(err));
    }
  }

  async function confirmDelete(target: PublicUser) {
    setActionError(null);
    try {
      await deleteUser(target.id);
      setUsers((list) => list?.filter((u) => u.id !== target.id) ?? list);
      toast.show({ title: `${target.name} eliminato`, tone: "success" });
    } catch (err) {
      setActionError(userErrorMessage(err));
    }
  }

  function menuFor(target: PublicUser): MenuItemSpec[] {
    const other: UserRole = target.role === "admin" ? "player" : "admin";
    return [
      {
        id: "role",
        label: other === "admin" ? "Rendi admin" : "Rendi giocatore",
        icon: other === "admin" ? <ShieldCheck size={18} /> : <UserRound size={18} />,
        onSelect: () => void changeRole(target, other)
      },
      ...(campaign && target.role === "player"
        ? [
            {
              id: "member",
              label: memberIds.has(target.id) ? "Togli dal tavolo" : "Aggiungi al tavolo",
              icon: memberIds.has(target.id) ? <UserMinus size={18} /> : <UserPlus size={18} />,
              onSelect: () => void toggleMember(target, !memberIds.has(target.id))
            }
          ]
        : []),
      { id: "password", label: "Reimposta password", icon: <KeyRound size={18} />, onSelect: () => setResetFor(target) },
      // Non ci si elimina da soli: eviterebbe di restare senza GM e chiude la propria sessione a meta' lavoro.
      { id: "delete", label: "Elimina", icon: <Trash2 size={18} />, destructive: true, disabled: target.id === me?.id, onSelect: () => setDeleteFor(target) }
    ];
  }

  return (
    <div className="a-page a-enter">
      <NavigationBar
        title="Utenti"
        leading={<IconButton label="Torna al tavolo" icon={<ChevronLeft size={22} />} onClick={() => navigate("/")} />}
        trailing={
          <Button size="sm" icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>
            Nuovo utente
          </Button>
        }
      />
      <main className="a-page__content" aria-label="Gestione utenti">
        <p className="t-subhead a-muted a-page__intro">
          Solo tu puoi creare gli account. Condividi email e password con i giocatori: potranno cambiarla dal loro menu.
          {campaign ? ` Un giocatore vede «${campaign.name}» solo dopo che lo aggiungi al tavolo, dal menu ⋯ accanto al suo nome.` : ""}
        </p>

        {actionError ? (
          <Banner tone="danger" onDismiss={() => setActionError(null)} className="a-gap">
            {actionError}
          </Banner>
        ) : null}

        {loadError ? (
          <div className="a-gap">
            <Banner tone="danger" title="Non riesco a caricare gli utenti">
              {loadError}
            </Banner>
            <Button variant="tinted" onClick={() => void load()}>
              Riprova
            </Button>
          </div>
        ) : users === null ? (
          <div className="a-center">
            <Spinner label="Caricamento utenti" />
          </div>
        ) : users.length === 0 ? (
          <EmptyState
            icon={<Users size={32} />}
            title="Nessun utente"
            description="Crea il primo account per invitare qualcuno al tavolo."
            action={
              <Button variant="tinted" onClick={() => setCreateOpen(true)}>
                Nuovo utente
              </Button>
            }
          />
        ) : (
          <List header={`${users.length} ${users.length === 1 ? "utente" : "utenti"}`}>
            {users.map((u) => (
              <ListRow
                key={u.id}
                leading={<Avatar name={u.name} />}
                title={u.id === me?.id ? `${u.name} (tu)` : u.name}
                subtitle={u.role === "player" && campaign && !memberIds.has(u.id) ? `${u.email} · non è al tavolo` : u.email}
                trailing={
                  <span className="a-row-actions">
                    <Badge tone={u.role === "admin" ? "tint" : "gray"}>{ROLE_LABEL[u.role]}</Badge>
                    <Menu label={`Azioni per ${u.name}`} placement="bottom-end" items={menuFor(u)} trigger={<IconButton label={`Azioni per ${u.name}`} icon={<Ellipsis size={20} />} />} />
                  </span>
                }
              />
            ))}
          </List>
        )}
      </main>

      <Sheet open={createOpen} onOpenChange={setCreateOpen} title="Nuovo utente">
        <CreateUserForm
          onCreated={(created) => {
            setUsers((list) => (list ? [...list, created] : [created]));
            toast.show({ title: "Utente creato", message: `${created.name} può accedere con la password che hai scelto.`, tone: "success" });
            setCreateOpen(false);
          }}
        />
      </Sheet>

      <Sheet open={resetFor !== null} onOpenChange={(o) => !o && setResetFor(null)} title="Reimposta password">
        {resetFor ? (
          <ResetPasswordForm
            target={resetFor}
            onDone={() => {
              toast.show({ title: "Password reimpostata", message: `Comunica la nuova password a ${resetFor.name}.`, tone: "success" });
              setResetFor(null);
            }}
          />
        ) : null}
      </Sheet>

      <Alert
        open={deleteFor !== null}
        onOpenChange={(o) => !o && setDeleteFor(null)}
        title={deleteFor ? `Eliminare ${deleteFor.name}?` : "Eliminare?"}
        message="L'account verrà rimosso e non potrà più accedere. L'azione non si può annullare."
        actions={[
          {
            label: "Elimina",
            role: "destructive",
            onPress: () => {
              const target = deleteFor;
              setDeleteFor(null);
              if (target) void confirmDelete(target);
            }
          },
          { label: "Annulla", role: "cancel" }
        ]}
      />
    </div>
  );
}

function CreateUserForm({ onCreated }: { onCreated: (user: PublicUser) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("player");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameError = submitted && name.trim() === "" ? "Inserisci un nome." : undefined;
  const emailError = submitted && !/^\S+@\S+\.\S+$/.test(email.trim()) ? "Inserisci un'email valida." : undefined;
  const passwordError = submitted ? (passwordProblem(password) ?? undefined) : undefined;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (busy || name.trim() === "" || !/^\S+@\S+\.\S+$/.test(email.trim()) || passwordProblem(password)) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createUser({ name: name.trim(), email: email.trim(), password, role }));
    } catch (err) {
      setError(userErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form className="a-form" onSubmit={onSubmit} noValidate>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <TextField label="Nome" name="name" autoComplete="off" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} error={nameError} autoFocus />
      <TextField
        label="Email"
        name="email"
        type="email"
        inputMode="email"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={emailError}
      />
      <SecureField
        label="Password"
        name="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        helper={PASSWORD_REQUIREMENT}
        error={passwordError}
      />
      <div className="a-field-group">
        <p className="l-field__label">Ruolo</p>
        <SegmentedControl aria-label="Ruolo" options={ROLE_OPTIONS} value={role} onValueChange={setRole} />
        <p className="t-footnote a-muted">{role === "admin" ? "L'admin è il GM: gestisce utenti e tavolo." : "Il giocatore muove solo il proprio token."}</p>
      </div>
      <Button type="submit" size="lg" fullWidth loading={busy}>
        Crea utente
      </Button>
    </form>
  );
}

function ResetPasswordForm({ target, onDone }: { target: PublicUser; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = submitted ? (passwordProblem(password) ?? undefined) : undefined;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (busy || passwordProblem(password)) return;
    setBusy(true);
    setError(null);
    try {
      await resetUserPassword(target.id, password);
      onDone();
    } catch (err) {
      setError(userErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form className="a-form" onSubmit={onSubmit} noValidate>
      <p className="t-subhead a-muted">
        Nuova password per {target.name} ({target.email}).
      </p>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <SecureField label="Nuova password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} helper={PASSWORD_REQUIREMENT} error={problem} autoFocus />
      <Button type="submit" size="lg" fullWidth loading={busy}>
        Reimposta password
      </Button>
    </form>
  );
}
