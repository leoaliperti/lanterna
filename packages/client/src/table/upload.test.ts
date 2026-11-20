import { describe, expect, it } from "vitest";
import { ApiRequestError, uploadErrorMessage } from "../api/client";
import { MAX_UPLOAD_BYTES, validateImageFile } from "./upload";

describe("validazione dei file prima del caricamento", () => {
  it("accetta PNG, JPEG e WebP", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      expect(validateImageFile({ type, size: 1000, name: "a" }).ok).toBe(true);
    }
  });

  it("rifiuta SVG, GIF e file vuoti o troppo grandi, con messaggi chiari", () => {
    expect(validateImageFile({ type: "image/svg+xml", size: 10, name: "a.svg" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("PNG, JPEG o WebP")
    });
    expect(validateImageFile({ type: "image/gif", size: 10, name: "a.gif" }).ok).toBe(false);
    expect(validateImageFile({ type: "image/png", size: 0, name: "a.png" }).ok).toBe(false);
    expect(validateImageFile({ type: "image/png", size: MAX_UPLOAD_BYTES + 1, name: "a.png" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("pesa troppo")
    });
  });

  it("traduce gli errori del server", () => {
    expect(uploadErrorMessage(new ApiRequestError(413, "x"))).toContain("troppo grande");
    expect(uploadErrorMessage(new ApiRequestError(415, "x"))).toContain("PNG, JPEG o WebP");
    expect(uploadErrorMessage(new ApiRequestError(403, "x"))).toContain("GM");
    expect(uploadErrorMessage(new ApiRequestError(0, "Impossibile raggiungere il server."))).toContain("Impossibile");
  });
});
