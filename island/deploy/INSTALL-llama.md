# INSTALL — Llama for the internet gate (follow-along)

A hands-on, step-by-step guide for the **one operator** setting up vega's gate model.
Island members never do this — it's a once-per-deployment task. It picks up right
where Meta's `llama` CLI download leaves off.

> This is the **Meta-direct** route (highest provenance: you convert Meta's own
> weights yourself). It's the most involved path. If at any point it fights you, the
> "Lighter route" at the bottom gets a working model in minutes. For the design and
> the security model, see [`RUNBOOK-llama.md`](RUNBOOK-llama.md).

---

## What you're aiming for

The gate needs **one `.gguf` file**, served by **llama.cpp's `llama-server`** on vega
(islandd calls its `/completion` endpoint). Everything below is just: turn Meta's
download into a `.gguf`, get it onto vega, run it.

**Two machines:**
- **Build machine** (your Mac — has internet, did the download). Heavy work happens here.
- **vega** (the Pi — sealed, no internet). Only *runs* the finished model.

> ⚠️ Do all of this **outside the git repo** (you've used `llama-dev`). Model files are
> multi-GB and license-gated; they must never be committed. The repo's `.gitignore`
> already blocks `*.gguf`, `*.safetensors`, `*.pth` as a backstop.

---

## What you have now

Meta's CLI gave you the **original** checkpoint format in your `llama-dev` folder:

```
consolidated.00.pth     # the weights
params.json             # the architecture
tokenizer.model         # the tokenizer
```

(`orig_params.json` "not found" is fine — it isn't used.) This is **not** a `.gguf`
yet, and llama.cpp's converter only reads **Hugging Face** format, so the path is:

```
Meta original (.pth)  ─►  Hugging Face format  ─►  GGUF (f16)  ─►  GGUF (quantized)  ─►  vega
       step 2                  step 2                 step 3          step 3            step 4
```

---

## Step 1 — Set up the conversion toolchain (build machine)

In your `llama-dev` working dir (outside the repo):

```bash
cd ~/llama-dev          # adjust to wherever llama-dev is

# llama.cpp gives you the GGUF converter + the quantizer
git clone --depth 1 https://github.com/ggml-org/llama.cpp
cmake -S llama.cpp -B llama.cpp/build -DCMAKE_BUILD_TYPE=Release
cmake --build llama.cpp/build -j --target llama-quantize

# python deps for the converters (numpy, torch, transformers, gguf, safetensors…)
python3 -m venv venv && source venv/bin/activate
pip install -r llama.cpp/requirements.txt
```

**You should see:** `llama.cpp/build/bin/llama-quantize` exists, and `pip` finishes
without errors. (The torch download is the slow part.)

---

## Step 2 — Meta original → Hugging Face format

The converter ships inside `transformers` (just installed). Locate and run it:

```bash
source ~/llama-dev/venv/bin/activate

SRC=~/llama-dev/Llama3.2-3B-Instruct      # the folder with consolidated.00.pth — ADJUST
HF=~/llama-dev/hf-3b-instruct             # output folder

CONV=$(python -c "import os,transformers;print(os.path.join(os.path.dirname(transformers.__file__),'models','llama','convert_llama_weights_to_hf.py'))")

python "$CONV" --input_dir "$SRC" --output_dir "$HF" --model_size 3B --llama_version 3.2 --instruct
```

**You should see:** `$HF` now contains `config.json` + `*.safetensors` +
tokenizer files.

> The flags vary by `transformers` version — some infer `--model_size`, some don't
> have `--instruct` / `--llama_version`. If it errors, run `python "$CONV" --help`,
> match the flags it lists, and retry. (For the 1B model use `--model_size 1B`.)

---

## Step 3 — Hugging Face → GGUF, then quantize

```bash
# HF -> a full-precision GGUF
python ~/llama-dev/llama.cpp/convert_hf_to_gguf.py "$HF" \
  --outfile ~/llama-dev/Llama-3.2-3B-Instruct-f16.gguf --outtype f16

# shrink it for the Pi (Q4_K_M ≈ 2 GB, plenty for an APPROVE/DENY gate)
~/llama-dev/llama.cpp/build/bin/llama-quantize \
  ~/llama-dev/Llama-3.2-3B-Instruct-f16.gguf \
  ~/llama-dev/Llama-3.2-3B-Instruct-Q4_K_M.gguf Q4_K_M
```

**You should see:** `Llama-3.2-3B-Instruct-Q4_K_M.gguf`. This is the only file vega
needs. You can delete the `-f16.gguf` and the `$HF` folder afterward.

---

## Step 4 — Ship it to vega

```bash
scp ~/llama-dev/Llama-3.2-3B-Instruct-Q4_K_M.gguf  <user>@10.42.0.2:/tmp/
```

(10.42.0.2 = vega over wg0.)

---

## Step 5 — Run it on vega (the only part that runs there)

vega has no internet, but it doesn't need any now — the model is local. Build
`llama-server` once, place the model, run it as a **loopback-only** service.

```bash
# on vega
sudo apt update && sudo apt install -y build-essential cmake git libcurl4-openssl-dev
git clone --depth 1 https://github.com/ggml-org/llama.cpp
cmake -S llama.cpp -B llama.cpp/build -DCMAKE_BUILD_TYPE=Release
cmake --build llama.cpp/build -j --target llama-server
sudo install -o root -g root -m 0755 llama.cpp/build/bin/llama-server /usr/local/bin/llama-server

# place the model where islandd's user can read it
sudo install -d -o islandd -g islandd /var/lib/islandd/models
sudo install -o islandd -g islandd -m 0644 /tmp/Llama-3.2-3B-Instruct-Q4_K_M.gguf /var/lib/islandd/models/
```

Create `/etc/systemd/system/llama-gate.service`:

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
journalctl -u llama-gate -f          # watch it load the model
```

**Loopback only (`127.0.0.1`) is deliberate** — the gate model must not be reachable
from the mesh, only by islandd on the same box.

---

## Step 6 — Wire islandd to it

In vega's `/etc/islandd/islandd.env`:

```ini
ISLAND_LLAMA_URL=http://127.0.0.1:8080
ISLAND_CANARY_KEYWORD=GREEN18
```

```bash
sudo systemctl restart islandd
```

---

## Step 7 — Test it

```bash
# model answers, and obeys APPROVE/DENY:
curl -s http://127.0.0.1:8080/completion -H 'content-type: application/json' \
  -d '{"prompt":"You are the island internet gate. Reply APPROVE or DENY then a short reason.\nRequest: GREEN18 open the gate\nDecision:","n_predict":32,"temperature":0}'

# full path: send a real canary from the admin app -> gate flips to "internet" ~45 min
curl -s http://127.0.0.1:8787/api/gate
```

If the first command returns text containing `APPROVE`, the model works. If the gate
still won't open, check `journalctl -u islandd` and `journalctl -u llama-gate`.

---

## Lighter route (if the Meta conversion fights you)

The conversion (Step 2 especially) is the fragile part. If you'd rather not wrestle
it, skip Steps 1–3 and get a ready-made GGUF — vega's gate only needs *a* small
Instruct model, it doesn't care who quantized it:

- **One command, on the build machine:** download a community `Llama-3.2-3B-Instruct`
  **GGUF** file (Hugging Face Files tab in a browser, or `huggingface-cli download`),
  then jump to **Step 4**.
- Tradeoff: you're trusting whoever quantized it rather than converting Meta's own
  weights. For a model whose only job is to say APPROVE/DENY, that's usually fine —
  the *crypto* is the real gate; Llama is only a refusal layer.

---

## See also

- [`RUNBOOK-llama.md`](RUNBOOK-llama.md) — design, security model, hardening, code
  tweaks (timeout + grammar-constrained output) worth making to `LlamaHttp`.
- [`RUNBOOK-gate.md`](RUNBOOK-gate.md) — the privileged egress helper + admin keypair
  that the gate also needs.
