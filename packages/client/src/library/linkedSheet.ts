import { monsterDocFromContent, type LibraryItem } from "@lanterna/shared";
import { createSheet, getLibraryDoc } from "../sheets/sheetsApi";

/**
 * Se l'elemento della libreria ha una scheda collegata (un mostro importato), crea la scheda per il token
 * appena messo in scena e la lega a quel token. Senza collegamento non fa nulla.
 * Il server rivalida tutto: il token deve esistere e la scheda è un mostro; un errore arriva al chiamante.
 */
export async function createLinkedSheet(campaignId: string, item: LibraryItem, tokenId: string): Promise<void> {
  if (!item.contentId) return;
  const doc = await getLibraryDoc(item.contentId);
  await createSheet(campaignId, { kind: "monster", doc: monsterDocFromContent(doc.name, doc.data, doc.id), tokenId });
}
