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

// TestDefaultConfigHealthyPeerReachesOK drives DefaultConfig through a realistic
// WireGuard timeline: a healthy link renews its handshake only ~every 120s
// (REKEY_AFTER_TIME), so with a 30s poll a peer's handshake age routinely sits
// at 90–130s between rekeys. After an outage and recovery the peer must ride
// restored back to ok — and then STAY ok across rekey gaps. (Under the old 30s
// StaleAfter this was impossible: StateOK was unreachable after a peer's first
// excursion and the "recovered" event was dead code.)
func TestDefaultConfigHealthyPeerReachesOK(t *testing.T) {
	c := DefaultConfig()
	const rekey = 120 * time.Second // WireGuard REKEY_AFTER_TIME on a healthy link
	if c.StaleAfter <= rekey {
		t.Fatalf("StaleAfter (%v) must exceed the ~%v rekey interval or healthy peers read stale between rekeys", c.StaleAfter, rekey)
	}

	// Outage: last handshake 10 minutes ago → degraded.
	down := PeerState{PublicKey: "a", Name: "a", LastHandshake: now.Add(-10 * time.Minute)}
	statuses, memo := Step(now, []PeerState{down}, nil, c)
	if statuses[0].State != StateDegraded {
		t.Fatalf("t0: want degraded, got %s", statuses[0].State)
	}

	// Recovery: a handshake lands at t+20s, then renews only every 120s. Poll
	// every 30s for 10 minutes and record the state sequence.
	handshake := now.Add(20 * time.Second)
	var seq []State
	for i := 1; i <= 20; i++ {
		at := now.Add(time.Duration(i) * 30 * time.Second)
		for !handshake.Add(rekey).After(at) {
			handshake = handshake.Add(rekey) // healthy link: rekey when due
		}
		p := PeerState{PublicKey: "a", Name: "a", LastHandshake: handshake}
		statuses, memo = Step(at, []PeerState{p}, memo, c)
		seq = append(seq, statuses[0].State)
	}

	if seq[0] != StateRestored {
		t.Fatalf("first tick after recovery: want restored, got %s (seq %v)", seq[0], seq)
	}
	reached := -1
	for i, s := range seq {
		if s == StateOK {
			reached = i
			break
		}
	}
	if reached == -1 {
		t.Fatalf("peer never reached ok: %v", seq)
	}
	for i := reached; i < len(seq); i++ {
		if seq[i] != StateOK {
			t.Fatalf("tick %d: healthy peer left ok after recovery (seq %v)", i+1, seq)
		}
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
