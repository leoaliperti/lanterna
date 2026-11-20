import type { Role } from "./state/schema.js";

/** Tipi delle API REST di campagne e upload (server: packages/server/src/campaigns, uploads). */

export interface CampaignSummary {
  id: string;
  name: string;
  createdAt: string;
}

/** GET /campaigns (admin) e GET /campaigns/mine (utente autenticato). */
export interface ListCampaignsResponse {
  campaigns: CampaignSummary[];
}

/** POST /campaigns (admin). */
export interface CreateCampaignRequest {
  name: string;
}

export interface CampaignMemberInfo {
  userId: string;
  displayName: string;
  role: Role;
}

/** GET /campaigns/:id/members (admin). */
export interface ListMembersResponse {
  members: CampaignMemberInfo[];
}

/** POST /campaigns/:id/members (admin). */
export interface AddMemberRequest {
  userId: string;
}

export type UploadKind = "map" | "token";

/** POST /uploads/map, POST /uploads/token (admin, multipart con un solo campo file). */
export interface UploadResponse {
  assetId: string;
  /** Percorso relativo all'API (in sviluppo il client lo prefissa con `/api`). */
  url: string;
  kind: UploadKind;
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  bytes: number;
}
