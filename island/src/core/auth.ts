// Request authentication for the management plane — pure, testable logic.
//
// The daemon binds wg0, so any mesh peer can reach it. Two roles gate the sensitive
// endpoints: the OPERATOR (manages this node — friends, home, messages) and the ADMIN
// (the /admin surface). Both authenticate by a token compared in constant time, with
// loopback and --mock as convenience shortcuts for the local/demo operator.

import { createHash, timingSafeEqual } from "node:crypto";

export const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Constant-time token compare. Empty presented/expected never matches. */
export function tokenOk(presented: string, expected: string): boolean {
  if (!expected || !presented) return false;
  return timingSafeEqual(sha256(presented), sha256(expected));
}

/**
 * Is the caller the node's operator? True for --mock, loopback (operator on the host),
 * or a valid op-token. The op-token is what lets a HEADLESS node be managed remotely
 * over the mesh (or by the CLI) — without it, only loopback/mock count.
 */
export function operatorOk(
  ip: string,
  presentedOpToken: string,
  cfg: { mock: boolean; opToken: string },
): boolean {
  if (cfg.mock) return true;
  if (LOOPBACK.has(ip)) return true;
  return tokenOk(presentedOpToken, cfg.opToken);
}

/**
 * The full operator check used by management endpoints: operator OR admin. The admin
 * token is a SUPERSET of operator, so the one admin credential unlocks both operator
 * actions and the /admin surface (one key per node — see the lock control in the UI).
 */
export function manageOk(
  ip: string,
  opTokenHeader: string,
  adminTokenHeader: string,
  cfg: { mock: boolean; opToken: string; adminToken: string },
): boolean {
  if (operatorOk(ip, opTokenHeader, cfg)) return true;
  return !!cfg.adminToken && tokenOk(adminTokenHeader, cfg.adminToken);
}
