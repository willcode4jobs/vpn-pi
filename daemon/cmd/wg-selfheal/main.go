// Command wg-selfheal is the per-node WireGuard self-heal daemon. Each tick it
// reads peer handshake liveness on one interface, classifies every peer
// (ok / stale / degraded), emits a structured journald event on each state
// transition, and applies role-gated remediation: re-assert a peer's static
// endpoint so keepalive can resume. Relays never bounce the interface.
//
// Interface-bounce is decided by the core but NOT executed yet — it needs more
// than CAP_NET_ADMIN (a privileged wg-quick restart). Until that's wired,
// MaxBounce is held at 0 so an unrecoverable spoke escalates straight to
// degraded + alert rather than stalling on a bounce we can't perform.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/willcode4jobs/vpn-pi/daemon/internal/alert"
	"github.com/willcode4jobs/vpn-pi/daemon/internal/heal"
	"github.com/willcode4jobs/vpn-pi/daemon/internal/wg"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		roleFlag = flag.String("role", "", "node role: spoke | relay (required)")
		iface    = flag.String("iface", "wg0", "WireGuard interface to watch")
		interval = flag.Duration("interval", 30*time.Second, "how often to poll peer state")
		snapshot = flag.Bool("snapshot", false, "log a full per-peer snapshot every tick (default: transitions only)")
		dryRun   = flag.Bool("dry-run", false, "classify and emit events but never touch the tunnel")
	)
	flag.Parse()

	role, err := parseRole(*roleFlag)
	if err != nil {
		return err
	}

	// JSON so each line is machine-parseable in journald — islandd's IDS collector
	// reads `journalctl -u wg-selfheal -o json` and parses these state-change events.
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg := heal.DefaultConfig()
	// Interface-bounce isn't wired yet (needs a privileged wg-quick restart,
	// beyond CAP_NET_ADMIN). Hold MaxBounce at 0 so the core escalates an
	// unrecoverable spoke to degraded instead of emitting a bounce we can't do.
	cfg.MaxBounce = 0

	reader, err := wg.NewReader(*iface)
	if err != nil {
		return fmt.Errorf("init reader: %w", err)
	}
	defer reader.Close()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log.Info("starting",
		"role", role.String(), "iface", *iface, "interval", interval.String(),
		"staleness", cfg.Staleness.String(), "dry_run", *dryRun, "snapshot", *snapshot)

	st := &loopState{
		memo:          map[string]heal.PeerMemo{},
		endpointCache: map[string]string{},
	}

	ticker := time.NewTicker(*interval)
	defer ticker.Stop()

	for {
		tick(log, reader, role, cfg, st, *dryRun, *snapshot)

		select {
		case <-ctx.Done():
			log.Info("shutting down")
			return nil
		case <-ticker.C:
		}
	}
}

// loopState is the daemon's memory across ticks.
type loopState struct {
	memo          map[string]heal.PeerMemo // per-peer state + restored-hold clock
	endpointCache map[string]string        // last endpoint seen while a peer was healthy
	history       []heal.ActionRecord      // executed remediations, for the circuit breaker
}

// tick runs one full cycle: read -> classify -> emit transitions -> remediate.
// A read failure is logged and swallowed; prior state is preserved so a
// momentarily-down interface neither crashes the daemon nor loses context.
func tick(log *slog.Logger, reader *wg.Reader, role heal.Role, cfg heal.Config, st *loopState, dryRun, snapshot bool) {
	now := time.Now()

	peers, err := reader.Read()
	if err != nil {
		log.Warn("read failed", "err", err)
		return
	}

	st.history = pruneHistory(st.history, now.Add(-cfg.Window))

	if snapshot {
		observe(log, now, peers, cfg)
	}

	// Health classification is time-tiered and stateful (the restored hold needs
	// the prior state); remediation below is separate and stays on cfg.Staleness.
	statuses, nextMemo := heal.Step(now, peers, st.memo, cfg)
	pruneCache(st.endpointCache, statuses)
	cacheHealthy(st.endpointCache, statuses)

	events, _ := alert.Diff(heal.StatesOf(st.memo), statuses, now)
	st.memo = nextMemo
	for _, e := range events {
		log.Info("state change",
			"event", e.Kind(),
			"peer", peerLabel(e.Name, e.TunnelIP, e.Peer), // readable id for the IDS feed
			"pubkey", shortKey(e.Peer),                    // keep the key for correlation
			"from", e.From.String(), "to", e.To.String(),
			"handshake_age", ageLabel(now, e.LastHandshake),
			"endpoint", e.Endpoint)
	}

	for _, a := range heal.Decide(now, role, peers, st.history, cfg) {
		remediate(log, reader, st, a, now, dryRun)
	}
}

// endpointAsserter is the one tunnel-touching capability remediate needs.
// Satisfied by *wg.Reader; a test fake stands in for it off-box.
type endpointAsserter interface {
	ReassertEndpoint(publicKey, endpoint string) error
}

// remediate executes a single action. Only re-assert touches the tunnel; alert
// is surfaced by the transition layer. A re-assert with no cached endpoint
// (e.g. a passive, inbound-only peer) is un-actionable and skipped quietly — the
// stale transition already surfaced it once.
func remediate(log *slog.Logger, reader endpointAsserter, st *loopState, a heal.Action, now time.Time, dryRun bool) {
	who := peerLabel(a.Name, a.IP, a.Peer)
	switch a.Kind {
	case heal.ActionReResolve:
		ep, ok := st.endpointCache[a.Peer]
		if !ok {
			log.Debug("no endpoint to re-assert (passive peer?)", "peer", who)
			return
		}
		if dryRun {
			log.Info("would re-assert endpoint", "peer", who, "endpoint", ep)
			return
		}
		// Record the attempt whether or not it succeeds: the circuit breaker
		// counts attempts, and a permanently-failing re-assert would otherwise
		// never trip it — the daemon would retry forever instead of latching
		// degraded once MaxReResolve is exhausted.
		st.history = append(st.history, heal.ActionRecord{Peer: a.Peer, Kind: heal.ActionReResolve, At: now})
		if err := reader.ReassertEndpoint(a.Peer, ep); err != nil {
			log.Error("re-assert failed", "peer", who, "endpoint", ep, "err", err)
			return
		}
		log.Info("re-asserted endpoint", "peer", who, "endpoint", ep, "reason", a.Reason)

	case heal.ActionAlert:
		// Surfaced by the degraded transition in the alert layer; nothing to run.

	case heal.ActionBounceInterface:
		// Unreachable while MaxBounce=0; guarded for when bounce gets wired.
		log.Warn("interface bounce requested but not wired (privilege gap)", "peer", who)
	}
}

// cacheHealthy records the endpoint of every currently-healthy peer, so a later
// re-assert has a known-good static endpoint to push. Correct precisely because
// endpoints are static.
func cacheHealthy(cache map[string]string, statuses []heal.PeerStatus) {
	for _, s := range statuses {
		// ok and restored both mean a fresh handshake, so the endpoint is live.
		// Caching on restored too means a peer recovering from an outage
		// refreshes its cached endpoint before it has served out the hold.
		if (s.State == heal.StateOK || s.State == heal.StateRestored) && s.Endpoint != "" {
			cache[s.Peer] = s.Endpoint
		}
	}
}

// pruneCache drops cached endpoints for peers no longer present on the
// interface (mirroring how st.memo self-prunes via Step's nextMemo). Without
// this, a removed/rotated key's entry lives for the daemon lifetime, and a
// re-added key could be pushed a stale endpoint.
func pruneCache(cache map[string]string, statuses []heal.PeerStatus) {
	present := make(map[string]bool, len(statuses))
	for _, s := range statuses {
		present[s.Peer] = true
	}
	for k := range cache {
		if !present[k] {
			delete(cache, k)
		}
	}
}

// pruneHistory drops action records older than the breaker window, keeping the
// history bounded over a long-running daemon.
func pruneHistory(history []heal.ActionRecord, cutoff time.Time) []heal.ActionRecord {
	kept := history[:0]
	for _, r := range history {
		if r.At.After(cutoff) {
			kept = append(kept, r)
		}
	}
	return kept
}

// observe logs a full per-peer snapshot — opt-in via --snapshot. Default
// operation emits transitions only (see tick).
func observe(log *slog.Logger, now time.Time, peers []heal.PeerState, cfg heal.Config) {
	for _, p := range peers {
		// Snapshot label uses the classification thresholds (stateless — no
		// restored, which needs cross-tick memory). Mirrors ok/stale/degraded.
		status := "ok"
		switch {
		case p.LastHandshake.IsZero() || now.Sub(p.LastHandshake) >= cfg.DegradedAfter:
			status = "degraded"
		case now.Sub(p.LastHandshake) >= cfg.StaleAfter:
			status = "stale"
		}
		log.Info("peer",
			"peer", peerLabel(p.Name, p.TunnelIP, p.PublicKey),
			"pubkey", shortKey(p.PublicKey),
			"endpoint", p.Endpoint,
			"handshake_age", ageLabel(now, p.LastHandshake),
			"status", status)
	}
}

// ageLabel renders handshake age for logs, special-casing the never-handshaked
// sentinel so it reads "never" rather than a huge duration.
func ageLabel(now, handshake time.Time) string {
	if handshake.IsZero() {
		return "never"
	}
	return now.Sub(handshake).Round(time.Second).String()
}

func parseRole(s string) (heal.Role, error) {
	switch s {
	case "spoke":
		return heal.RoleSpoke, nil
	case "relay":
		return heal.RoleRelay, nil
	case "":
		return 0, fmt.Errorf("--role is required (spoke | relay)")
	default:
		return 0, fmt.Errorf("invalid --role %q (want spoke | relay)", s)
	}
}

// shortKey trims a base64 WireGuard public key to a readable prefix for logs.
func shortKey(k string) string {
	if len(k) > 8 {
		return k[:8] + "…"
	}
	return k
}

// peerLabel picks the most readable identifier for logs and the IDS feed: a
// human name if one is known, else the peer's mesh/tunnel IP, else the short
// public key. The kernel exposes no name, so today this resolves to the wg0 IP.
func peerLabel(name, tunnelIP, pubKey string) string {
	switch {
	case name != "":
		return name
	case tunnelIP != "":
		return tunnelIP
	default:
		return shortKey(pubKey)
	}
}
