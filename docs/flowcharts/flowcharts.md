# Mesh VPN Project — Architecture Flowcharts

> **Note**: The Data Plane and Control Plane diagrams below mirror the original Canva flowchart, which reflects the **pre-pivot architecture** (access/exit node hosted at the business site). After the Saturday pivot, the access/exit node lives at home. These two diagrams need content updates — but the Mermaid structure is in place to make those edits trivial.

---

## Mesh Topology

```mermaid
flowchart TD
    AEN[Access/Exit Node]
    WL[Win 10 Laptop]
    WP[Win 10 PC]
    WG[Win 11 Gaming PC]
    MN[Master Node]

    AEN <--> WL
    AEN <--> WP
    AEN <--> WG
    MN <--> WL
    MN <--> WP
    MN <--> WG
```

---

## Data Plane — Outbound Traffic

```mermaid
flowchart LR
    LAPTOP["Laptop<br/>(encrypted)"] --> BR[Business Router]
    BR --> INET1["Internet<br/>(encrypted)"]
    INET1 --> HR1[Home Router]
    HR1 --> AEP["Access/Exit Pi<br/>(decrypts)"]
    AEP --> HR2[Home Router]
    HR2 --> INET2["Internet<br/>(unencrypted)"]
    INET2 --> DEST[Destination]
```

---

## Data Plane — Inbound Traffic

```mermaid
flowchart LR
    ORIG["Origin<br/>(encrypted)"] --> INET1["Internet<br/>(encrypted)"]
    INET1 --> HR1[Home Router]
    HR1 --> AEP["Access/Exit Pi<br/>(decrypts → re-encrypts)"]
    AEP --> HR2[Home Router]
    HR2 --> INET2["Internet<br/>(encrypted)"]
    INET2 --> BR[Business Router]
    BR --> LAPTOP[Laptop]
```

---

## Control Plane

```mermaid
flowchart TD
    ADMIN[Admin SSH] --> MASTER[Master]
    MASTER <--> AEP[Access/Exit Pi]
    MASTER <--> OL[Old Laptop]
    MASTER <--> GP[Gaming PC]
    MASTER <--> OPC[Old PC]

    classDef business stroke:#8B4513,stroke-width:3px
    classDef home stroke:#DAA520,stroke-width:3px

    class MASTER,AEP business
    class OL,GP,OPC home
```

**Legend**
- Brown outline = connection at business site
- Yellow outline = connection at home site

---

## Git Workflow

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
