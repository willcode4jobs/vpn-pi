// The internet gate — vega only. Default state is island (no egress); a verified
// canary, approved by the local LLM, opens egress for a fixed window, then it
// auto-recloses. Fail-safe everywhere: anything unexpected leaves/returns to island.
//
// Privilege boundary: this module NEVER touches nftables. It calls a GateExec, which
// in production is `ShellGateExec` — a fixed `open`/`close` verb to a root-owned
// helper installed per island/deploy (pinned sudoers; no input is interpolated into
// the command). Tests/mock use NoopGateExec. See island/deploy/RUNBOOK-gate.md.

import { type Canary, CanaryError } from "./canary.ts";

// --- the LLM policy layer (subordinate to the canary crypto) ----------------

export interface LlamaDecision {
  approve: boolean;
  reason: string;
}

export interface LlamaClient {
  decide(text: string): Promise<LlamaDecision>;
}

/** --mock/tests: policy is "approve open internet access". */
export class MockLlama implements LlamaClient {
  async decide(): Promise<LlamaDecision> {
    return { approve: true, reason: "mock: open internet access approved" };
  }
}

/** Production: query a local llama.cpp server. Fail-safe: unreachable/unsure = DENY. */
export class LlamaHttp implements LlamaClient {
  constructor(private readonly url: string) {}

  async decide(text: string): Promise<LlamaDecision> {
    // CONTRACT: this prompt + the YES/NO labels MUST match the `SYSTEM` string the gate
    // model was fine-tuned on (island/deploy/gate-training/make_dataset.py). Change one →
    // change both, or the fine-tune won't transfer. See RUNBOOK-train-gate-model.md.
    //
    // NEUTRAL framing on purpose: the old "island internet gate / egress / authorized /
    // APPROVE-DENY" wording pattern-matched the model's safety prior (security/exploit-
    // adjacent) and made it refuse legit opens. Posing it as a plain YES/NO intent question
    // sidesteps that reflex. The crypto is still the real authority — this only changes how
    // the question is asked. YES → approve.
    const prompt =
      "Decide whether the user wants to turn on internet access. " +
      "Answer YES if the message asks to open, enable, allow, or turn on internet or network access. " +
      "Answer NO if it asks to keep it off, is about something else, or is nonsense." +
      `\nUser: ${text}\nAnswer:`;
    try {
      const r = await fetch(`${this.url}/completion`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Grammar pins output to exactly YES|NO: no substring ambiguity, one token instead
        // of ~32 (vega's 3B runs ~6 tok/s, so this is sub-second), and the timeout turns a
        // cold/wedged model into a fail-safe DENY (the catch below) instead of hanging the
        // operator's "open" click. 15s is generous headroom over the measured warm latency.
        body: JSON.stringify({
          prompt,
          n_predict: 4,
          temperature: 0,
          grammar: 'root ::= "YES" | "NO"',
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await r.json()) as { content?: string; completion?: string };
      const out = String(j.content ?? j.completion ?? "").toUpperCase();
      const approve = out.includes("YES") && !out.includes("NO"); // YES → open the gate
      return { approve, reason: out.trim() || "no reason" };
    } catch (e) {
      return { approve: false, reason: `llama unreachable: ${(e as Error).message}` };
    }
  }
}

// --- the privileged egress toggle (the ONLY thing that touches nftables) ----

export interface GateExec {
  open(): Promise<void>;
  close(): Promise<void>;
}

/** --mock/tests: records calls, touches nothing. */
export class NoopGateExec implements GateExec {
  opens = 0;
  closes = 0;
  async open(): Promise<void> {
    this.opens++;
  }
  async close(): Promise<void> {
    this.closes++;
  }
}

/** Production: spawn `<cmd> open|close`. The verb is FIXED — no input is ever
 *  interpolated (argv array, never a shell string). cmd is e.g.
 *  "sudo /usr/local/sbin/island-gate". */
export class ShellGateExec implements GateExec {
  private readonly base: string[];
  constructor(cmd: string) {
    this.base = cmd.split(/\s+/).filter(Boolean);
  }
  private async run(verb: "open" | "close"): Promise<void> {
    const proc = Bun.spawn([...this.base, verb], { stdout: "ignore", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(`island-gate ${verb} failed`);
  }
  open(): Promise<void> {
    return this.run("open");
  }
  close(): Promise<void> {
    return this.run("close");
  }
}

// --- the gate state machine -------------------------------------------------

export interface GateState {
  state: "island" | "internet";
  closesAt: string | null;
}

export interface GateLogEntry {
  at: string;
  action: "open" | "close" | "deny";
  admin?: string;
  reason?: string;
}

export class Gate {
  private _state: GateState = { state: "island", closesAt: null };
  private _log: GateLogEntry[] = [];
  private consumed = new Set<string>(); // spent canary nonces (anti-replay)
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly llama: LlamaClient,
    private readonly exec: GateExec,
    private readonly ttlSeconds: number,
  ) {}

  state(): GateState {
    return { ...this._state };
  }
  log(): GateLogEntry[] {
    return [...this._log];
  }

  /** Open egress for a verified canary, if the LLM approves. Idempotent per nonce. */
  async open(
    canary: Canary,
    now: Date = new Date(),
  ): Promise<{ opened: boolean; state: GateState; reason: string }> {
    if (this.consumed.has(canary.nonce)) throw new CanaryError("canary already used");
    this.consumed.add(canary.nonce); // consume on use, even if denied — no retries

    const decision = await this.llama.decide(canary.text);
    if (!decision.approve) {
      this._log.push({ at: now.toISOString(), action: "deny", admin: canary.admin, reason: decision.reason });
      return { opened: false, state: this.state(), reason: decision.reason };
    }

    await this.exec.open();
    if (this.timer) clearTimeout(this.timer);
    this._state = {
      state: "internet",
      closesAt: new Date(now.getTime() + this.ttlSeconds * 1000).toISOString(),
    };
    this.timer = setTimeout(() => void this.close("auto-reclose (ttl)"), this.ttlSeconds * 1000);
    this._log.push({ at: now.toISOString(), action: "open", admin: canary.admin, reason: decision.reason });
    return { opened: true, state: this.state(), reason: decision.reason };
  }

  /** Close egress (manual early close or the auto-reclose timer). Always safe. */
  async close(reason: string, now: Date = new Date()): Promise<GateState> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.exec.close();
    this._state = { state: "island", closesAt: null };
    this._log.push({ at: now.toISOString(), action: "close", reason });
    return this.state();
  }
}
