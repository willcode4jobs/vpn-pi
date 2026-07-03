package heal

import (
	"testing"
	"time"
)

// TestStepThresholds covers the pure age→state mapping for a first-seen peer
// (no prior memo), across the ok / stale / degraded bands and boundaries.
func TestStepThresholds(t *testing.T) {
	tests := []struct {
		name string
		age  time.Duration // handshake age; negative = never handshaked
		want State
	}{
		{"fresh → ok", 5 * time.Second, StateOK},
		{"just under stale → ok", 29 * time.Second, StateOK},
		{"exactly stale → stale", 30 * time.Second, StateStale},
		{"mid stale band → stale", 45 * time.Second, StateStale},
		{"just under degraded → stale", 59 * time.Second, StateStale},
		{"exactly degraded → degraded", 60 * time.Second, StateDegraded},
		{"well past degraded → degraded", 10 * time.Minute, StateDegraded},
		{"never handshaked → degraded", -1, StateDegraded},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			statuses, _ := Step(now, []PeerState{peer("a", tt.age)}, nil, cfg())
			if statuses[0].State != tt.want {
				t.Errorf("age %v: state = %s, want %s", tt.age, statuses[0].State, tt.want)
			}
		})
	}
}

// TestStepRecoveryDebounce drives the restored-hold path across ticks: a
// degraded peer recovers → restored, holds for RestoredHold → ok, and the memo
// carries the hold clock forward.
func TestStepRecoveryDebounce(t *testing.T) {
	c := cfg()
	// Start: peer degraded (last handshake 5 min ago).
	statuses, memo := Step(now, []PeerState{peer("a", 5*time.Minute)}, nil, c)
	if statuses[0].State != StateDegraded {
		t.Fatalf("t0: want degraded, got %s", statuses[0].State)
	}

	// A fresh handshake arrives → restored (hold begins).
	t1 := now.Add(c.StaleAfter)
	fresh := PeerState{PublicKey: "a", Name: "a", LastHandshake: t1}
	statuses, memo = Step(t1, []PeerState{fresh}, memo, c)
	if statuses[0].State != StateRestored {
		t.Fatalf("t1: want restored, got %s", statuses[0].State)
	}
	if got := memo["a"].RestoredSince; !got.Equal(t1) {
		t.Fatalf("t1: RestoredSince = %v, want %v", got, t1)
	}

	// Still inside the hold (age < StaleAfter, elapsed < RestoredHold) → restored.
	t2 := t1.Add(c.RestoredHold - time.Second)
	stillFresh := PeerState{PublicKey: "a", Name: "a", LastHandshake: t2.Add(-5 * time.Second)}
	statuses, memo = Step(t2, []PeerState{stillFresh}, memo, c)
	if statuses[0].State != StateRestored {
		t.Fatalf("t2: want restored (mid-hold), got %s", statuses[0].State)
	}
	if got := memo["a"].RestoredSince; !got.Equal(t1) {
		t.Fatalf("t2: RestoredSince must carry forward, got %v want %v", got, t1)
	}

	// Hold satisfied and still healthy → ok.
	t3 := t1.Add(c.RestoredHold)
	okPeer := PeerState{PublicKey: "a", Name: "a", LastHandshake: t3.Add(-5 * time.Second)}
	statuses, _ = Step(t3, []PeerState{okPeer}, memo, c)
	if statuses[0].State != StateOK {
		t.Fatalf("t3: want ok after hold, got %s", statuses[0].State)
	}
}

// TestStepHoldInterrupted verifies that a peer whose handshake ages out during
// the restored hold falls back to stale (threshold wins over the hold).
func TestStepHoldInterrupted(t *testing.T) {
	c := cfg()
	memo := map[string]PeerMemo{"a": {State: StateRestored, RestoredSince: now}}
	// Next tick, its handshake is 40s old — into the stale band mid-hold.
	statuses, next := Step(now.Add(10*time.Second), []PeerState{peer("a", 40*time.Second)}, memo, c)
	if statuses[0].State != StateStale {
		t.Fatalf("want stale when age exceeds StaleAfter during hold, got %s", statuses[0].State)
	}
	if !next["a"].RestoredSince.IsZero() {
		t.Errorf("RestoredSince should reset on falling out of the hold, got %v", next["a"].RestoredSince)
	}
}

// TestStepOrderAndPassthrough checks output order and the passthrough fields.
func TestStepOrderAndPassthrough(t *testing.T) {
	peers := []PeerState{
		{PublicKey: "ok", Name: "ok", LastHandshake: now.Add(-5 * time.Second), Endpoint: "1.1.1.1:51820"},
		{PublicKey: "stale", Name: "stale", LastHandshake: now.Add(-45 * time.Second)},
		{PublicKey: "deg", Name: "deg", LastHandshake: now.Add(-5 * time.Minute)},
	}
	statuses, _ := Step(now, peers, nil, cfg())
	want := []State{StateOK, StateStale, StateDegraded}
	for i, s := range statuses {
		if s.State != want[i] {
			t.Errorf("status[%d] (%s) = %s, want %s", i, s.Peer, s.State, want[i])
		}
	}
	if statuses[0].Endpoint != "1.1.1.1:51820" {
		t.Errorf("endpoint not passed through: %q", statuses[0].Endpoint)
	}
}

// TestStatesOf projects a memo map to plain states.
func TestStatesOf(t *testing.T) {
	memo := map[string]PeerMemo{
		"a": {State: StateOK},
		"b": {State: StateRestored, RestoredSince: now},
	}
	got := StatesOf(memo)
	if got["a"] != StateOK || got["b"] != StateRestored {
		t.Errorf("StatesOf = %+v", got)
	}
}
