import { describe, expect, it } from "vitest";
import { CommandSchema, type TokenView } from "@lanterna/shared";
import { emptyEffectDraft, effectInput, hasEffectErrors, validateEffectDraft, describeDuration } from "./effectsLogic";
import {
  ALL_TOKENS,
  actionForKey,
  applyCommand,
  createGroupCommand,
  describeAction,
  factionsOf,
  filterTokens,
  groupAction,
  parseAmount,
  parseCells,
  recallGroup,
  replaceGroupTokensCommand,
  selectByCategory,
  toggleId,
  type ActionDraft
} from "./selectionLogic";

const t = (id: string, kind: TokenView["kind"], over: Partial<TokenView> = {}): TokenView =>
  ({ id, sceneId: "s1", name: id, kind, faction: null, ...over }) as TokenView;

const tokens = [
  t("aldo", "pc", { name: "Aldo", faction: "Eroi" }),
  t("bea", "pc", { name: "Bea", faction: "Eroi" }),
  t("gob1", "monster", { name: "Goblin Rosso", faction: "Orda" }),
  t("gob2", "monster", { name: "Goblin Blu", faction: "Orda", hidden: true }),
  t("orco", "monster", { name: "Orco", faction: "Banda" }),
  t("baule", "object", { name: "Baule" }),
  t("altro", "monster", { sceneId: "s2", faction: "Orda" })
];

const draft = (over: Partial<ActionDraft> = {}): ActionDraft => ({
  kind: "damage",
  amount: "7",
  critical: false,
  conditionId: "prone",
  removeCondition: false,
  effect: emptyEffectDraft(),
  dx: "2",
  dy: "0",
  ...over
});

describe("selezione per categoria", () => {
  it("solo PG, solo mostri, per fazione, sempre nella scena", () => {
    expect(selectByCategory(tokens, "s1", { kind: "pc", faction: null }).map((x) => x.id)).toEqual(["aldo", "bea"]);
    expect(selectByCategory(tokens, "s1", { kind: "monster", faction: null }).map((x) => x.id)).toEqual(["gob1", "gob2", "orco"]);
    expect(selectByCategory(tokens, "s1", { kind: "all", faction: "Orda" }).map((x) => x.id)).toEqual(["gob1", "gob2"]);
    expect(selectByCategory(tokens, "s1", { kind: "pc", faction: "Orda" })).toEqual([]);
    expect(selectByCategory(tokens, "s1", ALL_TOKENS)).toHaveLength(6);
  });

  it("elenca le fazioni e cerca senza accenti e maiuscole", () => {
    expect(factionsOf(tokens, "s1")).toEqual(["Banda", "Eroi", "Orda"]);
    expect(filterTokens(tokens, "GOBLIN").map((x) => x.id)).toEqual(["gob1", "gob2"]);
    expect(filterTokens(tokens, "orda").map((x) => x.id)).toEqual(["gob1", "gob2", "altro"]);
    expect(filterTokens(tokens, "mostro").length).toBe(4);
    expect(filterTokens(tokens, "  ")).toHaveLength(tokens.length);
    expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("gruppi", () => {
  it("crea, aggiorna e richiama (solo token ancora nella scena)", () => {
    const cmd = createGroupCommand("g1", " Nemici ", ["gob1", "gob1", "orco"]);
    expect(cmd).toEqual({ type: "group.create", group: { id: "g1", name: "Nemici", tokenIds: ["gob1", "orco"] } });
    expect(CommandSchema.safeParse(cmd).success).toBe(true);
    expect(createGroupCommand("g1", "  ", ["a"])).toBeNull();
    expect(createGroupCommand("g1", "x", [])).toBeNull();
    expect(replaceGroupTokensCommand("g1", [])).toBeNull();
    expect(recallGroup({ id: "g1", name: "N", tokenIds: ["gob1", "cancellato", "altro"] }, tokens, "s1")).toEqual(["gob1"]);
  });
});

describe("azioni rapide", () => {
  it("mappa le scorciatoie", () => {
    expect(actionForKey("x")).toBe("damage");
    expect(actionForKey("H")).toBe("heal");
    expect(actionForKey("k")).toBe("condition");
    expect(actionForKey("e")).toBe("effect");
    expect(actionForKey("m")).toBeNull();
    expect(actionForKey("d")).toBeNull();
  });

  it("produce un solo group.apply valido per ogni azione", () => {
    const eff = { ...emptyEffectDraft(), name: "Benedizione", conditionId: "invisible", duration: "3" };
    const cases: Array<[ActionDraft, string]> = [
      [draft(), "damage"],
      [draft({ kind: "damage", critical: true }), "damage"],
      [draft({ kind: "heal", amount: "4" }), "heal"],
      [draft({ kind: "tempHp", amount: "5" }), "tempHp"],
      [draft({ kind: "condition" }), "addCondition"],
      [draft({ kind: "condition", removeCondition: true }), "removeCondition"],
      [draft({ kind: "effect", effect: eff }), "addEffect"],
      [draft({ kind: "move", dx: "-1,5", dy: "2" }), "move"]
    ];
    for (const [d, kind] of cases) {
      const action = groupAction(d, "eff-1", 70);
      expect(action?.kind, d.kind).toBe(kind);
      const cmd = applyCommand(["gob1", "gob2"], action!);
      expect(CommandSchema.safeParse(cmd).success, d.kind).toBe(true);
      expect(cmd).toMatchObject({ type: "group.apply", target: { kind: "tokens", tokenIds: ["gob1", "gob2"] } });
    }
    expect(groupAction(draft({ kind: "move", dx: "2", dy: "-1" }), "e", 70)).toEqual({ kind: "move", dx: 140, dy: -70 });
  });

  it("rifiuta valori non validi", () => {
    expect(groupAction(draft({ amount: "" }), "e", 70)).toBeNull();
    expect(groupAction(draft({ amount: "-3" }), "e", 70)).toBeNull();
    expect(groupAction(draft({ amount: "9999999" }), "e", 70)).toBeNull();
    expect(groupAction(draft({ kind: "move", dx: "0", dy: "0" }), "e", 70)).toBeNull();
    expect(groupAction(draft({ kind: "move", dx: "x" }), "e", 70)).toBeNull();
    expect(groupAction(draft({ kind: "effect" }), "e", 70)).toBeNull();
    expect(parseAmount("12")).toBe(12);
    expect(parseCells("")).toBe(0);
    expect(parseCells("999")).toBeNull();
  });

  it("descrive l'azione per la conferma", () => {
    expect(describeAction(draft(), 3)).toBe("Danno 7 a 3 token");
    expect(describeAction(draft({ critical: true }), 1)).toBe("Danno 7 (critico) a 1 token");
    expect(describeAction(draft({ kind: "condition" }), 2)).toBe("Prono su 2 token");
    expect(describeAction(draft({ kind: "condition", removeCondition: true }), 2)).toBe("Prono tolta a 2 token");
  });
});

describe("effetti", () => {
  it("valida nome e durata", () => {
    expect(hasEffectErrors(validateEffectDraft({ ...emptyEffectDraft(), name: "Fiamma" }))).toBe(false);
    expect(validateEffectDraft({ ...emptyEffectDraft(), name: "" }).name).toBeTruthy();
    expect(validateEffectDraft({ ...emptyEffectDraft(), name: "x", duration: "0" }).duration).toBeTruthy();
    expect(validateEffectDraft({ ...emptyEffectDraft(), name: "x", duration: "2,5" }).duration).toBeTruthy();
    expect(validateEffectDraft({ ...emptyEffectDraft(), name: "x", duration: "" }).duration).toBeNull();
  });

  it("costruisce l'effetto con condizione, ancora e durata", () => {
    const input = effectInput("e1", { name: " Bruciatura ", conditionId: "poisoned", duration: "3", timing: "start", anchorTokenId: "mago", secret: true });
    expect(input).toEqual({
      id: "e1",
      name: "Bruciatura",
      condition: { id: "poisoned", name: "Avvelenato" },
      remaining: 3,
      timing: "start",
      turnOf: "mago",
      secret: true
    });
    expect(effectInput("e2", { ...emptyEffectDraft(), name: "Aura", duration: "" }).remaining).toBeNull();
    expect(describeDuration({ remaining: 3, timing: "start" })).toBe("3 round, a inizio turno");
    expect(describeDuration({ remaining: null, timing: "end" })).toBe("senza scadenza");
  });
});
