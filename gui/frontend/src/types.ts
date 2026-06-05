// Mirrors gui/backend/app/models.py. Keep the two layers in sync — same contract.

export interface NodeIdentity {
  name: string;
  role: string; // "spoke" | "relay"
  wg_interface: string;
}

export interface SharedFile {
  name: string; // path/filename within the share root
  size: number; // bytes
  node: string; // contributing node (the share is island-wide)
  modified: string; // ISO 8601
}

export interface FilesSnapshot {
  root: string; // share root path
  bind: string; // where the file service listens, e.g. "wg0:21"
  files: SharedFile[];
}

export type IdsSource = "usb" | "login" | "auth" | "reboot";
export type IdsSeverity = "info" | "warn" | "crit";

export interface IdsEvent {
  id: string;
  at: string; // ISO 8601
  source: IdsSource;
  severity: IdsSeverity;
  subject: string;
  message: string;
}
