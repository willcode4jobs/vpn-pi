// Command wg-selfheal is the per-node WireGuard self-heal daemon. It watches
// peer handshake liveness on one interface and, when a tunnel goes stale,
// applies role-gated remediation (re-resolve endpoint; bounce only on spokes).
//
// This build wires the read -> decide -> log loop. The act path (actually
// touching the tunnel) and systemd Type=notify integration land in later
// slices; until then the daemon reports the actions it WOULD take.
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
	)
	flag.Parse()

	role, err := parseRole(*roleFlag)
	if err != nil {
		return err
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg := heal.DefaultConfig()

	reader, err := wg.NewReader(*iface)
	if err != nil {
		return fmt.Errorf("init reader: %w", err)
	}
	defer reader.Close()

	// SIGINT/SIGTERM cancel the context so systemd can stop us cleanly.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log.Info("starting", "role", role.String(), "iface", *iface,
		"interval", interval.String(), "staleness", cfg.Staleness.String())

	// history feeds the circuit breaker. It stays empty until the act path
	// lands and starts recording executed remediations.
	var history []heal.ActionRecord

	ticker := time.NewTicker(*interval)
	defer ticker.Stop()

	for {
		tick(log, reader, role, cfg, history)

		select {
		case <-ctx.Done():
			log.Info("shutting down")
			return nil
		case <-ticker.C:
		}
	}
}

// tick runs one read -> decide -> log cycle. A read failure is logged and
// swallowed: a momentarily-down interface should not crash the daemon.
func tick(log *slog.Logger, reader *wg.Reader, role heal.Role, cfg heal.Config, history []heal.ActionRecord) {
	now := time.Now()

	peers, err := reader.Read()
	if err != nil {
		log.Warn("read failed", "err", err)
		return
	}

	observe(log, now, peers, cfg)

	actions := heal.Decide(now, role, peers, history, cfg)
	if len(actions) == 0 {
		log.Debug("all peers healthy", "peers", len(peers))
		return
	}

	for _, a := range actions {
		// TODO(act-path): execute the action and append an ActionRecord to
		// history so the circuit breaker sees it. For now we only report.
		log.Info("would remediate",
			"action", a.Kind.String(), "peer", shortKey(a.Peer), "reason", a.Reason)
	}
}

// observe logs a per-peer snapshot each cycle so the read-only build is a real
// observation tool — you can watch handshake ages tick and verdicts flip.
// Verbose by design for the pre-act-path phase; quiet this once it acts.
func observe(log *slog.Logger, now time.Time, peers []heal.PeerState, cfg heal.Config) {
	for _, p := range peers {
		age, status := "never", "stale"
		if !p.LastHandshake.IsZero() {
			d := now.Sub(p.LastHandshake)
			age = d.Round(time.Second).String()
			if d < cfg.Staleness {
				status = "healthy"
			}
		}
		log.Info("peer",
			"key", shortKey(p.PublicKey),
			"endpoint", p.Endpoint,
			"handshake_age", age,
			"status", status)
	}
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
