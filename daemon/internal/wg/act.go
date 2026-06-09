package wg

import (
	"fmt"
	"net"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// ReassertEndpoint re-pushes a peer's (static) endpoint to the kernel via
// netlink, resetting its handshake state so keepalive can resume. This is the
// remediation for a peer whose kernel endpoint was cleared or wrong after an
// ungraceful crash — keepalive then has somewhere to send again.
//
// UpdateOnly guarantees it never *creates* a peer (no accidental mesh edits),
// and it targets exactly one peer — safe on a relay, which must never sever the
// others. It stays within CAP_NET_ADMIN; no extra privilege. Because endpoints
// are static, the caller passes the value it cached while the peer was healthy.
func (r *Reader) ReassertEndpoint(publicKey, endpoint string) error {
	key, err := wgtypes.ParseKey(publicKey)
	if err != nil {
		return fmt.Errorf("parse key: %w", err)
	}
	addr, err := net.ResolveUDPAddr("udp", endpoint)
	if err != nil {
		return fmt.Errorf("resolve endpoint %q: %w", endpoint, err)
	}
	return r.client.ConfigureDevice(r.iface, wgtypes.Config{
		Peers: []wgtypes.PeerConfig{{
			PublicKey:  key,
			UpdateOnly: true,
			Endpoint:   addr,
		}},
	})
}
