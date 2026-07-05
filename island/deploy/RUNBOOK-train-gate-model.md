# RUNBOOK — fine-tune the gate model (Llama 3.2 3B → reliable YES/NO)

The stock 3B-Instruct refuses legit "open the gate" requests (its RLHF safety prior
dominates), so we **LoRA fine-tune it** into a narrow intent classifier:
**APPROVE** a genuine request to open the island's internet, **DENY** keep-closed /
unrelated / gibberish / malicious. The crypto (admin signature + seal + nonce) stays the
binding authority — this model only judges *intent*; it can never open the gate on its
own. Training runs on your Apple-Silicon Mac with **MLX**; the result is converted to
GGUF and dropped onto vega exactly like the base model.

> Model pipeline reference: [`INSTALL-llama-meta-direct.md`](INSTALL-llama-meta-direct.md).
> Inference contract: [`../src/core/gate.ts`](../src/core/gate.ts) `LlamaHttp.decide`.

---

## ⚠️ The prompt is a contract

The fine-tune only transfers if **inference uses the same prompt it was trained on.** The
training prompt lives in `gate-training/make_dataset.py` as `SYSTEM`, and `gate.ts` must
send the identical text. Step 6 updates `gate.ts` to match. Change one → change both.

---

## Step 0 — Prereqs (Mac, in the python 3.12 venv)

```bash
PY=$(brew --prefix python@3.12)/bin/python3.12
"$PY" -m venv ~/gate-train/venv && source ~/gate-train/venv/bin/activate
pip install mlx-lm
hf auth login          # base model is gated (you already have access)
```

Work in a scratch dir **outside the repo** (datasets/adapters/models are multi-GB):

```bash
cd ~/gate-train
SRC=/Users/billyr/Desktop/projects/initfolder/vpn-pi/island/deploy/gate-training
cp "$SRC"/make_dataset.py "$SRC"/lora.yaml "$SRC"/eval_adapter.py .
```

## Step 1 — Generate the dataset

```bash
python make_dataset.py          # → gate-data/{train,valid}.jsonl + gate-data/test.jsonl
head -2 gate-data/train.jsonl   # eyeball: {"prompt":"…\nUser: …\nAnswer:","completion":" YES"}
```

v2 dataset: ~700 APPROVE / ~700 DENY (natural language + templated), with curated **hard
negatives** (non-internet "open X", questions, deferred, unrelated, gibberish, malicious)
so the model learns "open ≠ always approve." `test.jsonl` is **held out** (unseen
phrasings) for Step 3's accuracy check.

> v1 (small, fully templated) trained weak — too few examples and no boundary cases. If
> the fine-tune is still weak, the fix is almost always **more/more-diverse data here**,
> then the stronger config below.

## Step 2 — LoRA fine-tune (MLX, stronger config)

```bash
mlx_lm.lora --config lora.yaml --train --data ./gate-data --adapter-path ./adapters
```

`lora.yaml` raises the capacity/training that kept v1 weak: **iters 1500, batch 8,
num_layers 16, lr 5e-5, LoRA rank 16** (vs the rank-8 defaults). Watch **validation loss**
fall and flatten. CLI flags override the file, so you can still `--iters 2500` etc.

## Step 3 — Measure on the held-out test set (objective, not eyeballing)

```bash
python eval_adapter.py          # base + adapter over gate-data/test.jsonl → accuracy + every miss
```

Aim for **≥ ~95%** on the held-out set. For each miss it prints the request and what it
got — **add 5–10 examples of that phrasing (correct label) to `make_dataset.py`,
regenerate, retrain.** Iterate at the *adapter* stage — it's far faster than the
fuse→GGUF→deploy round-trip. Quick manual spot-check too:

```bash
mlx_lm.generate --model meta-llama/Llama-3.2-3B-Instruct --adapter-path ./adapters \
  --max-tokens 3 --prompt "$(python -c "import make_dataset as m; print(m.prompt('let us reach the web for a bit'))")"
# expect YES
```

## Step 4 — Fuse the adapter into the weights

```bash
mlx_lm.fuse \
  --model meta-llama/Llama-3.2-3B-Instruct \
  --adapter-path ./adapters \
  --save-path ./gate-3b-fused          # full HF-format model with the LoRA baked in
```

## Step 5 — Convert → GGUF → quantize

Uses the llama.cpp tools from the meta-direct install (clone/build it if you haven't):

```bash
python ~/llama-dev/llama.cpp/convert_hf_to_gguf.py ./gate-3b-fused \
  --outfile gate-3b-f16.gguf --outtype f16
~/llama-dev/llama.cpp/build/bin/llama-quantize \
  gate-3b-f16.gguf gate-3b-Q4_K_M.gguf Q4_K_M
ls -lh gate-3b-Q4_K_M.gguf            # ~1.9–2.0 GB
```

## Step 6 — Align gate.ts to the training prompt, rebuild islandd

In `island/src/core/gate.ts` `LlamaHttp.decide`, the prompt + labels must equal the
dataset's `SYSTEM` + `\nUser: ${text}\nAnswer:` with **YES/NO**. This is already done (the
neutral framing — see below); shown here so the contract is explicit:

```ts
const prompt =
  "Decide whether the user wants to turn on internet access. " +
  "Answer YES if the message asks to open, enable, allow, or turn on internet or network access. " +
  "Answer NO if it asks to keep it off, is about something else, or is nonsense." +
  `\nUser: ${text}\nAnswer:`;
// body: { prompt, n_predict: 4, temperature: 0, grammar: 'root ::= "YES" | "NO"' };  YES → approve
```

> **Why neutral YES/NO, not APPROVE/DENY:** the "island internet gate / egress /
> authorized / approve" framing pattern-matched the model's safety prior and made it
> refuse legit opens regardless of training. Posing a plain YES/NO intent question
> sidesteps that. Crypto remains the real authority.

Then: `bun run typecheck && bun test && bun run build:arm64` and redeploy
([`RUNBOOK-vega-next.md`](RUNBOOK-vega-next.md)).

## Step 7 — Deploy the model to vega + restart

```bash
rsync -avP gate-3b-Q4_K_M.gguf <user>@10.42.0.2:/tmp/
ssh <user>@10.42.0.2 '
  sudo install -o islandd -g islandd -m 0644 /tmp/gate-3b-Q4_K_M.gguf /var/lib/islandd/models/ &&
  sudo sed -i "s#Llama-3.2-3B-Instruct-Q4_K_M.gguf#gate-3b-Q4_K_M.gguf#" /etc/systemd/system/llama-gate.service &&
  sudo systemctl daemon-reload && sudo systemctl restart llama-gate
'
```

> Or keep the filename and just overwrite the old gguf — then no unit edit needed. Keep
> the original model around until the fine-tune is proven.

## Step 8 — Verify on vega, then fire a real canary

```bash
# direct check (on vega): open-request → YES, keep-closed → NO  (use /tmp/gatetest.json
# from RUNBOOK-gate-troubleshooting.md for the full neutral prompt)
curl -s http://127.0.0.1:8080/completion -H 'content-type: application/json' \
  -d '{"prompt":"Decide whether the user wants to turn on internet access. Answer YES or NO.\nUser: open the gate to the internet\nAnswer:","n_predict":4,"temperature":0,"grammar":"root ::= \"YES\" | \"NO\""}'

# end-to-end (from builder): the canary should now OPEN:
bun run src/main.ts canary --admin-dir ~/island-admin --to-x25519 '<vega x25519>' \
  --text "GREEN18 open the gate" --send http://10.42.0.2:8787 --admin-token '<tok>'
```

Expected: `Gate opened — YES`, `/api/gate` → `internet`. Then run the negative tests
from [`RUNBOOK-gate-operational-test.md`](RUNBOOK-gate-operational-test.md) (bad signer →
403, replay → rejected, malicious text → NO).

---

## Iterating / improving

- **Misclassifies a phrasing?** Add 5–10 examples of it (right label) to
  `make_dataset.py`, regenerate, retrain, re-test the adapter (Step 3). Cheap.
- **Too lenient (approves junk)?** Add more DENY variety (gibberish, malicious compounds).
- **Too strict (denies legit)?** Add more APPROVE paraphrases.
- Keep the **grammar constraint** at inference regardless — fine-tune + grammar = a
  near-deterministic classifier.
- Datasets/adapters/`.gguf` stay **out of git** (`.gitignore` already blocks `*.gguf`;
  keep `gate-train/` outside the repo).

## What this does and doesn't change

- **Changes:** the model now reliably reads the canary's text as an open-signal and
  approves it; refuses non-signals.
- **Doesn't change:** the crypto is still the authority — an unsigned / wrong-signer /
  replayed / stale canary is rejected by vega *before* the model is ever consulted. The
  fine-tune makes the signal layer usable; it does not weaken the gate.
