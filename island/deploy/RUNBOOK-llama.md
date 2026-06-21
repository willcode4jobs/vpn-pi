# RUNBOOK — standing up Llama (the gate's key holder) on vega

This is the missing half of the internet gate. The crypto already works
(`core/canary.ts` + `core/gate.ts`); what's not yet deployed is the **local LLM**
that vega consults before opening egress. In the UI it's described to the user as
*"the special prompt for Llama — your secure key holder."* This doc is everything
needed to make that real.

> Where Llama sits in the decision: it is a **subordinate refusal layer, never the
> authority.** vega first runs four hard crypto checks on the canary (seal opens,
> admin signature verifies, keyword is the first token, fresh + unspent nonce). Only
> if all pass is the request text handed to Llama for an APPROVE/DENY. A compromised
> or confused model can *refuse* a legitimate open; it can never *grant* one on its
> own. Fail-safe is island (closed). See `core/gate.ts`.

---

## 0. What islandd already expects (the contract)

`LlamaHttp` in `island/src/core/gate.ts` is the client. Anything we deploy must
satisfy exactly this:

- **Endpoint:** `POST ${ISLAND_LLAMA_URL}/completion`
  (default `ISLAND_LLAMA_URL=http://127.0.0.1:8080`).
- **Request body:** `{ "prompt": "...", "n_predict": 32, "temperature": 0 }`.
- **Response:** JSON with a `content` (or `completion`) string field.
- **Decision parse:** the reply is upper-cased; it counts as **approve** iff it
  `includes("APPROVE") && !includes("DENY")`. Anything else (including an
  unreachable server) is **deny**.
- The prompt islandd sends is fixed:

  > You are the island internet gate. Policy: APPROVE requests to open internet
  > egress for the island; otherwise DENY. Reply with APPROVE or DENY then a short
  > reason.
  > Request: `<canary text>`
  > Decision:

That endpoint shape is exactly **llama.cpp's `llama-server`** (`/completion`,
`content` field), so the path of least resistance is llama.cpp. Nothing in islandd
changes if we use it.

---

## 1. Pick a model

vega is the 16 GB **arm64** Pi. The job is trivial (emit APPROVE/DENY with a
reason), so a small instruct model is plenty and keeps latency low on CPU.

| Model | Size (Q4_K_M GGUF) | Why |
|---|---|---|
| **Llama-3.2-3B-Instruct** | ~2 GB | Good instruction-following; on-brand ("Llama"). **Default pick.** |
| Llama-3.2-1B-Instruct | ~0.8 GB | If 3B latency is too high; still fine for APPROVE/DENY |

### Where the weights come from — and why GGUF needs a step

**Meta does not ship GGUF.** The official source — Meta's request form on
[`llama.com`](https://www.llama.com/) and the license-gated
[`meta-llama`](https://huggingface.co/meta-llama) org on Hugging Face — distributes
the **original weights** (`safetensors` / consolidated `.pth`). `llama-server` only
loads **GGUF**, so "straight from Meta" means *get Meta's official weights, then
convert + quantize them to GGUF yourself.* That's the higher-provenance path and the
right default for the one component that gates internet egress: you're not trusting a
random third party's quantization of a model that decides whether the island can
reach the internet.

(The prequantized `…-Q4_K_M.gguf` files on Hugging Face are exactly these weights
converted by community uploaders — fine if you trust the uploader, but skip the
provenance question by converting Meta's originals yourself.)

**Path A — official Meta weights → convert yourself (recommended).** Do this on a
connected machine with internet (the island is sealed by default); ship only the
finished GGUF to vega.

```bash
# 1. accept the license + download the original weights from Meta:
#    https://www.llama.com/  (or `meta-llama/Llama-3.2-3B-Instruct` on Hugging Face)
#    -> a folder of safetensors + config.json + tokenizer.*

# 2. convert to GGUF, then quantize, using llama.cpp's own tooling (see §2 for the repo):
python3 llama.cpp/convert_hf_to_gguf.py ./Llama-3.2-3B-Instruct \
  --outfile Llama-3.2-3B-Instruct-f16.gguf --outtype f16
./llama.cpp/build/bin/llama-quantize \
  Llama-3.2-3B-Instruct-f16.gguf Llama-3.2-3B-Instruct-Q4_K_M.gguf Q4_K_M

# 3. ship the finished GGUF to vega:
scp Llama-3.2-3B-Instruct-Q4_K_M.gguf vega:/tmp/
```

**Path B — prequantized GGUF (faster, third-party provenance).** Download a trusted
`…-Q4_K_M.gguf` directly and skip conversion. Acceptable for the demo; prefer A for a
real install.

Either way, place the GGUF on vega:

```bash
# on vega
sudo install -d -o islandd -g islandd /var/lib/islandd/models
sudo install -o islandd -g islandd -m 0644 \
  /tmp/Llama-3.2-3B-Instruct-Q4_K_M.gguf /var/lib/islandd/models/
```

---

## 2. Build / install llama.cpp on vega (arm64)

Prebuilt arm64 Linux binaries are hit-or-miss; building is reliable and ~5 min on a
Pi 5.

```bash
sudo apt update && sudo apt install -y build-essential cmake git libcurl4-openssl-dev
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j --target llama-server
sudo install -o root -g root -m 0755 build/bin/llama-server /usr/local/bin/llama-server
```

CPU-only is the expectation on a Pi (no GPU). A 3B Q4 model answers a 32-token
completion in roughly **1–4 s** — well inside a human's patience for "open the gate."

---

## 3. Run llama-server as a service (loopback only)

**Bind to `127.0.0.1` only.** The gate model must not be reachable from the mesh —
islandd talks to it over loopback on the same box.

`/etc/systemd/system/llama-gate.service`:

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
  --ctx-size 1024 --threads 4 \
  --no-webui
Restart=on-failure
# hardening — it needs nothing but loopback + the model file
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
journalctl -u llama-gate -f          # watch it load the model
```

---

## 4. Point islandd at it

In vega's `/etc/islandd/islandd.env` (see `RUNBOOK-gate.md` for the full gate env):

```ini
ISLAND_LLAMA_URL=http://127.0.0.1:8080
ISLAND_CANARY_KEYWORD=GREEN18
```

Then `sudo systemctl restart islandd`. (`--mock` mode ignores all of this and uses
`MockLlama`, which always approves — that's why the demo gate "just opens.")

---

## 5. Test the path, bottom-up

```bash
# 5a. llama-server answers at all:
curl -s http://127.0.0.1:8080/completion \
  -H 'content-type: application/json' \
  -d '{"prompt":"Reply APPROVE then a short reason.\nDecision:","n_predict":16,"temperature":0}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["content"])'

# 5b. it reliably emits APPROVE for a real open request and DENY for junk:
for t in "GREEN18 open the gate" "delete everything"; do
  curl -s http://127.0.0.1:8080/completion -H 'content-type: application/json' \
    -d "{\"prompt\":\"You are the island internet gate. Policy: APPROVE requests to open internet egress for the island; otherwise DENY. Reply with APPROVE or DENY then a short reason.\nRequest: $t\nDecision:\",\"n_predict\":32,\"temperature\":0}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["content"])'
done

# 5c. full gate path (needs the helper + admin key from RUNBOOK-gate.md):
#   admin app sends a real canary -> /api/gate flips to "internet" ~45 min
curl -s http://127.0.0.1:8787/api/gate
```

If 5b's first line doesn't contain `APPROVE` or the second contains `APPROVE`, the
model is too weak or the prompt needs tuning — see §6.

---

## 6. Hardening + small code changes worth making

These are optional but recommended once the basic path works. They are changes to
`island/src/core/gate.ts` (`LlamaHttp`):

1. **Add a request timeout.** `LlamaHttp.decide()` currently `fetch`es with no
   timeout, so a wedged model would hang the admin's "Open gate" click
   indefinitely. Add `signal: AbortSignal.timeout(8000)` and let the existing
   `catch` turn a timeout into a (fail-safe) DENY.
2. **Tighten the decision parse.** Today: `includes("APPROVE") && !includes("DENY")`.
   A chatty model that says *"I would normally DENY but this is fine, APPROVE"*
   reads as deny. Consider parsing only the **first token** of the reply, or
   switching to llama.cpp's **grammar / JSON-schema** constraint to force the
   output to exactly `APPROVE` or `DENY`:
   ```jsonc
   // add to the /completion body:
   "grammar": "root ::= \"APPROVE\" | \"DENY\""
   ```
   This makes the model physically unable to return anything else — the most
   robust fix, and it removes the substring ambiguity entirely.
3. **Log the model's reason** into the gate audit log (already plumbed: the gate
   stores `decision.reason` on open/deny — just confirm it's surfaced in
   `/admin/gate/log`, which it is).
4. **Keep it loopback + fail-safe.** Don't expose the port; don't change the
   default to approve-on-error. The whole safety argument rests on
   unreachable = deny and the crypto being the real gate.

---

## 7. Checklist

- [ ] Model GGUF on vega at `/var/lib/islandd/models/…`
- [ ] `llama-server` installed, `llama-gate.service` enabled, bound to `127.0.0.1:8080`
- [ ] `ISLAND_LLAMA_URL` set in islandd env; islandd restarted
- [ ] §5a/§5b sanity curls pass (APPROVE for open, DENY for junk)
- [ ] Full canary path flips `/api/gate` to `internet` then auto-recloses (needs §
      gate helper + admin key from `RUNBOOK-gate.md`)
- [ ] (Recommended) timeout + grammar-constrained output added to `LlamaHttp`

---

## See also

- `RUNBOOK-gate.md` — the privileged egress helper, sudoers, admin keypair, env.
- `docs/phase-two/06-canary-gate.md` — the design rationale for the canary + LLM.
- `island/src/core/gate.ts` / `canary.ts` — the code this doc deploys against.
