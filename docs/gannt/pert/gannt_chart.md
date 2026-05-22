```mermaid
gantt
    title v4 Network Architecture Project Schedule (May 8 - Aug 12)
    dateFormat  YYYY-MM-DD
    axisFormat  %b-%d
    todayMarker off

    section Foundation
    A    :a, 2026-05-08, 7d
    B    :b, 2026-05-08, 6d

    section Core Prototype
    C    :c, after a, 29d

    section Expansion Buildout
    D    :d, after c, 20d
    E    :e, after c, 32d
    F    :f, after c, 23d

    section Wrap-Up
    G    :g, after e, 9d
    H    :h, after g, 13d
    I    :i, after h, 6d
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
