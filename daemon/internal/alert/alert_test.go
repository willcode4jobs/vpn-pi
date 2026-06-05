package alert

import (
	"testing"
	"time"

	"github.com/willcode4jobs/vpn-pi/daemon/internal/heal"
)

var ts = time.Date(2026, 6, 4, 0, 0, 0, 0, time.UTC)

func status(peer string, st heal.State) heal.PeerStatus {
	return heal.PeerStatus{Peer: peer, Name: peer, State: st}
}

func TestDiff(t *testing.T) {
	tests := []struct {
		name     string
		last     map[string]heal.State
		statuses []heal.PeerStatus
		// peer -> expected event kind; a peer absent here must emit no event.
		want map[string]string
	}{
		{"first-seen ok → no event", map[string]heal.State{},
			[]heal.PeerStatus{status("a", heal.StateOK)}, map[string]string{}},
		{"first-seen stale → stale event", map[string]heal.State{},
			[]heal.PeerStatus{status("a", heal.StateStale)}, map[string]string{"a": "stale"}},
		{"ok→ok → nothing", map[string]heal.State{"a": heal.StateOK},
			[]heal.PeerStatus{status("a", heal.StateOK)}, map[string]string{}},
		{"stale→stale → nothing", map[string]heal.State{"a": heal.StateStale},
			[]heal.PeerStatus{status("a", heal.StateStale)}, map[string]string{}},
		{"ok→stale → stale", map[string]heal.State{"a": heal.StateOK},
			[]heal.PeerStatus{status("a", heal.StateStale)}, map[string]string{"a": "stale"}},
		{"stale→ok → recovered", map[string]heal.State{"a": heal.StateStale},
			[]heal.PeerStatus{status("a", heal.StateOK)}, map[string]string{"a": "recovered"}},
		{"stale→degraded → degraded", map[string]heal.State{"a": heal.StateStale},
			[]heal.PeerStatus{status("a", heal.StateDegraded)}, map[string]string{"a": "degraded"}},
		{"degraded→ok → recovered", map[string]heal.State{"a": heal.StateDegraded},
			[]heal.PeerStatus{status("a", heal.StateOK)}, map[string]string{"a": "recovered"}},
		{"multi: only the changed peer emits", map[string]heal.State{"a": heal.StateOK, "b": heal.StateOK},
			[]heal.PeerStatus{status("a", heal.StateOK), status("b", heal.StateStale)}, map[string]string{"b": "stale"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			events, next := Diff(tt.last, tt.statuses, ts)
			if len(events) != len(tt.want) {
				t.Fatalf("got %d events, want %d: %+v", len(events), len(tt.want), events)
			}
			for _, e := range events {
				want, ok := tt.want[e.Peer]
				if !ok {
					t.Errorf("unexpected event for %s (%s)", e.Peer, e.Kind())
					continue
				}
				if e.Kind() != want {
					t.Errorf("peer %s: kind = %s, want %s", e.Peer, e.Kind(), want)
				}
				if !e.At.Equal(ts) {
					t.Errorf("peer %s: At = %v, want %v", e.Peer, e.At, ts)
				}
			}
			for _, s := range tt.statuses {
				if next[s.Peer] != s.State {
					t.Errorf("next[%s] = %s, want %s", s.Peer, next[s.Peer], s.State)
				}
			}
		})
	}
}

// TestDiffDoesNotMutateInput guards the purity contract: Diff returns a new map
// and must never write through the caller's previous-state map.
func TestDiffDoesNotMutateInput(t *testing.T) {
	last := map[string]heal.State{"a": heal.StateOK}
	Diff(last, []heal.PeerStatus{status("a", heal.StateStale)}, ts)
	if last["a"] != heal.StateOK {
		t.Errorf("Diff mutated input map: last[a] = %s, want ok", last["a"])
	}
}
