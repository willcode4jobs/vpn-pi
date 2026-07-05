package heal

import "time"

// State is a peer's time-tiered health classification, driven purely by handshake
// age and the peer's previous state (for the restored-hold debounce). This feeds
// the IDS security feed; it is independent of the remediation ladder in decide.go.
type State int

const (
	// StateOK — handshake age below StaleAfter (a fresh, active link).
	StateOK State = iota
	// StateStale — handshake age in [StaleAfter, DegradedAfter).
	StateStale
	// StateDegraded — handshake age ≥ DegradedAfter (incl. never-handshaked).
	StateDegraded
	// StateRestored — a stale/degraded peer that just returned to healthy and is
	// serving out its RestoredHold before it is trusted as ok (recovery debounce).
	StateRestored
	// StateGone — synthetic marker for a peer present last cycle but since
	// removed from the interface. Never produced by Step; the alert layer emits
	// it so a (possibly degraded) peer doesn't silently vanish from the feed.
	StateGone
)

func (s State) String() string {
	switch s {
	case StateOK:
		return "ok"
	case StateStale:
		return "stale"
	case StateDegraded:
		return "degraded"
	case StateRestored:
		return "restored"
	case StateGone:
		return "gone"
	default:
		return "unknown"
	}
}

// PeerStatus is one peer's current classification plus the fields an alert event
// needs. Produced by Step; consumed by the alert layer.
type PeerStatus struct {
	Peer          string
	Name          string
	TunnelIP      string
	State         State
	LastHandshake time.Time
	Endpoint      string
}

// PeerMemo is the daemon's per-peer memory between ticks: the last classified
// state and, for a peer inside the restored hold, when it entered StateRestored.
// The zero value ({StateOK, zero time}) is the correct starting point for a
// first-seen peer.
type PeerMemo struct {
	State         State
	RestoredSince time.Time
}

// Step advances the health state machine by one tick. Pure: it derives each
// peer's new state from its handshake age and its previous memo, and returns the
// statuses plus the next memo map to persist for the following tick. Output
// preserves input peer order.
//
// The ladder (thresholds from cfg):
//
//	age < StaleAfter ............... healthy band → ok / restored (see below)
//	StaleAfter ≤ age < DegradedAfter stale
//	age ≥ DegradedAfter ........... degraded (a never-handshaked peer lands here)
//
// Recovery is debounced: a peer re-entering the healthy band from stale/degraded
// becomes restored and only promotes to ok once it has stayed healthy for
// RestoredHold. If its age climbs back past StaleAfter during the hold, the
// threshold check fires first and it drops straight back to stale/degraded.
func Step(now time.Time, peers []PeerState, prev map[string]PeerMemo, cfg Config) ([]PeerStatus, map[string]PeerMemo) {
	out := make([]PeerStatus, 0, len(peers))
	next := make(map[string]PeerMemo, len(peers))
	for _, p := range peers {
		state, restoredSince := stepPeer(now, p, prev[p.PublicKey], cfg)
		next[p.PublicKey] = PeerMemo{State: state, RestoredSince: restoredSince}
		out = append(out, PeerStatus{
			Peer:          p.PublicKey,
			Name:          p.Name,
			TunnelIP:      p.TunnelIP,
			State:         state,
			LastHandshake: p.LastHandshake,
			Endpoint:      p.Endpoint,
		})
	}
	return out, next
}

// stepPeer classifies a single peer. Age thresholds are checked first, so a peer
// whose handshake ages out during a restored hold correctly falls back to
// stale/degraded rather than clinging to restored. Returns the new state and the
// RestoredSince to carry forward (zero unless the peer is in the hold).
func stepPeer(now time.Time, p PeerState, prev PeerMemo, cfg Config) (State, time.Time) {
	age := p.staleness(now)
	switch {
	case age >= cfg.DegradedAfter:
		return StateDegraded, time.Time{}
	case age >= cfg.StaleAfter:
		return StateStale, time.Time{}
	default: // healthy band
		switch prev.State {
		case StateStale, StateDegraded:
			return StateRestored, now // recovery — start the hold
		case StateRestored:
			if now.Sub(prev.RestoredSince) >= cfg.RestoredHold {
				return StateOK, time.Time{} // stayed healthy long enough
			}
			return StateRestored, prev.RestoredSince // still serving the hold
		default: // StateOK or first-seen
			return StateOK, time.Time{}
		}
	}
}

// StatesOf projects a memo map down to a plain per-peer state map, for the
// transition layer (which diffs previous vs current states).
func StatesOf(memo map[string]PeerMemo) map[string]State {
	m := make(map[string]State, len(memo))
	for k, v := range memo {
		m[k] = v.State
	}
	return m
}
