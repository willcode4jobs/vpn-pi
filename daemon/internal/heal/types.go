// Package heal contains the pure decision core of the WireGuard self-heal
// daemon: given a snapshot of peer state, the node's role, and a log of recent
// remediation actions, it decides what (if anything) to do next.
//
// Everything here is deliberately free of side effects and of any dependency on
// a live WireGuard interface. That keeps the heart of the daemon unit-testable
// against synthetic peers on the build machine — no netlink, no root, no
// hardware. The read path produces PeerState; the act path consumes Action;
// this package only maps one to the other.
package heal

import "time"

// Role describes a node's position in the mesh, which gates how aggressively
// the daemon is allowed to remediate.
type Role int

const (
	// RoleSpoke is a leaf node. It may re-resolve a peer's endpoint and, as a
	// last resort, bounce its own interface.
	RoleSpoke Role = iota
	// RoleRelay is a hub/bastion (e.g. vega). Bouncing its interface would
	// sever every peer at once and re-run mesh.nft, so the daemon never does
	// that autonomously — it re-resolves per peer and otherwise alerts.
	RoleRelay
)

func (r Role) String() string {
	switch r {
	case RoleSpoke:
		return "spoke"
	case RoleRelay:
		return "relay"
	default:
		return "unknown"
	}
}

// PeerState is a read-only snapshot of one WireGuard peer, as produced by the
// netlink read path. The decision core consumes these; it never produces them.
type PeerState struct {
	// PublicKey is the peer's WireGuard public key — its stable identity, and
	// the key used internally for remediation history and the endpoint cache.
	PublicKey string
	// Name is an optional human label (e.g. "sirius"), for logging only.
	Name string
	// TunnelIP is the peer's mesh/wg0 address (its host AllowedIP, e.g.
	// "10.42.0.5"), used as a readable identifier in logs and the IDS feed in
	// preference to the opaque public key. Empty if the peer has no AllowedIPs.
	TunnelIP string
	// LastHandshake is the time of the most recent successful handshake. The
	// zero value means the peer has never handshaked.
	LastHandshake time.Time
	// Endpoint is the peer's currently configured endpoint, if any.
	Endpoint string
}

// maxStaleness represents an unbounded staleness, used for peers that have
// never handshaked so they always read as stale without overflowing arithmetic.
const maxStaleness = time.Duration(1<<63 - 1)

// staleness returns how long it has been since the peer last handshook,
// measured from now. A peer that has never handshaked is treated as infinitely
// stale.
func (p PeerState) staleness(now time.Time) time.Duration {
	if p.LastHandshake.IsZero() {
		return maxStaleness
	}
	return now.Sub(p.LastHandshake)
}

// stalenessLabel renders staleness for human-readable reasons, avoiding the
// overflow that Round would hit on the never-handshaked sentinel.
func (p PeerState) stalenessLabel(now time.Time) string {
	if p.LastHandshake.IsZero() {
		return "never handshaked"
	}
	return p.staleness(now).Round(time.Second).String()
}

// ActionKind is the type of remediation the decision core has chosen.
type ActionKind int

const (
	// ActionReResolve re-resolves the peer's endpoint (DNS) and pushes it back
	// onto the tunnel via `wg set <if> peer <pub> endpoint <ip:port>`. Safe on
	// every role; touches a single peer only.
	ActionReResolve ActionKind = iota
	// ActionBounceInterface tears the interface down and back up — a blunt,
	// last-resort instrument permitted only on spokes. On a relay it would
	// sever the whole mesh, so the ladder never reaches it there.
	ActionBounceInterface
	// ActionAlert surfaces a degraded peer without touching the tunnel. It is
	// emitted once remediation is exhausted, latching degraded to stop flapping.
	ActionAlert
)

func (k ActionKind) String() string {
	switch k {
	case ActionReResolve:
		return "re-resolve"
	case ActionBounceInterface:
		return "bounce-interface"
	case ActionAlert:
		return "alert"
	default:
		return "unknown"
	}
}

// Action is a single remediation decision targeting a single peer.
type Action struct {
	Kind   ActionKind
	Peer   string // public key of the peer the action targets (the internal key)
	Name   string // optional human label, copied from PeerState
	IP     string // peer's tunnel address, copied from PeerState — for logging
	Reason string // human-readable justification, for logging
}

// ActionRecord is one past remediation, used by the circuit breaker to avoid
// flapping. The act path appends one after it executes an Action.
type ActionRecord struct {
	Peer string
	Kind ActionKind
	At   time.Time
}

// Config holds the decision core's tunables. Two threshold groups live here and
// are deliberately independent:
//   - the time-tiered HEALTH classification (StaleAfter/DegradedAfter/RestoredHold),
//     which drives the IDS feed and is intentionally aggressive; and
//   - the REMEDIATION trigger (Staleness) + circuit breaker (Window/MaxReResolve/
//     MaxBounce), kept conservative so idle-but-healthy peers aren't re-resolved on
//     every handshake gap. A peer can read "degraded" in the feed while remediation
//     still holds off until Staleness — that decoupling is by design.
type Config struct {
	// StaleAfter: handshake age ≥ this classifies a peer as stale. NB: WireGuard
	// re-handshakes only ~every 120s even on healthy links, so a low value (30s)
	// makes healthy peers cycle through stale/degraded between handshakes — an
	// accepted, intentional trade for fast visibility, not remediation.
	StaleAfter time.Duration
	// DegradedAfter: handshake age ≥ this classifies a peer as degraded. A
	// never-handshaked peer is infinitely stale, so it reads degraded.
	DegradedAfter time.Duration
	// RestoredHold: after a stale/degraded peer returns to healthy it is marked
	// "restored"; it only reaches ok after staying healthy this long (a recovery
	// debounce). Slipping back past StaleAfter during the hold drops it back.
	RestoredHold time.Duration

	// Staleness is how long a peer may go without a handshake before REMEDIATION
	// kicks in. Keep it comfortably above the ~2 min keepalive renewal (150–180s)
	// or healthy peers get needlessly re-resolved. This does NOT gate the health
	// classification above — only the act path.
	Staleness time.Duration
	// Window is the circuit-breaker lookback: how far back recent actions are
	// counted when deciding whether to keep trying.
	Window time.Duration
	// MaxReResolve is how many re-resolve attempts are allowed per peer within
	// Window before escalating (spoke) or latching degraded (relay).
	MaxReResolve int
	// MaxBounce is how many interface bounces a spoke may attempt per peer
	// within Window before latching degraded. Ignored on relays (never bounce).
	MaxBounce int
}

// DefaultConfig returns the classification ladder (30s stale / 60s degraded /
// 30s restored-hold) plus conservative, flap-resistant remediation defaults.
func DefaultConfig() Config {
	return Config{
		StaleAfter:    30 * time.Second,
		DegradedAfter: 60 * time.Second,
		RestoredHold:  30 * time.Second,
		Staleness:     180 * time.Second,
		Window:        10 * time.Minute,
		MaxReResolve:  3,
		MaxBounce:     1,
	}
}
