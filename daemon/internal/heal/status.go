package heal

import "time"

// State is a peer's health classification, derived from the same threshold,
// role ladder, and circuit-breaker logic that Decide applies. The alert layer
// reflects these; it does not recompute them.
type State int

const (
	// StateOK — handshake within the staleness threshold.
	StateOK State = iota
	// StateStale — handshake age ≥ threshold; remediation still available.
	StateStale
	// StateDegraded — circuit breaker latched (remediation exhausted). The
	// decide core owns this latch via the action ladder; State only names it.
	StateDegraded
)

func (s State) String() string {
	switch s {
	case StateOK:
		return "ok"
	case StateStale:
		return "stale"
	case StateDegraded:
		return "degraded"
	default:
		return "unknown"
	}
}

// PeerStatus is one peer's current classification plus the fields an alert event
// needs. Produced by Classify; consumed by the alert layer.
type PeerStatus struct {
	Peer          string
	Name          string
	State         State
	LastHandshake time.Time
	Endpoint      string
}

// Classify returns the current State of every peer, using the exact threshold +
// role ladder + breaker that Decide applies — derived, not re-implemented. Pure:
// depends only on its arguments. Output preserves input peer order.
func Classify(now time.Time, role Role, peers []PeerState, history []ActionRecord, cfg Config) []PeerStatus {
	out := make([]PeerStatus, 0, len(peers))
	for _, p := range peers {
		out = append(out, PeerStatus{
			Peer:          p.PublicKey,
			Name:          p.Name,
			State:         classifyPeer(now, role, p, history, cfg),
			LastHandshake: p.LastHandshake,
			Endpoint:      p.Endpoint,
		})
	}
	return out
}

// classifyPeer maps a single peer to a State by reusing the decision ladder:
// healthy → ok; remediation available → stale; remediation exhausted (the
// breaker has latched and decidePeer returns an Alert) → degraded. Reusing
// decidePeer keeps the threshold/breaker logic in exactly one place.
func classifyPeer(now time.Time, role Role, p PeerState, history []ActionRecord, cfg Config) State {
	if p.staleness(now) < cfg.Staleness {
		return StateOK
	}
	if decidePeer(now, role, p, history, cfg).Kind == ActionAlert {
		return StateDegraded
	}
	return StateStale
}
