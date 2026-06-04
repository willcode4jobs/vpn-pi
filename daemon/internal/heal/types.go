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
	// PublicKey is the peer's WireGuard public key — its stable identity.
	PublicKey string
	// Name is an optional human label (e.g. "sirius"), for logging only.
	Name string
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
	Peer   string // public key of the peer the action targets
	Name   string // optional human label, copied from PeerState
	Reason string // human-readable justification, for logging
}

// ActionRecord is one past remediation, used by the circuit breaker to avoid
// flapping. The act path appends one after it executes an Action.
type ActionRecord struct {
	Peer string
	Kind ActionKind
	At   time.Time
}

// Config holds the decision core's tunables.
type Config struct {
	// Staleness is how long a peer may go without a handshake before it is
	// considered dead. Keep it comfortably above the ~2 min keepalive renewal
	// (150–180s) or healthy peers will flap.
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

// DefaultConfig returns conservative, flap-resistant defaults.
func DefaultConfig() Config {
	return Config{
		Staleness:    180 * time.Second,
		Window:       10 * time.Minute,
		MaxReResolve: 3,
		MaxBounce:    1,
	}
}
