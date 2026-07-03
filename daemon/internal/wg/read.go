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

// Reader is the handle to a single WireGuard interface. Reads (peer state) are
// its main job and carry zero lockout risk; the one write it performs is a
// per-peer endpoint re-assert (see act.go), which never adds or removes peers.
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
			TunnelIP:      firstAllowedIP(p.AllowedIPs),
			LastHandshake: p.LastHandshakeTime,
			Endpoint:      endpointStr(p.Endpoint),
		})
	}
	return out
}

// firstAllowedIP picks a peer's tunnel address for display: the kernel exposes
// no node name, but each peer's AllowedIPs carries its mesh IP. Prefer a host
// route (/32 or /128 — the peer's own address, e.g. 10.42.0.5) over a broader
// subnet (a relay may allow 10.42.0.0/24), falling back to the first entry.
func firstAllowedIP(nets []net.IPNet) string {
	if len(nets) == 0 {
		return ""
	}
	for _, n := range nets {
		if ones, bits := n.Mask.Size(); ones == bits {
			return n.IP.String()
		}
	}
	return nets[0].IP.String()
}

// endpointStr renders a peer endpoint, tolerating the nil that the kernel
// reports for a peer that has never been contacted.
func endpointStr(a *net.UDPAddr) string {
	if a == nil {
		return ""
	}
	return a.String()
}
