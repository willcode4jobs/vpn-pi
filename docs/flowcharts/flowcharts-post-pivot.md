# Mesh VPN Project — Architecture Flowcharts (Post-Pivot)

> **Architecture pivot status**: Committed. The home network is now the public-facing site (port-forwarded UDP 51820 → vega). The business network hosts office endpoints that connect outbound only.
>
> Endpoint placement (sirius/altair/arcturus across home vs office) is TBD; the assignments below assume 2 at home + 1 at office. Adjust as planning finalizes.

---

## Mesh Topology

```mermaid
flowchart TD
    VEGA[vega — Access/Exit]
    POLARIS[polaris — Master]
    SIRIUS[sirius]
    ALTAIR[altair]
    ARCTURUS[arcturus]

    POLARIS <--> VEGA
    VEGA <--> SIRIUS
    VEGA <--> ALTAIR
    VEGA <--> ARCTURUS
    POLARIS <--> SIRIUS
    POLARIS <--> ALTAIR
    POLARIS <--> ARCTURUS

    classDef home stroke:#DAA520,stroke-width:3px
    classDef office stroke:#8B4513,stroke-width:3px

    class POLARIS,VEGA,SIRIUS,ALTAIR home
    class ARCTURUS office
```

---

## Data Plane — Outbound Traffic

*Scenario: an endpoint at the office wants to reach a destination on the internet, exiting through home.*

```mermaid
flowchart LR
    EP["Endpoint at office<br/>(WG-encrypted)"] --> OR[Office Router]
    OR --> INET1["Internet<br/>(encrypted)"]
    INET1 --> HRI["Home Router<br/>(UDP 51820 forwarded)"]
    HRI --> VEGA["vega — Access/Exit<br/>(decrypts)"]
    VEGA --> HRO[Home Router]
    HRO --> INET2["Internet<br/>(unencrypted)"]
    INET2 --> DEST[Destination]
```

---

## Data Plane — Inbound Traffic

*Scenario: response from the destination travels back to the office endpoint.*

```mermaid
flowchart LR
    DEST[Destination] --> INET1["Internet<br/>(unencrypted)"]
    INET1 --> HRI[Home Router]
    HRI --> VEGA["vega — Access/Exit<br/>(encrypts to tunnel)"]
    VEGA --> HRO[Home Router]
    HRO --> INET2["Internet<br/>(encrypted)"]
    INET2 --> OR[Office Router]
    OR --> EP["Endpoint at office<br/>(WG-decrypts)"]
```

---

## Control Plane

```mermaid
flowchart TD
    ADMIN[Admin SSH] --> POLARIS[polaris — Master]
    POLARIS <--> VEGA[vega — Access/Exit]
    POLARIS <--> SIRIUS[sirius]
    POLARIS <--> ALTAIR[altair]
    POLARIS <--> ARCTURUS[arcturus]

    classDef home stroke:#DAA520,stroke-width:3px
    classDef office stroke:#8B4513,stroke-width:3px

    class POLARIS,VEGA,SIRIUS,ALTAIR home
    class ARCTURUS office
```

**Legend**
- Yellow outline = at home network (public-facing site)
- Brown outline = at office network (endpoint-only, no inbound exposure)

---

## Git Workflow

*(Architecture-agnostic — same as pre-pivot.)*

```mermaid
flowchart TD
    A[Prefix/Branch Naming] --> B[Publish Branch]
    B --> C[Make Changes]
    C --> D["git add .<br/>or git add filename<br/>update .gitignore"]
    D --> E["git commit -m 'prefix: message'"]
    E --> F[Push]
    F --> G[Create Pull Request]
    G --> H[Review Conflicts]
    H --> I[Approve → squash & merge]
```
