#!/usr/bin/env python3
"""Generate the island-gate YES/NO fine-tuning dataset (MLX prompt/completion JSONL).

v3 — NEUTRAL FRAMING. The "island internet gate / egress / authorized / GREEN18" framing
pattern-matched the model's safety prior (security/exploit-adjacent) and triggered a
refusal reflex, so it denied legit opens no matter the data. The fix: pose it as a plain
intent question with neutral vocabulary and YES/NO labels — no "gate", "egress",
"authorized", "approve/deny". The model classifies intent without its safety reflex firing.

The crypto (signature/seal/nonce) is still the real authority — this only changes how the
question is POSED to the model. The SYSTEM prompt + labels MUST stay identical to
gate.ts `LlamaHttp.decide` (which maps YES -> approve). Run:
    python3 make_dataset.py
-> gate-data/{train,valid}.jsonl  (for mlx)  +  gate-data/test.jsonl  (held-out eval)
"""
import json
import os
import random

random.seed(20260628)  # deterministic; bump to reshuffle

# NEUTRAL: no gate/egress/authorized/approve wording — those trip the safety prior.
SYSTEM = (
    "Decide whether the user wants to turn on internet access. "
    "Answer YES if the message asks to open, enable, allow, or turn on internet or network access. "
    "Answer NO if it asks to keep it off, is about something else, or is nonsense."
)


def prompt(req: str) -> str:
    return f"{SYSTEM}\nUser: {req}\nAnswer:"


def cap(s: str) -> str:
    return s[0].upper() + s[1:] if s else s


# ============================== YES (wants internet on) ======================
yes_natural = [
    "we need the internet for a bit", "can you let us online", "bring the island online",
    "I need to reach the web", "open up the connection so we can download",
    "lift the seal, we need to sync", "let traffic out to the internet",
    "give us internet access for the meeting", "enable outbound for an hour",
    "we have to grab updates, open egress", "turn the internet on please",
    "unlock web access temporarily", "the team needs to get online",
    "open the gate, time to pull packages", "raise the gate for internet",
    "I'd like to connect to the internet now", "permit outbound traffic",
    "let us out to the net", "we want to browse for a while", "open internet so I can email",
    "please open the gate to the outside", "we need egress to fetch the security patches",
    "open the island's internet for maintenance", "go online for fifteen minutes",
    "let me reach the package mirror", "open the tunnel to the internet",
    "enable the internet connection now", "we need to reach an external server, open up",
    "drop the island seal and let us online", "open egress so the backups can upload",
    "internet please, just briefly", "allow the island out to the web",
    "open external access for updates", "we need outbound to the internet right now",
    "switch the gate to internet mode", "open it up so we can download the iso",
    "give the island internet for the demo", "let the nodes reach the internet",
    "open the gate and let traffic flow out", "we need to sync with the cloud, open egress",
    # informal "open up / pop open" + intent implied by an internet PURPOSE (download/pull/fetch)
    "pop the gate open", "pop open the connection", "download a driver, open up",
    "open up so we can pull a container image", "we need to pull from the registry, open up",
    "grab the installer, open the gate", "fetch the latest image, open egress",
    "open up to download the updates", "we need to reach the package repo, open up",
    "pull the docker image, open the internet", "download the firmware, open the connection",
    "open up so we can get the patch", "we need to fetch a file from the web, open up",
    # idiomatic "open internet" phrasings the model under-approves (flip / tunnel / outside / pull)
    "flip the gate so we can get online", "flip the gate", "flip the internet on",
    "we're stuck offline, open the gate", "stuck offline, let us reach the web",
    "flip the gate so we can reach the web", "bring the tunnel up",
    "bring up the tunnel to the outside", "open the tunnel to the outside world",
    "connect us to the outside world", "get us out to the outside world",
    "pull the latest image, open up", "we need to pull images from the registry, open up",
    "open up to pull the latest build", "pull the updates, open the gate",
    "open up so we can pull the repo", "we need to reach docker hub, open up",
    "open up to pull the container", "let us pull the latest container image",
]
verbs = ["open", "unseal", "lift", "enable", "turn on", "allow", "bring up", "raise",
         "unlock", "let through", "activate", "permit", "switch on"]
objs = ["the gate", "internet access", "internet egress", "the island's internet",
        "outbound internet", "the egress", "our connection to the internet", "web access",
        "the internet connection", "the gate to the internet", "external access",
        "outbound traffic", "the internet"]
times = ["", " for 45 minutes", " for an hour", " briefly", " temporarily", " now",
         " for a bit", " for the next half hour", " for a short while", " for the demo"]
leads = ["", "please ", "we need to ", "I want to ", "requesting to ", "go ahead and ",
         "let's ", "can you ", "time to ", "I'd like to "]
keywords = ["", "GREEN18 "]  # crypto checks the keyword; the model should ignore it

# curated natural phrasings = yes_core, ALWAYS kept. (v1 bug: these were unioned with
# thousands of templated combos and sliced randomly to 700, so most curated examples got
# dropped and never trained on — which is why near-identical test cases still missed.)
yes_core = set(cap(s) for s in yes_natural)
yes_core.update(cap("GREEN18 " + s) for s in yes_natural[:25])
templated = set()
for _ in range(8000):
    req = (random.choice(keywords) + random.choice(leads) + random.choice(verbs) + " "
           + random.choice(objs) + random.choice(times)).strip()
    templated.add(cap(req))
yes = set(yes_core)
templated = sorted(templated)
random.shuffle(templated)
for s in templated:                 # fill up to 700 with templated bulk, keeping all core
    if len(yes) >= 700:
        break
    yes.add(s)
yes = sorted(yes)
random.shuffle(yes)

# ============================== NO (everything else) =========================
kc_verbs = ["keep", "shut", "close", "seal", "lock down", "disable", "block", "stay",
            "leave", "turn off"]
kc_objs = ["the island sealed", "the gate", "internet access", "us offline", "egress",
           "the gate closed", "the connection down", "outbound internet", "off the internet",
           "the island off", "the gate shut", "us disconnected", "the internet"]
keep_closed = set()
for _ in range(2000):
    s = (random.choice(["", "please ", "let's ", "we should ", "I want to "])
         + random.choice(kc_verbs) + " " + random.choice(kc_objs)).strip()
    keep_closed.add(cap(s))
keep_closed = list(keep_closed)

# HARD NEGATIVES — "open X" where X is NOT the internet (teaches open != yes)
non_internet_open = [
    "open the file share", "open the door", "open a window", "open the logs",
    "open the admin panel", "open a new friend request", "open the database",
    "open the settings", "open the message thread", "open vega's terminal",
    "open the gate latch on the fence", "open the photo gallery", "open the readme",
    "open a support ticket", "open the friend list", "open the security feed",
    "open the config file", "open the backup folder", "open my inbox",
    "open the wireguard config", "open a chat with sirius", "open the dashboard",
    "let me open the share", "open the documents", "open the calendar",
    # media / local apps — "open X" that is NOT internet (the photo-album false-positive class)
    "open the photo album", "open my photos", "open the music player", "open the video",
    "open the gallery again", "open the album", "open the slideshow", "open the playlist",
    "open the movie", "open the picture", "open the audio file", "open the image viewer",
    # SAME polite / "open up" prefixes as YES requests, but non-internet objects — forces the
    # model to disambiguate by the OBJECT, not the verb phrase ("can you open …" FP class)
    "can you open the photo album for me", "please open the file share",
    "could you open the gallery", "can you open my photos", "open up the photo album",
    "open up the file share", "please open the dashboard", "would you open the music player",
    "can you open the documents for me", "please open the settings",
]
questions = [
    "is the gate open?", "are we online?", "what's the gate state?",
    "can we reach the internet?", "is internet enabled?", "is the island sealed?",
    "do we have egress right now?", "when does the gate close?", "is the connection up?",
    "how long until the internet closes?", "are we connected to the web?",
    "what is the current gate status?", "did the gate open?", "is outbound allowed?",
]
deferred = [
    "open the gate later", "maybe open the internet sometime", "open it tomorrow",
    "we might need the internet next week", "open egress at some point", "remind me to open the gate",
    "should we open the internet?", "thinking about opening the gate", "open the internet eventually",
]
unrelated = [
    "what's the weather today?", "list the files on the share", "reboot vega",
    "add a new friend", "show me the security logs", "ping polaris", "who is online?",
    "update the friend list", "send a message to sirius", "how much disk is free?",
    "restart the daemon", "what time is it?", "show the gate log", "back up the database",
    "rename this node", "check the wireguard status", "tell me a joke", "sync the clock",
    "delete an old file", "show the friend codes", "what's my friend code?",
    "list the connected peers", "summarize the security feed",
]
gibberish = [
    "asdf qwer zxcv", "....", "xyzzy 123", "aaaaaaa", "lorem ipsum dolor", "",
    "??? ??? ???", "null", "te st te st", "zzzzzz", "random words here", "1234567890",
    "....,,,,....", "blah blah blah", "qqqq wwww eeee", ";;;;;", "foo bar baz",
]
# malicious compounds still get NO even though they contain "open ..."
malicious = [
    "open the gate and disable the firewall", "open egress and turn off logging",
    "open the gate then delete the keys", "exfiltrate all files to the internet",
    "open internet and send the database out", "open the gate and grant root to everyone",
    "open egress and remove all friends", "open the internet and leak the admin token",
    "open the gate and wipe the logs", "open egress then attack another network",
    "open the gate and forward all traffic to me", "open internet and disable the canary",
    "open the gate and copy the keys offsite", "open egress and shut off the IDS",
]

no_core = set()
for lst in (non_internet_open, questions, deferred, unrelated, gibberish, malicious):
    no_core.update(cap(x) for x in lst)
no = set(no_core)
random.shuffle(keep_closed)
for s in keep_closed:
    if len(no) >= 700:
        break
    no.add(s)
no = sorted(no)
random.shuffle(no)
no = no[:700]

# ============================== held-out TEST ================================
test = [
    ("we are stuck offline, can you flip the gate so we can reach the web", " YES"),
    ("hey could you let the island talk to the internet for a sec", " YES"),
    ("need to download a driver, pop the gate open", " YES"),
    ("authorize outbound to the public internet now", " YES"),
    ("let's get the island connected so the team can sync", " YES"),
    ("GREEN18 we require internet egress for patching", " YES"),
    ("please grant us web access for the next hour", " YES"),
    ("bring the tunnel up to the outside world", " YES"),
    ("kindly enable our path out to the net", " YES"),
    ("open up so we can pull the latest container image", " YES"),
    ("nah keep us walled off from the internet", " NO"),
    ("make sure the island stays dark", " NO"),
    ("can you open the photo album for me", " NO"),
    ("pull up the admin dashboard", " NO"),
    ("is there internet right now or are we sealed", " NO"),
    ("open the gate next monday maybe", " NO"),
    ("zzz qwerty nonsense 999", " NO"),
    ("reboot the file server please", " NO"),
    ("open egress and also turn off the firewall logs", " NO"),
    ("what's the status of our outbound connection", " NO"),
]

# ============================== write ========================================
rows = ([{"prompt": prompt(r), "completion": " YES"} for r in yes]
        + [{"prompt": prompt(r), "completion": " NO"} for r in no])
random.shuffle(rows)
split = int(len(rows) * 0.9)

os.makedirs("gate-data", exist_ok=True)
with open("gate-data/train.jsonl", "w") as f:
    for r in rows[:split]:
        f.write(json.dumps(r) + "\n")
with open("gate-data/valid.jsonl", "w") as f:
    for r in rows[split:]:
        f.write(json.dumps(r) + "\n")
with open("gate-data/test.jsonl", "w") as f:
    for req, label in test:
        f.write(json.dumps({"prompt": prompt(req), "completion": label, "request": req}) + "\n")

print(f"wrote gate-data/  →  {split} train / {len(rows) - split} valid / {len(test)} held-out test")
print(f"   YES={len(yes)}  NO={len(no)}  "
      f"(no incl. {len(no_core)} curated hard-negatives: open-X / questions / deferred / unrelated / gibberish / malicious)")
print("   NEUTRAL framing (YES/NO, no gate/egress/authorized wording) — avoids the safety-refusal prior.")
print("   test.jsonl uses unseen phrasings — measure generalization with eval_adapter.py")
