# RUNBOOK — deploy the fine-tuned gate model to vega

Turn a trained LoRA adapter (that passed `eval_adapter.py`, ≥ ~95%) into a GGUF, get it
serving on vega, and fire the canary. Prereq: the adapter is good — see
[`RUNBOOK-train-gate-model.md`](RUNBOOK-train-gate-model.md).

## Conventions — read once

- **Two machines.** Commands are grouped **ON BUILDER** (the Mac, `~/gate-train`) and
  **ON VEGA** (after `ssh <user>@10.42.0.2`). Run each group on the machine in its header —
  no `ssh '…'` wrapping.
- **`sudo` for anything under `/var/lib/islandd/`** — it's owned by the `islandd` service
  user, not your login. Plain `ls`/`cp` there fails with *Permission denied*.
- **Run commands one line at a time.** Don't paste multi-line `\`-continued blocks into a
  shell — the indentation turns into a stray space and breaks the path.
- **`/tmp` on vega is a RAM disk (tmpfs).** Moving a file from `/tmp` to `/var/lib` is a
  real ~1.9 G copy to the SD card — it takes 30 s–2 min and looks like it's hanging. It
  isn't. It also needs ~1.9 G free on the card (watch for a full disk).

---

## Part A — Build the GGUF  (ON BUILDER)

```bash
cd ~/gate-train
```
Fuse the adapter into the weights:
```bash
mlx_lm.fuse --model meta-llama/Llama-3.2-3B-Instruct --adapter-path ./adapters --save-path ./gate-3b-fused
```
Fix the tokenizer config the converter rejects (copy the base model's clean tokenizer in — fuse only changed weights):
```bash
BASE=$(dirname "$(find ~/.cache/huggingface/hub/models--meta-llama--Llama-3.2-3B-Instruct -name tokenizer.json 2>/dev/null | head -1)")
cp "$BASE/tokenizer.json" "$BASE/tokenizer_config.json" "$BASE/special_tokens_map.json" ./gate-3b-fused/
```
Convert → GGUF → quantize (needs torch — `pip install -r ~/llama-dev/llama.cpp/requirements.txt` if not already):
```bash
python ~/llama-dev/llama.cpp/convert_hf_to_gguf.py ./gate-3b-fused --outfile gate-3b-f16.gguf --outtype f16
~/llama-dev/llama.cpp/build/bin/llama-quantize gate-3b-f16.gguf gate-3b-Q4_K_M.gguf Q4_K_M
ls -lh gate-3b-Q4_K_M.gguf
```
Ship it to vega's `/tmp`:
```bash
rsync -avP gate-3b-Q4_K_M.gguf <user>@10.42.0.2:/tmp/
```

---

## Part B — Place the model  (ON VEGA — `ssh <user>@10.42.0.2` first)

Check disk + see the real model filename and what the service loads:
```bash
df -h /var/lib/islandd
sudo ls -lh /var/lib/islandd/models/
systemctl cat llama-gate | grep -- --model
```
The `--model` line is the file you must replace. Below assumes `Llama-3.2-3B-Instruct-Q4_K_M.gguf`; substitute the real name if different.

Free space if the card is tight (drop stale models / truncated backups):
```bash
sudo rm -f /var/lib/islandd/models/*.bak
```
Back up the current model by **rename** (instant, no extra space — unlike `cp`, which needs a second 1.9 G and fails on a full disk):
```bash
sudo mv /var/lib/islandd/models/Llama-3.2-3B-Instruct-Q4_K_M.gguf /var/lib/islandd/models/Llama-3.2-3B-Instruct-Q4_K_M.gguf.bak
```
Move the new model into place (this is the slow ~1.9 G copy off the RAM disk — wait for the prompt):
```bash
sudo mv /tmp/gate-3b-Q4_K_M.gguf /var/lib/islandd/models/Llama-3.2-3B-Instruct-Q4_K_M.gguf
```
Fix ownership (it arrived as your user; `llama-gate` runs as `islandd`):
```bash
sudo chown islandd:islandd /var/lib/islandd/models/Llama-3.2-3B-Instruct-Q4_K_M.gguf
sudo chmod 644 /var/lib/islandd/models/Llama-3.2-3B-Instruct-Q4_K_M.gguf
```
Restart and confirm it loaded:
```bash
sudo systemctl restart llama-gate
sleep 3
systemctl is-active llama-gate
```
`active` = loaded. Verify it answers right (neutral prompt + grammar = exactly the gate):
```bash
cat > /tmp/gatetest.json <<'JSON'
{"prompt":"Decide whether the user wants to turn on internet access. Answer YES if the message asks to open, enable, allow, or turn on internet or network access. Answer NO if it asks to keep it off, is about something else, or is nonsense.\nUser: open the gate to the internet\nAnswer:","n_predict":4,"temperature":0,"grammar":"root ::= \"YES\" | \"NO\""}
JSON
curl -s http://127.0.0.1:8080/completion -H 'content-type: application/json' -d @/tmp/gatetest.json
```
Expect `"content":"YES"`. (Swap the `User:` line to `keep the island sealed` → `"NO"`.)

---

## Part C — Update islandd's prompt  (ON BUILDER)

vega must send the **neutral YES/NO prompt** the model was trained on — it lives in the
`islandd` binary, so rebuild + redeploy:
```bash
cd /Users/billyr/Desktop/projects/initfolder/vpn-pi/island
bun run typecheck && bun test && bun run build:arm64
deploy/push.sh <user>@10.42.0.2 dist/islandd-arm64
```
(`push.sh` preserves identity, admin token, and `/etc/islandd/islandd.env`.)

---

## Part D — Fire the canary  (ON BUILDER)

Grab vega's keys first (ON VEGA): `sudo cat /var/lib/islandd/identity/x25519.pub` and `sudo cat /var/lib/islandd/admin.token`. Then:
```bash
bun run src/main.ts canary --admin-dir ~/island-admin --to-x25519 '<vega x25519>' --text "GREEN18 open the gate" --send http://10.42.0.2:8787 --admin-token '<vega admin token>'
```
Expect `Gate opened — YES`. Confirm: `curl 10.42.0.2:8787/api/gate` → `internet` with a `closes_at` ~45 min out. Then the negative tests (bad signer → 403, replay → rejected, "keep the island sealed" → denied).

---

## Rollback  (ON VEGA)

If the new model fails to load (`is-active` = `failed`, or `journalctl -u llama-gate` shows `invalid magic`/`unexpected EOF` = truncated copy / full disk):
```bash
sudo mv /var/lib/islandd/models/Llama-3.2-3B-Instruct-Q4_K_M.gguf.bak /var/lib/islandd/models/Llama-3.2-3B-Instruct-Q4_K_M.gguf
sudo systemctl restart llama-gate
journalctl -u llama-gate -n 20 --no-pager
```

## Cleanup  (ON VEGA, once the new model is proven)

```bash
rm -f /tmp/gatetest.json
sudo rm -f /var/lib/islandd/models/Llama-3.2-3B-Instruct-Q4_K_M.gguf.bak
```

---

## Checklist

- [ ] (builder) fused → tokenizer copied → GGUF converted + quantized (~1.9 G) → rsync'd to vega `/tmp`
- [ ] (vega) disk has room; backed up current model by rename; moved new model in; chowned to `islandd`
- [ ] (vega) `llama-gate` `active`; direct curl: open → YES, sealed → NO
- [ ] (builder) islandd rebuilt + redeployed (neutral prompt live)
- [ ] (builder) canary opens (`YES` / `internet`); negative tests fail safe
