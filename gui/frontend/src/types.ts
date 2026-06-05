// Mirrors gui/backend/app/models.py, which mirrors the daemon's Go structs.
// Keep these three in sync — they are the same contract at three layers.

export type PeerState = "ok" | "stale" | "degraded";

export interface PeerStatus {
  peer: string; // WireGuard public key
  name: string;
  state: PeerState;
  last_handshake: string | null; // ISO 8601, null == never
  endpoint: string | null;
}

export interface NodeIdentity {
  name: string;
  role: string; // "spoke" | "relay"
  public_key: string;
  wg_interface: string;
}

export interface MeshSnapshot {
  node: NodeIdentity;
  peers: PeerStatus[];
  generated_at: string;
}

export type IdsSource = "mesh" | "usb" | "login" | "reboot";
export type IdsSeverity = "info" | "warn" | "crit";

export interface IdsEvent {
  id: string;
  at: string; // ISO 8601
  source: IdsSource;
  severity: IdsSeverity;
  subject: string;
  message: string;
}
