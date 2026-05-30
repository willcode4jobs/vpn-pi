```mermaid
gantt
    title v5 Island Internet Architecture (Status Tracker)
    dateFormat  YYYY-MM-DD
    axisFormat  %b-%d
    todayMarker off
    
    %% GitHub-friendly custom classes for status
    classDef ahead fill:#2ea043,stroke:#238636,stroke-width:2px,color:#fff;
    classDef behind fill:#f85149,stroke:#b62324,stroke-width:2px,color:#fff;
    classDef ontrack fill:#d29922,stroke:#9e6a03,stroke-width:2px,color:#fff;
    classDef pending fill:#30363d,stroke:#8b949e,stroke-width:1px,color:#fff;

    section 📊 LEGEND
    Ahead / Done (Green)       : ahead, leg1, 2026-05-30, 1d
    On Track / Active (Yellow) : ontrack, leg2, 2026-05-30, 1d
    Behind / Re-work (Red)     : behind, leg3, 2026-05-30, 1d
    Pending (Dark)             : pending, leg4, 2026-05-30, 1d

    section Foundation & Core
    A. Vega ingress (DONE)           : ahead, a, 2026-05-08, 7d
    B. Arch v5 (RE-OPENED)           : behind, b, 2026-05-30, 4d
    C. Mesh relay (CLI DONE)         : ahead, c, after b, 10d
    
    section Node Fleet
    D. Node fleet (NODE 1 UP)        : ontrack, d, after c, 7d
    
    section Automation Cluster
    App (any-node host)              : pending, app, after d, 14d
    FTP file sharing                 : pending, ftp, after d, 7d
    Deployment auto (D3)             : pending, dep, after d, 10d
    Self-heal daemon (Go)            : pending, dae, after c, 18d
    
    section Security & Wrap-Up
    F. IDS (Telemetry)               : pending, f, after app ftp dep, 10d
    G. Prod hardening                : pending, g, after f dae, 7d
    H. Buffer                        : pending, h, after g, 7d
    I. Final package + demo          : pending, i, after h, 4d
```
