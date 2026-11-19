import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Alert,
  Avatar,
  Button,
  ContextMenu,
  IconButton,
  List,
  ListRow,
  Menu,
  NavigationBar,
  Picker,
  Popover,
  ProgressView,
  SearchField,
  SecureField,
  SegmentedControl,
  Sheet,
  Sidebar,
  Slider,
  Spinner,
  Stepper,
  Tabs,
  TextField,
  ToastProvider,
  Toggle,
  Toolbar,
  Tooltip,
  useToast
} from "./index";
import { initials } from "./Display";
import { rubberband } from "./Sheet";

function mockMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => mockMotion(false));
afterEach(() => cleanup());

function SheetHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Apri</button>
      <Sheet open={open} onOpenChange={setOpen} title="Impostazioni">
        <input aria-label="primo" />
        <button>Salva</button>
      </Sheet>
    </>
  );
}

describe("Sheet", () => {
  it("si apre come dialog modale con nome accessibile e sposta il focus dentro", async () => {
    const user = userEvent.setup();
    render(<SheetHarness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByText("Apri"));
    const dialog = await screen.findByRole("dialog", { name: "Impostazioni" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it("Esc chiude e il focus torna al pulsante che l'ha aperto", async () => {
    const user = userEvent.setup();
    render(<SheetHarness />);
    const opener = screen.getByText("Apri");
    await user.click(opener);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 1500 });
    expect(document.activeElement).toBe(opener);
  });

  it("il focus non esce dal dialog con Tab e Shift+Tab", async () => {
    const user = userEvent.setup();
    render(<SheetHarness />);
    await user.click(screen.getByText("Apri"));
    const dialog = await screen.findByRole("dialog");
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("clic sullo sfondo chiude", async () => {
    const user = userEvent.setup();
    render(<SheetHarness />);
    await user.click(screen.getByText("Apri"));
    await screen.findByRole("dialog");
    const scrim = document.querySelector(".l-scrim") as HTMLElement;
    await user.click(scrim);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 1500 });
  });

  it("con movimento ridotto si smonta subito, senza attendere l'animazione di uscita", async () => {
    mockMotion(true);
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <Sheet open onOpenChange={onOpenChange} title="Ridotto">
        <p>x</p>
      </Sheet>
    );
    await screen.findByRole("dialog");
    rerender(
      <Sheet open={false} onOpenChange={onOpenChange} title="Ridotto">
        <p>x</p>
      </Sheet>
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("senza movimento ridotto resta montato (data-state=closed) durante l'uscita", async () => {
    const { rerender } = render(
      <Sheet open onOpenChange={() => undefined} title="Normale">
        <p>x</p>
      </Sheet>
    );
    await screen.findByRole("dialog");
    rerender(
      <Sheet open={false} onOpenChange={() => undefined} title="Normale">
        <p>x</p>
      </Sheet>
    );
    expect(screen.getByRole("dialog").getAttribute("data-state")).toBe("closed");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 1500 });
  });

  it("trascinare la maniglia oltre la soglia chiude", async () => {
    Element.prototype.setPointerCapture = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <Sheet open onOpenChange={onOpenChange} title="Drag">
        <p>x</p>
      </Sheet>
    );
    await screen.findByRole("dialog");
    const grab = screen.getByTestId("sheet-grab");
    // offsetHeight e' 0 in jsdom: qualsiasi spostamento positivo supera il 50%
    fireEvent.pointerDown(grab, { pointerId: 1, clientY: 100, pointerType: "touch" });
    fireEvent.pointerMove(grab, { pointerId: 1, clientY: 200 });
    fireEvent.pointerUp(grab, { pointerId: 1, clientY: 200 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("rubberband: resistenza progressiva", () => {
    expect(Math.abs(rubberband(-100))).toBeLessThan(100);
    expect(Math.abs(rubberband(-400))).toBeLessThan(Math.abs(rubberband(-100)) * 4);
  });
});

describe("SegmentedControl", () => {
  const opts = [
    { value: "a", label: "Uno" },
    { value: "b", label: "Due" },
    { value: "c", label: "Tre" }
  ];

  it("espone radiogroup/radio e naviga con le frecce (roving tabindex)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SegmentedControl aria-label="Vista" options={opts} defaultValue="a" onValueChange={onChange} />);
    expect(screen.getByRole("radiogroup", { name: "Vista" })).toBeTruthy();
    const [uno, due, tre] = screen.getAllByRole("radio");
    expect(uno!.getAttribute("aria-checked")).toBe("true");
    expect(uno!.tabIndex).toBe(0);
    expect(due!.tabIndex).toBe(-1);
    uno!.focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("b");
    expect(document.activeElement).toBe(due);
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(document.activeElement).toBe(uno); // cicla
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(tre);
    expect(tre!.getAttribute("aria-checked")).toBe("true");
    await user.keyboard("{Home}");
    expect(uno!.getAttribute("aria-checked")).toBe("true");
  });

  it("salta le opzioni disabilitate", async () => {
    const user = userEvent.setup();
    render(<SegmentedControl aria-label="V" options={[opts[0]!, { ...opts[1]!, disabled: true }, opts[2]!]} defaultValue="a" />);
    screen.getAllByRole("radio")[0]!.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getAllByRole("radio")[2]!.getAttribute("aria-checked")).toBe("true");
  });
});

describe("Toggle", () => {
  it("e' un switch che si attiva con Spazio e Invio", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle label="Griglia" onCheckedChange={onChange} />);
    const sw = screen.getByRole("switch", { name: "Griglia" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    sw.focus();
    await user.keyboard(" ");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await user.keyboard("{Enter}");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("disabilitato non cambia", async () => {
    const user = userEvent.setup();
    render(<Toggle label="X" disabled />);
    await user.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });
});

describe("Pulsanti e campi", () => {
  it("Button applica variante, dimensione e loading (disabilita e aria-busy)", () => {
    const { rerender } = render(<Button variant="tinted" size="lg">Ok</Button>);
    const b = screen.getByRole("button", { name: "Ok" });
    expect(b.className).toContain("l-btn--tinted");
    expect(b.className).toContain("l-btn--lg");
    rerender(<Button loading>Ok</Button>);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button").getAttribute("aria-busy")).toBe("true");
  });

  it("IconButton usa label come nome accessibile", () => {
    render(<IconButton label="Chiudi" icon={<span>x</span>} />);
    expect(screen.getByRole("button", { name: "Chiudi" })).toBeTruthy();
  });

  it("TextField collega label, aiuto ed errore", () => {
    render(<TextField label="Email" error="Non valida" />);
    const input = screen.getByLabelText("Email");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("Non valida");
    expect(input.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
  });

  it("SecureField mostra e nasconde la password", async () => {
    const user = userEvent.setup();
    render(<SecureField label="Password" />);
    const input = screen.getByLabelText("Password") as HTMLInputElement;
    expect(input.type).toBe("password");
    await user.click(screen.getByRole("button", { name: "Mostra password" }));
    expect(input.type).toBe("text");
    expect(screen.getByRole("button", { name: "Nascondi password" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("SearchField: role search, cancella con il pulsante e con Esc", async () => {
    const user = userEvent.setup();
    render(<SearchField />);
    expect(screen.getByRole("search")).toBeTruthy();
    const input = screen.getByRole("searchbox") as HTMLInputElement;
    await user.type(input, "goblin");
    expect(input.value).toBe("goblin");
    await user.click(screen.getByRole("button", { name: "Cancella testo" }));
    expect(input.value).toBe("");
    await user.type(input, "orco{Escape}");
    expect(input.value).toBe("");
  });

  it("Slider e' un range con nome accessibile", () => {
    render(<Slider aria-label="Volume" defaultValue={30} />);
    const s = screen.getByRole("slider", { name: "Volume" }) as HTMLInputElement;
    expect(s.value).toBe("30");
    fireEvent.change(s, { target: { value: "55" } });
    expect(s.value).toBe("55");
  });

  it("Stepper rispetta min e max", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Stepper label="giocatori" defaultValue={2} min={1} max={3} onValueChange={onChange} />);
    expect(screen.getByRole("group", { name: "giocatori" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Aumenta giocatori" }));
    expect(onChange).toHaveBeenLastCalledWith(3);
    expect((screen.getByRole("button", { name: "Aumenta giocatori" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Diminuisci giocatori" }));
    expect(onChange).toHaveBeenLastCalledWith(2);
  });
});

describe("Menu, Picker, Popover, ContextMenu", () => {
  it("Menu: ruoli, frecce, selezione, chiusura con Esc e focus restituito", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <Menu
        label="Azioni"
        trigger={<Button>Apri menu</Button>}
        items={[{ id: "a", label: "Uno" }, { id: "b", label: "Due", onSelect }]}
      />
    );
    const trigger = screen.getByRole("button", { name: "Apri menu" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu", { name: "Azioni" })).toBeTruthy();
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[1]);
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull(), { timeout: 1500 });
    await user.click(trigger);
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger);
  });

  it("Picker: voci radio con quella corrente selezionata", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Picker label="Unita" defaultValue="m" onValueChange={onChange} options={[{ value: "ft", label: "Piedi" }, { value: "m", label: "Metri" }]} />);
    await user.click(screen.getByRole("button", { name: /Unita/ }));
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
    await user.click(radios[0]!);
    expect(onChange).toHaveBeenCalledWith("ft");
  });

  it("Popover: si apre dal trigger, Esc e clic fuori chiudono", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Popover label="Info" trigger={<Button>Info</Button>}>
          <p>Contenuto</p>
        </Popover>
        <p>fuori</p>
      </div>
    );
    await user.click(screen.getByRole("button", { name: "Info" }));
    expect(screen.getByRole("dialog", { name: "Info" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 1500 });
    await user.click(screen.getByRole("button", { name: "Info" }));
    await screen.findByRole("dialog");
    await user.click(screen.getByText("fuori"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 1500 });
  });

  it("ContextMenu si apre con il tasto destro", async () => {
    render(
      <ContextMenu label="Token" items={[{ id: "x", label: "Elimina", destructive: true }]}>
        <div>area</div>
      </ContextMenu>
    );
    fireEvent.contextMenu(screen.getByText("area"), { clientX: 20, clientY: 20 });
    expect(await screen.findByRole("menu", { name: "Token" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Elimina" })).toBeTruthy();
  });
});

describe("Alert", () => {
  it("e' un alertdialog, focus sull'azione sicura, Esc chiude", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onDelete = vi.fn();
    render(
      <Alert
        open
        onOpenChange={onOpenChange}
        title="Eliminare?"
        message="Non si puo' annullare."
        actions={[{ label: "Elimina", role: "destructive", onPress: onDelete }, { label: "Annulla", role: "cancel" }]}
      />
    );
    const dlg = await screen.findByRole("alertdialog", { name: "Eliminare?" });
    expect(dlg.getAttribute("aria-describedby")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Annulla" })));
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await user.click(screen.getByRole("button", { name: "Elimina" }));
    expect(onDelete).toHaveBeenCalled();
  });
});

describe("Toast, Tooltip", () => {
  function T() {
    const t = useToast();
    return <button onClick={() => t.show({ title: "Fatto", duration: 0 })}>vai</button>;
  }
  it("Toast compare in una regione live e si chiude", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <T />
      </ToastProvider>
    );
    await user.click(screen.getByText("vai"));
    const region = screen.getByRole("region", { name: "Notifiche" });
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("status").textContent).toContain("Fatto");
    await user.click(screen.getByRole("button", { name: "Chiudi notifica" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Tooltip compare al focus con aria-describedby e Esc lo nasconde", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Lancia">
        <button>Dado</button>
      </Tooltip>
    );
    await user.tab();
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toBe("Lancia");
    expect(screen.getByRole("button", { name: "Dado" }).parentElement!.getAttribute("aria-describedby")).toBe(tip.id);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("Layout e navigazione", () => {
  it("Tabs: tablist/tab/tabpanel e frecce", async () => {
    const user = userEvent.setup();
    render(
      <Tabs
        aria-label="Sezioni"
        tabs={[
          { id: "a", label: "A", content: <p>contenuto A</p> },
          { id: "b", label: "B", content: <p>contenuto B</p> }
        ]}
      />
    );
    expect(screen.getByRole("tablist", { name: "Sezioni" })).toBeTruthy();
    const [a, b] = screen.getAllByRole("tab");
    expect(a!.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(a!.id);
    a!.focus();
    await user.keyboard("{ArrowRight}");
    expect(b!.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("contenuto B")).toBeTruthy();
  });

  it("Sidebar: nav con aria-current sulla voce selezionata", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Sidebar aria-label="Libreria" selected="a" onSelect={onSelect} sections={[{ title: "Sez", items: [{ id: "a", label: "Mappe" }, { id: "b", label: "Token" }] }]} />);
    expect(screen.getByRole("navigation", { name: "Libreria" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mappe" }).getAttribute("aria-current")).toBe("page");
    await user.click(screen.getByRole("button", { name: "Token" }));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("Toolbar: role toolbar con frecce tra i controlli", async () => {
    const user = userEvent.setup();
    render(
      <Toolbar aria-label="Strumenti">
        <button>Uno</button>
        <button>Due</button>
      </Toolbar>
    );
    expect(screen.getByRole("toolbar", { name: "Strumenti" })).toBeTruthy();
    screen.getByText("Uno").focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByText("Due"));
  });

  it("NavigationBar: il titolo grande e' un h1 e lo stato compresso e' controllabile", () => {
    const { rerender } = render(<NavigationBar title="Mappe" collapsed={false} />);
    expect(screen.getByRole("heading", { level: 1, name: "Mappe" })).toBeTruthy();
    expect(screen.getByRole("banner").getAttribute("data-collapsed")).toBe("false");
    rerender(<NavigationBar title="Mappe" collapsed />);
    expect(screen.getByRole("banner").getAttribute("data-collapsed")).toBe("true");
  });

  it("List: righe interattive sono pulsanti, altre no", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(
      <List header="Sessione">
        <ListRow title="Mappa" onPress={onPress} chevron />
        <ListRow title="Chat" trailing="On" />
      </List>
    );
    expect(screen.getByRole("list", { name: "Sessione" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Mappa" }));
    expect(onPress).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
  });
});

describe("Display", () => {
  it("Avatar espone il nome e calcola le iniziali", () => {
    render(<Avatar name="Aldric Vento" />);
    expect(screen.getByRole("img", { name: "Aldric Vento" }).textContent).toBe("AV");
    expect(initials("  brenna ")).toBe("B");
    expect(initials("")).toBe("?");
  });

  it("Spinner e ProgressView hanno semantica corretta", () => {
    render(
      <>
        <Spinner />
        <ProgressView label="Carica" value={0.25} />
        <ProgressView label="Attesa" />
      </>
    );
    expect(screen.getByRole("status", { name: "Caricamento" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Carica" }).getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByRole("progressbar", { name: "Attesa" }).hasAttribute("aria-valuenow")).toBe(false);
  });
});
