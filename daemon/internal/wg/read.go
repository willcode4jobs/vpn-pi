// Package wg is the WireGuard-facing layer of the self-heal daemon. It reads
// per-peer state from the kernel via netlink (wgctrl) — no `wg show` text
// parsing — and maps it into the side-effect-free heal.PeerState consumed by
// the decision core.
//
// The live read is isolated behind Reader; the actual translation
// (mapPeers/endpointStr) is pure so it can be unit-tested against synthetic
// devices with no interface, no netlink, and no root.
package wg

import (
	"fmt"
	"net"

	"github.com/willcode4jobs/vpn-pi/daemon/internal/heal"
	"golang.zx2c4.com/wireguard/wgctrl"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// Reader reads peer state from a single WireGuard interface. It is read-only:
// it never sets configuration, so it carries zero lockout risk.
type Reader struct {
	client *wgctrl.Client
	iface  string
}

// NewReader opens a netlink handle to the WireGuard subsystem. The interface is
// not validated until the first Read, so construction succeeds even if the
// tunnel is momentarily down.
func NewReader(iface string) (*Reader, error) {
	c, err := wgctrl.New()
	if err != nil {
		return nil, fmt.Errorf("open wgctrl: %w", err)
	}
	return &Reader{client: c, iface: iface}, nil
}

// Close releases the netlink handle.
func (r *Reader) Close() error {
	return r.client.Close()
}

// Read returns a snapshot of every peer on the configured interface. A missing
// or down interface surfaces as an error rather than an empty snapshot, so the
// caller can tell "no peers" apart from "interface gone".
func (r *Reader) Read() ([]heal.PeerState, error) {
	dev, err := r.client.Device(r.iface)
	if err != nil {
		return nil, fmt.Errorf("read device %q: %w", r.iface, err)
	}
	return mapPeers(dev.Peers), nil
}

// mapPeers translates kernel peer records into the decision core's input type.
// Pure: depends only on its argument.
func mapPeers(peers []wgtypes.Peer) []heal.PeerState {
	out := make([]heal.PeerState, 0, len(peers))
	for _, p := range peers {
		out = append(out, heal.PeerState{
			PublicKey:     p.PublicKey.String(),
			LastHandshake: p.LastHandshakeTime,
			Endpoint:      endpointStr(p.Endpoint),
		})
	}
	return out
}

// endpointStr renders a peer endpoint, tolerating the nil that the kernel
// reports for a peer that has never been contacted.
func endpointStr(a *net.UDPAddr) string {
	if a == nil {
		return ""
	}
	return a.String()
}
