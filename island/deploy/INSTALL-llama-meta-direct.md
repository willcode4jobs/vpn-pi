# INSTALL — Llama gate model, **Meta-direct** (paranoid / max-provenance route)

The highest-provenance way to produce vega's gate model: take **Meta's own original
checkpoint**, convert and quantize it **yourself**, and verify the bytes at every hop.
You trust no community quantizer, no third-party GGUF, no pre-converted HF mirror —
only Meta's signed download and your own toolchain.

> If you don't need this level of provenance, use the lighter HF route in
> [`INSTALL-llama.md`](INSTALL-llama.md). This file is the deliberately-thorough one.
> Design + security model: [`RUNBOOK-llama.md`](RUNBOOK-llama.md). The egress helper +
> admin keypair the gate also needs: [`RUNBOOK-gate.md`](RUNBOOK-gate.md).

---

## What "paranoid" buys you (threat model)

This route defends against a **compromised distribution channel** — a tampered GGUF on
a model hub, a malicious quantizer, a mirror that swapped weights. By converting Meta's
own checkpoint and hashing the artifact through every step, the only thing you trust is
(a) Meta's signed download and (b) the open-source `llama.cpp` / `transformers` code you
can read.

It does **not** defend against a backdoored upstream (Meta itself) or a compromised
`llama.cpp` — read/pin those if that's in your model. And remember the architecture:
**the LLM is only a refusal layer; the canary crypto is the real gate** (see
[`RUNBOOK-llama.md`](RUNBOOK-llama.md)). Even a fully malicious model cannot open egress
without a valid admin-signed, vega-sealed canary.

---

## The chain

```
Meta original (.pth)  ─►  Hugging Face fmt  ─►  GGUF f16  ─►  GGUF Q4_K_M  ─►  vega
   verify checklist        convert script        convert       quantize        sha match
   sha256 the .pth                                                              both ends
```

**Two machines:**
- **Build machine** — your Mac. Internet + heavy CPU/RAM. Everything below runs here.
- **vega** — the Pi (arm64, 8 GB, wg0 `10.42.0.2`). Sealed, no internet. Only *runs* the
  finished model. Its `llama-server` is already built and installed — **do not rebuild
  it** (verify in Step 7).

> ⚠️ Do all of this **outside the git repo**, in `~/llama-dev`. Weights are multi-GB and
> license-gated and must never be committed. `.gitignore` blocks `*.gguf`,
> `*.safetensors`, `*.pth`, `models/` as a backstop — don't rely on it, just stay out.

---

## Step 0 — Prerequisites (build machine)

```bash
xcode-select --install              # git + clang (skip if already installed)
brew install cmake python@3.12      # cmake was the Step-2 blocker last time
mkdir -p ~/llama-dev && cd ~/llama-dev
```

> **Use Python 3.12 — not the newest, not the system one.** macOS ships a stub
> `/usr/bin/python3` (3.9, from the Command Line Tools) that shadows Homebrew in `PATH`,
> so a bare `python3` is often *older* than what you just installed. And the *newest*
> Python (3.13/3.14) usually has **no `torch`/`transformers` wheels yet**, so Step 2's
> `pip install` fails. 3.12 has broad wheel support and is the safe choice.
>
> Sidestep the whole `PATH` mess by creating every venv with the **explicit versioned
> interpreter** — once a venv is active, `python`/`pip` point at it regardless of system
> `PATH`. Find yours (Apple Silicon vs Intel) once:
>
> ```bash
> PY=$(brew --prefix python@3.12)/bin/python3.12   # e.g. /opt/homebrew/bin/python3.12
> "$PY" --version                                   # -> Python 3.12.x
> ```
>
> Every `python3 -m venv` below uses `"$PY"` instead of a bare `python3`.

---

## Step 1 — Re-acquire Meta's ORIGINAL checkpoint + verify it

The original weights are gone with the old machine, so pull them again from Meta. This
is the license-gated download — the root of the whole provenance chain. Flow: accept the
license → download Meta's original-format checkpoint → verify it against Meta's checksums.

There are three ways to get the **same Meta bytes**; pick one. The recommended one
(1c, Meta's gated HuggingFace repo) is the most reliable. The pure-Meta-CDN route
(1d, signed URL) is for maximum paranoia. Either way you end up with the same four files
and verify them identically in 1e.

### 1a — Accept the Llama 3.2 license (browser, one-time)

You only need to accept it on whichever platform you download from:

- **For 1c (HuggingFace):** open <https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct>,
  sign in, and submit the access request on that page (it shows Meta's Community License).
  Approval is usually quick (minutes to a few hours).
- **For 1d (Meta CDN):** go to <https://www.llama.com/llama-downloads/>, fill the form
  (use a readable email), tick **Llama 3.2 (1B & 3B)**, accept the license. Meta emails
  you a **pre-signed URL** (`https://...llamameta.net/...?Policy=...&Signature=...`), valid
  ~24h, limited downloads — don't burn it on failed attempts.

### 1c — Download from Meta's gated HF repo  ✅ recommended

> ⚠️ The doc used to use `llama model download` (the `llama-stack` CLI). **Recent
> `llama-stack` removed those subcommands** — you'll hit
> `error: argument {stack}: invalid choice: 'model'`. So we don't use that CLI anymore.

Meta mirrors the **exact original-format checkpoint** in an `original/` subfolder of its
own HF repo — same `.pth`, same `checklist.chk`, license-gated by Meta. This is still
Meta-direct, just over a reliable transport.

```bash
brew install huggingface-cli       # if not already present
hf auth login                      # paste a HF read token (huggingface.co → Settings → Tokens)

hf download meta-llama/Llama-3.2-3B-Instruct \
  --include "original/*" \
  --local-dir ~/llama-dev/Llama3.2-3B-Instruct
```

You now have Meta's **original** format under
`~/llama-dev/Llama3.2-3B-Instruct/original/`:

```
consolidated.00.pth     # the weights
params.json             # the architecture
tokenizer.model         # the tokenizer
checklist.chk           # Meta's checksums  <-- the paranoid's anchor
```

### 1d — Alternative: pure Meta-CDN via `download.sh` (max paranoia)

If you want the bytes straight from Meta's CDN (no HF in the path), use Meta's official
`download.sh` with the signed URL from 1a. No Python needed:

```bash
cd ~/llama-dev
git clone https://github.com/meta-llama/llama-models
cd llama-models/models/llama3_2 && ./download.sh
```

It prompts for: (1) **the signed URL** — paste the whole thing from the email; (2) **which
models** — type the **3B Instruct** option exactly as the on-screen menu labels it. It
writes the same four files into a `Llama3.2-3B-Instruct/` subfolder.

> Still want the old `llama` CLI? It only exists in **older `llama-stack`** releases —
> `pip install 'llama-stack<0.1'` *may* restore `llama model download`, but version-hunting
> is brittle; prefer 1c or `download.sh`.

### 1e — Verify against Meta's checklist BEFORE converting

```bash
SRC=~/llama-dev/Llama3.2-3B-Instruct/original   # 1c path. download.sh: ~/llama-dev/llama-models/models/llama3_2/Llama3.2-3B-Instruct
cd "$SRC"
md5sum -c checklist.chk        # macOS: `brew install coreutils` for md5sum (or `md5 <file>` and compare by hand)
```

Every line must say `OK`. If any file fails, **stop** — re-download; do not convert a
checkpoint that doesn't match Meta's checksums. Then record the weights hash for your own
audit trail:

```bash
shasum -a 256 consolidated.00.pth | tee ~/llama-dev/provenance.txt
```

---

## Step 2 — Build the conversion toolchain

```bash
cd ~/llama-dev
git clone --depth 1 https://github.com/ggml-org/llama.cpp
cmake -S llama.cpp -B llama.cpp/build -DCMAKE_BUILD_TYPE=Release
cmake --build llama.cpp/build -j --target llama-quantize     # the only compiled tool we need

"$PY" -m venv venv && source venv/bin/activate               # $PY = python3.12 from Step 0
python --version                                             # sanity: -> Python 3.12.x
pip install -r llama.cpp/requirements.txt                    # numpy, torch, gguf, safetensors…
```

> Paranoid extra: pin `llama.cpp` to a specific tag/commit instead of `--depth 1` of
> `main`, and record the commit in `provenance.txt`, so the toolchain itself is
> reproducible:
> `git -C llama.cpp rev-parse HEAD >> ~/llama-dev/provenance.txt`

---

## Step 3 — Meta original (`.pth`) → Hugging Face format

This is the step that fought us before: modern `transformers` wheels **no longer ship**
`convert_llama_weights_to_hf.py`, and the version-tagged GitHub URL 404'd. The fix is to
**pin a transformers version that supports Llama 3.2** and fetch the **matching** script
by its release tag (the script imports from `transformers`, so versions must agree).

```bash
source ~/llama-dev/venv/bin/activate
pip install 'transformers==4.46.3'        # supports Llama 3.2; known-good with the script below

cd ~/llama-dev
curl -fL -o convert_llama_weights_to_hf.py \
  https://raw.githubusercontent.com/huggingface/transformers/v4.46.3/src/transformers/models/llama/convert_llama_weights_to_hf.py
# -f makes curl FAIL on a 404 instead of saving an HTML error page. If it 404s,
# the tag is wrong — list real tags: `git ls-remote --tags https://github.com/huggingface/transformers`

HF=~/llama-dev/hf-3b-instruct
python convert_llama_weights_to_hf.py \
  --input_dir "$SRC" --output_dir "$HF" \
  --model_size 3B --llama_version 3.2 --instruct
```

**You should see** `$HF` now holds `config.json`, `*.safetensors`, and tokenizer files.

> Flags drift between transformers versions. If it errors on a flag, run
> `python convert_llama_weights_to_hf.py --help`, match what it actually lists, and
> retry. (1B model → `--model_size 1B`.)

---

## Step 4 — Hugging Face → GGUF (f16)

```bash
source ~/llama-dev/venv/bin/activate
python ~/llama-dev/llama.cpp/convert_hf_to_gguf.py "$HF" \
  --outfile ~/llama-dev/Llama-3.2-3B-Instruct-f16.gguf --outtype f16
```

---

## Step 5 — Quantize → Q4_K_M (~2 GB, sized for the Pi)

```bash
~/llama-dev/llama.cpp/build/bin/llama-quantize \
  ~/llama-dev/Llama-3.2-3B-Instruct-f16.gguf \
  ~/llama-dev/Llama-3.2-3B-Instruct-Q4_K_M.gguf Q4_K_M

ls -lh ~/llama-dev/Llama-3.2-3B-Instruct-Q4_K_M.gguf   # expect ~2.0 GB
shasum -a 256 ~/llama-dev/Llama-3.2-3B-Instruct-Q4_K_M.gguf | tee -a ~/llama-dev/provenance.txt
```

**Record that hash — it's what you'll match on vega.** A correct file is ~2.0 GB; the
last transfer truncated to 1.1 GB, which is exactly the failure this hash check catches.

> Optional local smoke test before shipping (if you built `llama-server` on the Mac too,
> or `brew install llama.cpp`): run it on the f16/Q4 and curl `/completion` for `APPROVE`.

---

## Step 6 — Quick local sanity (optional but recommended)

Confirm the artifact loads and answers before you spend a slow tunnel transfer on it.
Easiest: `brew install llama.cpp`, then:

```bash
llama-server --model ~/llama-dev/Llama-3.2-3B-Instruct-Q4_K_M.gguf \
  --host 127.0.0.1 --port 8080 --ctx-size 1024 --no-webui &
curl -s http://127.0.0.1:8080/completion -H 'content-type: application/json' \
  -d '{"prompt":"You are the island internet gate. Reply APPROVE or DENY then a short reason.\nRequest: GREEN18 open the gate\nDecision:","n_predict":32,"temperature":0}'
kill %1
```

`APPROVE` in the output = the model is good. A truncated/corrupt GGUF fails to load here.

---

## Step 7 — Ship to vega, matching hashes at both ends

vega's `llama-server` is already installed — confirm, don't rebuild:

```bash
ssh <user>@10.42.0.2 '/usr/local/bin/llama-server --version'   # expect a version line, aarch64
```

Send the model to `/tmp` first (so a bad transfer can't clobber the placed copy). The wg
tunnel is slow and is what truncated the file last time — prefer vega's **LAN IP** to
skip wg, or add a lighter cipher; `-P` resumes if it drops, so just re-run on failure:

```bash
rsync -avP ~/llama-dev/Llama-3.2-3B-Instruct-Q4_K_M.gguf <user>@10.42.0.2:/tmp/
# slow/dropping over wg?  use vega's LAN IP, or:
# rsync -avP -e 'ssh -c aes128-gcm@openssh.com' ~/llama-dev/Llama-3.2-3B-Instruct-Q4_K_M.gguf <user>@10.42.0.2:/tmp/
```

**Match the hash on vega against the one in `provenance.txt` — this is the whole point:**

```bash
ssh <user>@10.42.0.2 'sha256sum /tmp/Llama-3.2-3B-Instruct-Q4_K_M.gguf'
# must EQUAL the shasum -a 256 value from Step 5. If not, the transfer corrupted it — re-send.
```

Only once the hashes match, place it where islandd's user can read it:

```bash
ssh <user>@10.42.0.2 '
  sudo install -d -o islandd -g islandd /var/lib/islandd/models &&
  sudo install -o islandd -g islandd -m 0644 /tmp/Llama-3.2-3B-Instruct-Q4_K_M.gguf /var/lib/islandd/models/ &&
  sha256sum /var/lib/islandd/models/Llama-3.2-3B-Instruct-Q4_K_M.gguf &&
  shred -u /tmp/Llama-3.2-3B-Instruct-Q4_K_M.gguf   # remove the /tmp copy
'
```

> No `islandd` user (personal-node setup)? Use your own login for `User=`/ownership and a
> path you own, and drop `ReadOnlyPaths` in the unit below.

---

## Step 8 — Run it as a hardened, loopback-only service

Create `/etc/systemd/system/llama-gate.service` on vega:

```ini
[Unit]
Description=llama.cpp server — island internet-gate policy model
After=network.target

[Service]
User=islandd
Group=islandd
ExecStart=/usr/local/bin/llama-server \
  --model /var/lib/islandd/models/Llama-3.2-3B-Instruct-Q4_K_M.gguf \
  --host 127.0.0.1 --port 8080 \
  --ctx-size 1024 --threads 4 --no-webui
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadOnlyPaths=/var/lib/islandd/models
RestrictAddressFamilies=AF_INET AF_UNIX

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now llama-gate
journalctl -u llama-gate -f          # wait for "model loaded" / listening, then Ctrl-C
```

**Loopback-only (`127.0.0.1`) is deliberate** — the model must be reachable only by
islandd on the same box, never from the mesh.

---

## Step 9 — Wire islandd + test

`/etc/islandd/islandd.env` on vega:

```ini
ISLAND_LLAMA_URL=http://127.0.0.1:8080
ISLAND_CANARY_KEYWORD=GREEN18
```

```bash
sudo systemctl restart islandd

# model answers and obeys APPROVE/DENY:
curl -s http://127.0.0.1:8080/completion -H 'content-type: application/json' \
  -d '{"prompt":"You are the island internet gate. Reply APPROVE or DENY then a short reason.\nRequest: GREEN18 open the gate\nDecision:","n_predict":32,"temperature":0}'

# full path: a real canary from the admin app flips the gate to "internet" for ~45 min:
curl -s http://127.0.0.1:8787/api/gate
```

`APPROVE` in the first output = the gate's brain is live. If the gate still won't open,
check `journalctl -u islandd` and `journalctl -u llama-gate`. The egress toggle itself
(nftables helper + admin pubkey) is [`RUNBOOK-gate.md`](RUNBOOK-gate.md).

---

## Step 10 — Clean up (keep vega hardened)

vega is a hardened node and must not keep a model-building or download toolchain. On the
build machine, once vega is serving, you can delete the intermediates and keep only the
provenance record:

```bash
rm -f  ~/llama-dev/Llama-3.2-3B-Instruct-f16.gguf
rm -rf ~/llama-dev/hf-3b-instruct
# keep: provenance.txt, the original $SRC checkpoint (re-verifiable), the final Q4_K_M
```

---

## Provenance checklist (the paranoid's receipt)

- [ ] Meta original downloaded via the signed `llama` CLI URL.
- [ ] `md5sum -c checklist.chk` → all `OK`.
- [ ] `consolidated.00.pth` sha256 recorded in `provenance.txt`.
- [ ] `llama.cpp` pinned commit recorded.
- [ ] `transformers` version pinned; convert script fetched by matching tag (`-f`, no HTML).
- [ ] Final Q4_K_M sha256 recorded.
- [ ] Local load/`APPROVE` smoke test passed.
- [ ] sha256 on vega **equals** the build-machine sha256.
- [ ] `/tmp` copy shredded; model owned `islandd:islandd 0644`; service loopback-only.
- [ ] Build/download toolchain removed from vega; no weights committed to git.
