```mermaid
gantt
    title v5 Island Internet Architecture (Re-Baseline)
    dateFormat  YYYY-MM-DD
    axisFormat  %b-%d
    
    section Foundation & Core
    A. Vega ingress (DONE)           :done, a, 2026-05-08, 2026-05-15
    B. Arch v5 + Gantt (Active)      :active, b, 2026-05-30, 4d
    C. Mesh relay / CLI core         :c, after b, 10d
    
    section Node Fleet
    D. Node fleet completion         :d, after c, 7d
    
    section Automation Cluster
    App (any-node host)              :app, after d, 14d
    FTP file sharing                 :ftp, after d, 7d
    Deployment auto (D3)             :dep, after d, 10d
    Self-heal daemon (Go)            :dae, after c, 18d
    
    section Security & Wrap-Up
    F. IDS (Telemetry)               :f, after app ftp dep, 10d
    G. Prod hardening                :g, after f dae, 7d
    H. Buffer                        :h, after g, 7d
    I. Final package + demo          :i, after h, 4d
```

### Legend

| Phase | Description                              | Hrs |
|-------|------------------------------------------|-----|
| A     | Finish vega exit + cleanup               | 9   |
| B     | Architecture v4 + flowchart rebuild      | 8   |
| C     | Per-client routing prototype             | 38  |
| D     | Endpoint fleet                           | 26  |
| E     | GUI (peer-facing self-serve)             | 42  |
| F     | IDS (network + tunnel detection)         | 30  |
| G     | Production hardening                     | 12  |
| H     | Buffer                                   | 15  |
| I     | Final package + demo                     | 8   |
|       | **Total**                                | **188** |

**Critical path:** A → C → E → G → H → I = 96 days (May 8 → Aug 12).
Durations sized at ~0.77 days/hr on the critical path; parallel tracks (B, D, F) fit inside the windows of A and E.
