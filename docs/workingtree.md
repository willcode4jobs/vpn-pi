vpn-pi/
├── README.md                     # Project overview + current status
├── CLAUDE.md                     # Claude Code context (new)
├── .gitignore
├── docs/                         # All documentation
│   ├── architecture.md           # Topology, design decisions
│   ├── network-fundamentals.md   # Moved from phase1-netns/notes/
│   ├── runbook.md                # How to rebuild from scratch (TBD)
│   └── work-log.md               # Hours/progress log for the writeup
├── prototype/                    # VM-based prototype work (active)
│   ├── README.md
│   ├── configs/                  # Hand-written configs
│   │   ├── wireguard/            # wg0.conf, peer configs
│   │   ├── nftables/             # firewall rules
│   │   └── sshd/                 # hardened sshd_config
│   ├── scripts/                  # Setup, teardown, helpers
│   └── notes/                    # Session notes during build
├── pi-deployment/                # Pi-specific work (placeholder)
│   └── README.md
├── webui/                        # Phase 6 web UI (placeholder)
│   └── README.md
└── archive/                      # Shelved work, kept for reference
    └── phase1-netns/             # Namespace lab from earlier today
        ├── scripts/
        └── notes/