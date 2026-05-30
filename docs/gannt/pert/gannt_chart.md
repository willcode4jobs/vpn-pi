mermaid ```
gantt
    title v5 Island Internet — Status Tracker
    dateFormat YYYY-MM-DD
    axisFormat %b-%d

    section Key — status
    Done            :done,   leg1, 2026-05-30, 1d
    On track        :active, leg2, 2026-05-30, 1d
    Behind / rework :crit,   leg3, 2026-05-30, 1d
    Pending         :        leg4, 2026-05-30, 1d

    section Key — phases
    A  Vega ingress + cleanup        :done,   ka, 2026-05-30, 1d
    B  Architecture v5 redo          :active, kb, 2026-05-30, 1d
    C  Mesh relay core (CLI proven)  :done,   kc, 2026-05-30, 1d
    D  Node fleet (node 1 up)        :active, kd, 2026-05-30, 1d
    E  App (any-node host)           :        ke, 2026-05-30, 1d
    F  FTP file sharing              :        kf, 2026-05-30, 1d
    G  Deployment automation (D3)    :        kg, 2026-05-30, 1d
    H  Self-heal daemon (Go)         :active, kh, 2026-05-30, 1d
    I  IDS (telemetry)               :        ki, 2026-05-30, 1d
    J  Production hardening          :        kj, 2026-05-30, 1d
    K  Buffer                        :        kk, 2026-05-30, 1d
    L  Final package + demo          :        kl, 2026-05-30, 1d

    section Foundation & core
    A :done,   a, 2026-05-08, 7d
    B :active, b, 2026-05-30, 4d
    C :done,   c, after a, 10d

    section Node fleet
    D :active, d, after c, 10d

    section Automation cluster
    E :e, after d, 14d
    F :f, after d, 7d
    G :g, after d, 10d
    H :active, h, after c, 18d

    section Security & wrap-up
    I :i, after e f g, 10d
    J :j, after i h, 7d
    K :k, after j, 7d
    L :l, after k, 4d
```
