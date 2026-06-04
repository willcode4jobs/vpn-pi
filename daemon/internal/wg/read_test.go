package wg

import (
	"net"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

func mustKey(t *testing.T, seed byte) wgtypes.Key {
	t.Helper()
	var k wgtypes.Key
	for i := range k {
		k[i] = seed
	}
	return k
}

func TestMapPeers(t *testing.T) {
	k1 := mustKey(t, 1)
	k2 := mustKey(t, 2)
	hs := time.Date(2026, 6, 2, 12, 0, 0, 0, time.UTC)

	peers := []wgtypes.Peer{
		{
			PublicKey:         k1,
			Endpoint:          &net.UDPAddr{IP: net.ParseIP("203.0.113.5"), Port: 51820},
			LastHandshakeTime: hs,
		},
		{
			PublicKey: k2, // never handshaked, no endpoint yet
		},
	}

	got := mapPeers(peers)

	if len(got) != 2 {
		t.Fatalf("got %d peers, want 2", len(got))
	}

	if got[0].PublicKey != k1.String() {
		t.Errorf("peer[0] key = %q, want %q", got[0].PublicKey, k1.String())
	}
	if got[0].Endpoint != "203.0.113.5:51820" {
		t.Errorf("peer[0] endpoint = %q, want 203.0.113.5:51820", got[0].Endpoint)
	}
	if !got[0].LastHandshake.Equal(hs) {
		t.Errorf("peer[0] handshake = %v, want %v", got[0].LastHandshake, hs)
	}

	if got[1].Endpoint != "" {
		t.Errorf("peer[1] endpoint = %q, want empty", got[1].Endpoint)
	}
	if !got[1].LastHandshake.IsZero() {
		t.Errorf("peer[1] handshake = %v, want zero", got[1].LastHandshake)
	}
}

func TestMapPeersEmpty(t *testing.T) {
	got := mapPeers(nil)
	if len(got) != 0 {
		t.Fatalf("got %d peers, want 0", len(got))
	}
}

func TestEndpointStr(t *testing.T) {
	if s := endpointStr(nil); s != "" {
		t.Errorf("nil endpoint = %q, want empty", s)
	}
	addr := &net.UDPAddr{IP: net.ParseIP("198.51.100.9"), Port: 51820}
	if s := endpointStr(addr); s != "198.51.100.9:51820" {
		t.Errorf("endpoint = %q, want 198.51.100.9:51820", s)
	}
}
