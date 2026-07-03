// Package alert is the daemon's state-transition layer. It sits between the
// decide core's per-peer classification and journald: given the previous
// per-peer states and the current classification, it emits one structured
// Event per peer whose state *changed* — nothing on an unchanged tick. The
// structured fields (not free text) are what the later status socket consumes.
//
// It reflects state; it never computes it. Thresholds and the circuit breaker
// live in the decide core.
package alert

import (
	"time"

	"github.com/willcode4jobs/vpn-pi/daemon/internal/heal"
)

// Event is one peer's state transition, structured for journald.
type Event struct {
	Peer          string
	Name          string
	TunnelIP      string
	From          heal.State
	To            heal.State
	LastHandshake time.Time
	Endpoint      string
	At            time.Time
}

// Recovered reports whether this transition is a return to health from a
// stale/degraded state — the one-shot "recovered" event.
func (e Event) Recovered() bool {
	return e.To == heal.StateOK && e.From != heal.StateOK
}

// Kind names the transition for logging: "recovered" for a return to ok,
// otherwise the new state ("stale" / "degraded").
func (e Event) Kind() string {
	if e.Recovered() {
		return "recovered"
	}
	return e.To.String()
}

// Diff compares the previous per-peer states against the current classification
// and returns one Event per peer whose state changed, plus the updated state map
// to persist for the next tick. A peer absent from last is treated as having
// been OK, so a peer first seen already-stale still emits a transition. Pure: it
// does not mutate last, and output preserves input order.
func Diff(last map[string]heal.State, statuses []heal.PeerStatus, now time.Time) ([]Event, map[string]heal.State) {
	next := make(map[string]heal.State, len(statuses))
	var events []Event
	for _, s := range statuses {
		prev, seen := last[s.Peer]
		if !seen {
			prev = heal.StateOK
		}
		if prev != s.State {
			events = append(events, Event{
				Peer:          s.Peer,
				Name:          s.Name,
				TunnelIP:      s.TunnelIP,
				From:          prev,
				To:            s.State,
				LastHandshake: s.LastHandshake,
				Endpoint:      s.Endpoint,
				At:            now,
			})
		}
		next[s.Peer] = s.State
	}
	return events, next
}
