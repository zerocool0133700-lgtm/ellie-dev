interface ThrottleOptions {
  flushIntervalMs: number
  maxEventsPerRun: number
  onFlush: (runId: string, phase: string, detail: string) => void
}

interface PendingEvent {
  phase: string
  detail: string
}

interface RunState {
  pending: PendingEvent[]
  flushedCount: number
  lastPhase: string | null
}

export class ProgressThrottle {
  private runs = new Map<string, RunState>()
  private opts: ThrottleOptions
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(opts: ThrottleOptions) {
    this.opts = opts
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.flush(), this.opts.flushIntervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  record(runId: string, phase: string, detail: string): void {
    let state = this.runs.get(runId)
    if (!state) {
      state = { pending: [], flushedCount: 0, lastPhase: null }
      this.runs.set(runId, state)
    }

    if (phase === state.lastPhase && state.pending.length > 0) {
      state.pending[state.pending.length - 1].detail = detail
    } else {
      state.pending.push({ phase, detail })
      state.lastPhase = phase
    }
  }

  flush(): void {
    for (const [runId, state] of this.runs) {
      const remaining = this.opts.maxEventsPerRun - state.flushedCount
      if (remaining <= 0) {
        state.pending = []
        continue
      }

      const toFlush = state.pending.splice(0, remaining)
      for (const event of toFlush) {
        this.opts.onFlush(runId, event.phase, event.detail)
        state.flushedCount++
      }
    }
  }

  cleanupRun(runId: string): void {
    this.runs.delete(runId)
  }
}
