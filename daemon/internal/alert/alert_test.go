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
		{"degraded→restored → restored", map[string]heal.State{"a": heal.StateDegraded},
			[]heal.PeerStatus{status("a", heal.StateRestored)}, map[string]string{"a": "restored"}},
		{"restored→ok → recovered", map[string]heal.State{"a": heal.StateRestored},
			[]heal.PeerStatus{status("a", heal.StateOK)}, map[string]string{"a": "recovered"}},
		{"restored→stale → stale", map[string]heal.State{"a": heal.StateRestored},
			[]heal.PeerStatus{status("a", heal.StateStale)}, map[string]string{"a": "stale"}},
		{"multi: only the changed peer emits", map[string]heal.State{"a": heal.StateOK, "b": heal.StateOK},
			[]heal.PeerStatus{status("a", heal.StateOK), status("b", heal.StateStale)}, map[string]string{"b": "stale"}},
		{"removed while ok → gone", map[string]heal.State{"a": heal.StateOK},
			nil, map[string]string{"a": "gone"}},
		{"removed while degraded → gone", map[string]heal.State{"a": heal.StateDegraded},
			nil, map[string]string{"a": "gone"}},
		{"removal and change together", map[string]heal.State{"a": heal.StateOK, "b": heal.StateDegraded},
			[]heal.PeerStatus{status("a", heal.StateStale)}, map[string]string{"a": "stale", "b": "gone"}},
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

// TestDiffGoneIsOneShot verifies a removed peer emits gone exactly once (it
// drops out of the next-state map, so the following tick is quiet) and that
// multiple removals come out sorted by peer key for deterministic logs.
func TestDiffGoneIsOneShot(t *testing.T) {
	last := map[string]heal.State{"b": heal.StateStale, "a": heal.StateDegraded}
	events, next := Diff(last, nil, ts)
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2: %+v", len(events), events)
	}
	if events[0].Peer != "a" || events[1].Peer != "b" {
		t.Errorf("gone events not sorted by peer key: %+v", events)
	}
	for _, e := range events {
		if e.To != heal.StateGone || e.Kind() != "gone" {
			t.Errorf("peer %s: To = %s, Kind = %s, want gone", e.Peer, e.To, e.Kind())
		}
		if e.From != last[e.Peer] {
			t.Errorf("peer %s: From = %s, want %s", e.Peer, e.From, last[e.Peer])
		}
	}
	if len(next) != 0 {
		t.Fatalf("removed peers must not persist in next: %+v", next)
	}
	// Next tick, still absent → nothing further.
	if events, _ := Diff(next, nil, ts.Add(30*time.Second)); len(events) != 0 {
		t.Errorf("gone must be one-shot, got %+v", events)
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
