package heal

import (
	"testing"
	"time"
)

func TestClassify(t *testing.T) {
	// full = enough recorded remediation to latch the breaker (degraded).
	full := []ActionRecord{
		rec("a", ActionReResolve, 1*time.Minute),
		rec("a", ActionReResolve, 2*time.Minute),
		rec("a", ActionReResolve, 3*time.Minute),
		rec("a", ActionBounceInterface, 30*time.Second),
	}

	tests := []struct {
		name    string
		role    Role
		peers   []PeerState
		history []ActionRecord
		want    []State
	}{
		{"healthy → ok", RoleSpoke, []PeerState{peer("a", 30*time.Second)}, nil, []State{StateOK}},
		{"stale, no history → stale", RoleSpoke, []PeerState{peer("a", 5*time.Minute)}, nil, []State{StateStale}},
		{"never handshaked → stale", RoleSpoke, []PeerState{peer("a", -1)}, nil, []State{StateStale}},
		{"spoke remediation exhausted → degraded", RoleSpoke, []PeerState{peer("a", 5*time.Minute)}, full, []State{StateDegraded}},
		{"relay re-resolves exhausted → degraded", RoleRelay, []PeerState{peer("a", 5*time.Minute)}, []ActionRecord{
			rec("a", ActionReResolve, 1*time.Minute),
			rec("a", ActionReResolve, 2*time.Minute),
			rec("a", ActionReResolve, 3*time.Minute),
		}, []State{StateDegraded}},
		{"mixed: ok / stale / degraded, order preserved", RoleSpoke, []PeerState{
			peer("ok", 20*time.Second),
			peer("stale", 5*time.Minute),
			peer("deg", 5*time.Minute),
		}, []ActionRecord{
			rec("deg", ActionReResolve, 1*time.Minute),
			rec("deg", ActionReResolve, 2*time.Minute),
			rec("deg", ActionReResolve, 3*time.Minute),
			rec("deg", ActionBounceInterface, 30*time.Second),
		}, []State{StateOK, StateStale, StateDegraded}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Classify(now, tt.role, tt.peers, tt.history, cfg())
			if len(got) != len(tt.want) {
				t.Fatalf("got %d statuses, want %d", len(got), len(tt.want))
			}
			for i := range got {
				if got[i].State != tt.want[i] {
					t.Errorf("status[%d] (%s) = %s, want %s", i, got[i].Peer, got[i].State, tt.want[i])
				}
			}
		})
	}
}
