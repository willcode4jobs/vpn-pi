```mermaid
gantt
    title v4 Network Architecture Project Schedule (May 8 - Aug 12)
    dateFormat  YYYY-MM-DD
    axisFormat  %b-%d
    todayMarker off
    
    section Foundation
    A. Vega exit + routing      :a, 2026-05-08, 5d
    B. Arch v4 + flowcharts     :b, 2026-05-08, 4d
    
    section Core Prototype
    C. Routing prototype        :c, after a, 21d
    
    section Expansion Buildout
    D. Endpoint fleet           :d, after c, 14d
    E. GUI (Self-Serve)         :e, after c, 23d
    F. IDS Build                :f, after c, 16d
    
    section Wrap-Up
    G. Hardening                :g, after e, 7d
    H. Buffer                   :h, after g, 8d
    I. Final package + demo     :i, after h, 4d
```