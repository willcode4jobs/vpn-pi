package heal

import (
	"fmt"
	"time"
)

// Decide is the heart of the daemon: a pure function from a snapshot of the
// world to a list of actions. It performs no I/O, has no side effects, and
// reads nothing but its arguments — so it can be exhaustively unit-tested
// against synthetic peers.
//
// For each peer it applies, in order:
//   - a staleness threshold — is the tunnel dead?
//   - a role ladder — what am I allowed to do about it?
//   - a circuit breaker — have I already tried too many times this window?
//
// Healthy peers yield no action. Output preserves input peer order and is
// deterministic for a given set of inputs.
func Decide(now time.Time, role Role, peers []PeerState, history []ActionRecord, cfg Config) []Action {
	var actions []Action
	for _, p := range peers {
		if p.staleness(now) < cfg.Staleness {
			continue // healthy: handshake within threshold
		}
		actions = append(actions, decidePeer(now, role, p, history, cfg))
	}
	return actions
}

// decidePeer resolves the role ladder and circuit breaker for a single stale
// peer. The caller has already established that the peer is stale.
func decidePeer(now time.Time, role Role, p PeerState, history []ActionRecord, cfg Config) Action {
	reResolves := countRecent(history, p.PublicKey, ActionReResolve, now, cfg.Window)
	bounces := countRecent(history, p.PublicKey, ActionBounceInterface, now, cfg.Window)

	switch {
	case reResolves < cfg.MaxReResolve:
		return Action{
			Kind:   ActionReResolve,
			Peer:   p.PublicKey,
			Name:   p.Name,
			IP:     p.TunnelIP,
			Reason: fmt.Sprintf("stale (%s); re-resolve attempt %d/%d", p.stalenessLabel(now), reResolves+1, cfg.MaxReResolve),
		}
	case role == RoleSpoke && bounces < cfg.MaxBounce:
		return Action{
			Kind:   ActionBounceInterface,
			Peer:   p.PublicKey,
			Name:   p.Name,
			IP:     p.TunnelIP,
			Reason: fmt.Sprintf("stale (%s); %d re-resolves exhausted; spoke bounce attempt %d/%d", p.stalenessLabel(now), reResolves, bounces+1, cfg.MaxBounce),
		}
	default:
		return Action{
			Kind:   ActionAlert,
			Peer:   p.PublicKey,
			Name:   p.Name,
			IP:     p.TunnelIP,
			Reason: fmt.Sprintf("stale (%s); %s remediation exhausted; latched degraded", p.stalenessLabel(now), role),
		}
	}
}

// countRecent counts actions of a given kind targeting a given peer within the
// breaker window ending at now. Records on the cutoff boundary are excluded.
func countRecent(history []ActionRecord, peer string, kind ActionKind, now time.Time, window time.Duration) int {
	cutoff := now.Add(-window)
	n := 0
	for _, r := range history {
		if r.Peer == peer && r.Kind == kind && r.At.After(cutoff) {
			n++
		}
	}
	return n
}
