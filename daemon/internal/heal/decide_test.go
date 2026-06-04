package heal

import (
	"testing"
	"time"
)

// now is a fixed reference point so tests never depend on the wall clock.
var now = time.Date(2026, 6, 2, 12, 0, 0, 0, time.UTC)

// peer builds a PeerState whose last handshake was `age` ago relative to now.
// A negative age is clamped to the zero time to model a never-handshaked peer.
func peer(key string, age time.Duration) PeerState {
	p := PeerState{PublicKey: key, Name: key}
	if age >= 0 {
		p.LastHandshake = now.Add(-age)
	}
	return p
}

// rec builds an ActionRecord that occurred `ago` before now.
func rec(key string, kind ActionKind, ago time.Duration) ActionRecord {
	return ActionRecord{Peer: key, Kind: kind, At: now.Add(-ago)}
}

func cfg() Config {
	return Config{
		Staleness:    180 * time.Second,
		Window:       10 * time.Minute,
		MaxReResolve: 3,
		MaxBounce:    1,
	}
}

func TestDecide(t *testing.T) {
	tests := []struct {
		name    string
		role    Role
		peers   []PeerState
		history []ActionRecord
		want    []Action // only Kind+Peer are asserted
	}{
		{
			name:  "healthy peer yields nothing",
			role:  RoleSpoke,
			peers: []PeerState{peer("a", 30*time.Second)},
			want:  nil,
		},
		{
			name:  "just under threshold is healthy",
			role:  RoleSpoke,
			peers: []PeerState{peer("a", 179*time.Second)},
			want:  nil,
		},
		{
			name:  "exactly at threshold acts",
			role:  RoleSpoke,
			peers: []PeerState{peer("a", 180*time.Second)},
			want:  []Action{{Kind: ActionReResolve, Peer: "a"}},
		},
		{
			name:  "stale peer with no history re-resolves",
			role:  RoleSpoke,
			peers: []PeerState{peer("a", 5*time.Minute)},
			want:  []Action{{Kind: ActionReResolve, Peer: "a"}},
		},
		{
			name:  "never-handshaked peer is treated as stale",
			role:  RoleSpoke,
			peers: []PeerState{peer("a", -1)},
			want:  []Action{{Kind: ActionReResolve, Peer: "a"}},
		},
		{
			name:  "spoke escalates to bounce after re-resolves exhausted",
			role:  RoleSpoke,
			peers: []PeerState{peer("a", 5*time.Minute)},
			history: []ActionRecord{
				rec("a", ActionReResolve, 1*time.Minute),
				rec("a", ActionReResolve, 2*time.Minute),
				rec("a", ActionReResolve, 3*time.Minute),
			},
			want: []Action{{Kind: ActionBounceInterface, Peer: "a"}},
		},
		{
			name:  "spoke latches degraded after bounce exhausted",
			role:  RoleSpoke,
			peers: []PeerState{peer("a", 5*time.Minute)},
			history: []ActionRecord{
				rec("a", ActionReResolve, 1*time.Minute),
				rec("a", ActionReResolve, 2*time.Minute),
				rec("a", ActionReResolve, 3*time.Minute),
				rec("a", ActionBounceInterface, 30*time.Second),
			},
			want: []Action{{Kind: ActionAlert, Peer: "a"}},
		},
		{
			name:  "relay alerts after re-resolves exhausted, never bounces",
			role:  RoleRelay,
			peers: []PeerState{peer("a", 5*time.Minute)},
			history: []ActionRecord{
				rec("a", ActionReResolve, 1*time.Minute),
				rec("a", ActionReResolve, 2*time.Minute),
				rec("a", ActionReResolve, 3*time.Minute),
			},
			want: []Action{{Kind: ActionAlert, Peer: "a"}},
		},
		{
			name:  "relay never bounces even with bounce history present",
			role:  RoleRelay,
			peers: []PeerState{peer("a", 5*time.Minute)},
			history: []ActionRecord{
				rec("a", ActionReResolve, 1*time.Minute),
				rec("a", ActionReResolve, 2*time.Minute),
				rec("a", ActionReResolve, 3*time.Minute),
				rec("a", ActionBounceInterface, 30*time.Second),
			},
			want: []Action{{Kind: ActionAlert, Peer: "a"}},
		},
		{
			name:  "history outside the window is ignored",
			role:  RoleSpoke,
			peers: []PeerState{peer("a", 5*time.Minute)},
			history: []ActionRecord{
				rec("a", ActionReResolve, 20*time.Minute),
				rec("a", ActionReResolve, 30*time.Minute),
				rec("a", ActionReResolve, 40*time.Minute),
			},
			want: []Action{{Kind: ActionReResolve, Peer: "a"}},
		},
		{
			name:  "another peer's history does not count",
			role:  RoleSpoke,
			peers: []PeerState{peer("a", 5*time.Minute)},
			history: []ActionRecord{
				rec("b", ActionReResolve, 1*time.Minute),
				rec("b", ActionReResolve, 2*time.Minute),
				rec("b", ActionReResolve, 3*time.Minute),
			},
			want: []Action{{Kind: ActionReResolve, Peer: "a"}},
		},
		{
			name: "mixed peers decided independently, order preserved",
			role: RoleSpoke,
			peers: []PeerState{
				peer("healthy", 10*time.Second),
				peer("fresh-stale", 5*time.Minute),
				peer("exhausted", 5*time.Minute),
			},
			history: []ActionRecord{
				rec("exhausted", ActionReResolve, 1*time.Minute),
				rec("exhausted", ActionReResolve, 2*time.Minute),
				rec("exhausted", ActionReResolve, 3*time.Minute),
				rec("exhausted", ActionBounceInterface, 30*time.Second),
			},
			want: []Action{
				{Kind: ActionReResolve, Peer: "fresh-stale"},
				{Kind: ActionAlert, Peer: "exhausted"},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Decide(now, tt.role, tt.peers, tt.history, cfg())
			if len(got) != len(tt.want) {
				t.Fatalf("got %d actions, want %d\n got: %+v", len(got), len(tt.want), got)
			}
			for i := range got {
				if got[i].Kind != tt.want[i].Kind || got[i].Peer != tt.want[i].Peer {
					t.Errorf("action[%d] = {%s %s}, want {%s %s}",
						i, got[i].Kind, got[i].Peer, tt.want[i].Kind, tt.want[i].Peer)
				}
				if got[i].Reason == "" {
					t.Errorf("action[%d] (%s %s) has empty Reason", i, got[i].Kind, got[i].Peer)
				}
			}
		})
	}
}

// TestDecideIsPure guards the core invariant: Decide must not mutate its inputs.
func TestDecideIsPure(t *testing.T) {
	peers := []PeerState{peer("a", 5*time.Minute)}
	history := []ActionRecord{rec("a", ActionReResolve, 1*time.Minute)}
	peersCopy := append([]PeerState(nil), peers...)
	historyCopy := append([]ActionRecord(nil), history...)

	Decide(now, RoleSpoke, peers, history, cfg())

	for i := range peers {
		if peers[i] != peersCopy[i] {
			t.Errorf("Decide mutated peers[%d]", i)
		}
	}
	for i := range history {
		if history[i] != historyCopy[i] {
			t.Errorf("Decide mutated history[%d]", i)
		}
	}
}
