import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blankDoc, type FormTemplate, type SheetDoc } from "@lanterna/shared";
import { FormTab } from "./FormTab";
import { validate } from "./FormCalibrator";

// pdf.js non gira in jsdom: il test controlla cosa il tab passa alla pagina e come gestisce le modifiche.
const captured = vi.hoisted(() => ({ props: null as null | { onEdit?: (id: string, v: unknown) => void } }));
vi.mock("./PdfPages", () => ({
  PdfPages: (props: { onEdit?: (id: string, v: unknown) => void }) => {
    captured.props = props;
    return null;
  },
}));

const template: FormTemplate = {
  version: 1,
  name: "Scheda del GM",
  pages: 1,
  fields: [
    { id: "nome", page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.04, source: "name" },
    { id: "forza", page: 0, x: 0.1, y: 0.2, w: 0.1, h: 0.04, source: "str.score" },
  ],
};

afterEach(() => {
  cleanup();
  captured.props = null;
});

describe("scheda compilata sopra il PDF", () => {
  it("una modifica valida passa dalla scheda con il suo salvataggio", () => {
    const change = vi.fn();
    render(<FormTab campaignId="c1" doc={blankDoc("Aria")} template={template} canEdit change={change} />);
    captured.props!.onEdit!("nome", "Vela");
    expect(change).toHaveBeenCalledTimes(1);
    const next = change.mock.calls[0]![0]({ ...blankDoc("Aria") } as SheetDoc) as SheetDoc;
    expect(next.sheet.name).toBe("Vela");
  });

  it("un valore fuori limite non arriva alla scheda e viene segnalato", () => {
    const change = vi.fn();
    render(<FormTab campaignId="c1" doc={blankDoc("Aria")} template={template} canEdit change={change} />);
    act(() => captured.props!.onEdit!("forza", 99));
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("la pagina riceve i campi del template e può modificarli solo se il tab lo permette", () => {
    render(<FormTab campaignId="c1" doc={blankDoc("Aria")} template={template} canEdit={false} change={vi.fn()} />);
    expect(captured.props).toBeTruthy();
    expect((captured.props as { mode?: string }).mode).toBe("fill");
    expect((captured.props as { canEdit?: (f: unknown) => boolean }).canEdit!(template.fields[0])).toBe(false);
  });
});

describe("validazione della calibrazione", () => {
  it("accetta identificativi validi e unici", () => {
    expect(validate(template.fields)).toEqual([]);
  });

  it("segnala identificativi duplicati e non validi", () => {
    const bad = [
      { ...template.fields[0]!, id: "Nome Spazi" },
      { ...template.fields[0]!, id: "nome" },
      { ...template.fields[0]!, id: "nome" },
    ];
    const problems = validate(bad);
    expect(problems.some((p) => p.includes("non valido"))).toBe(true);
    expect(problems.some((p) => p.includes("duplicato"))).toBe(true);
  });
});
