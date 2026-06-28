#!/usr/bin/env python3
"""Measure the fine-tuned gate adapter on the held-out test set (gate-data/test.jsonl).

FAITHFUL eval: production constrains output with grammar `root ::= "YES" | "NO"`, so the
decision is simply "is the YES token more likely than the NO token at the answer position."
We replicate that by comparing the two tokens' logits directly — NOT by free-text generate
(which lets the model ramble "1. Turn on…", which doesn't reflect the grammar-constrained
gate and gives misleading results).

    python3 eval_adapter.py [--base meta-llama/Llama-3.2-3B-Instruct] [--adapter ./adapters]

Run in the mlx venv (after training). Loads the model once; logit-compares each prompt.
"""
import argparse
import json

import mlx.core as mx
from mlx_lm import load

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="meta-llama/Llama-3.2-3B-Instruct")
ap.add_argument("--adapter", default="./adapters")
ap.add_argument("--data", default="gate-data/test.jsonl")
args = ap.parse_args()

model, tok = load(args.base, adapter_path=args.adapter)


def first_content_token(s: str) -> int:
    """The first non-BOS token id of `s` — what greedy decoding would emit for it."""
    ids = tok.encode(s)
    bos = getattr(tok, "bos_token_id", None)
    if bos is not None and ids and ids[0] == bos:
        ids = ids[1:]
    return ids[0]


# completions in the dataset are " YES" / " NO" (leading space). Compare those tokens.
YES_ID = first_content_token(" YES")
NO_ID = first_content_token(" NO")


def decide(prompt: str):
    ids = tok.encode(prompt)
    logits = model(mx.array([ids]))[0, -1, :]  # next-token logits at the answer position
    y, n = logits[YES_ID].item(), logits[NO_ID].item()
    return ("YES" if y > n else "NO"), y - n  # also return the margin (confidence)


rows = [json.loads(l) for l in open(args.data) if l.strip()]
ok, misses = 0, []
for r in rows:
    pred, margin = decide(r["prompt"])
    want = r["completion"].strip().upper()
    if pred == want:
        ok += 1
    else:
        misses.append((r.get("request", r["prompt"][-60:]), want, pred, margin))

print(f"\naccuracy: {ok}/{len(rows)} = {ok / len(rows):.0%}   (grammar-faithful: YES vs NO logit)\n")
if misses:
    print("MISSES (request → wanted / got [YES−NO margin]):")
    for req, want, pred, margin in misses:
        print(f"  ✗ {req!r}\n      want={want} got={pred}  margin={margin:+.2f}")
    print("\nSmall |margin| = nearly right (a few more examples will flip it).")
    print("Large wrong margin = a real gap — add 5–10 examples of that phrasing, retrain.")
else:
    print("clean sweep — every held-out request classified correctly.")

# Notes:
# - This matches the deployed gate (llama.cpp /completion + the YES|NO grammar): both pick
#   the higher-probability token among {YES, NO}. Free-text generation does NOT, which is
#   why the old generate-based eval under-reported.
# - If `model(...)` errors on your mlx version, the call is `model(mx.array([ids]))`
#   returning [batch, seq, vocab]; adjust indexing if the API differs.
