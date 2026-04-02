import { describe, test, expect, beforeEach } from 'bun:test'
import { ProgressThrottle } from '../src/progress-throttle'

describe('ProgressThrottle', () => {
  let events: Array<{ runId: string; phase: string; detail: string }>
  let throttle: ProgressThrottle

  beforeEach(() => {
    events = []
    throttle = new ProgressThrottle({
      flushIntervalMs: 100,
      maxEventsPerRun: 10,
      onFlush: (runId, phase, detail) => {
        events.push({ runId, phase, detail })
      },
    })
  })

  test('deduplicates same-phase events within window', () => {
    throttle.record('run-1', 'reading', 'file-a.ts')
    throttle.record('run-1', 'reading', 'file-b.ts')
    throttle.flush()
    expect(events).toHaveLength(1)
    expect(events[0].detail).toBe('file-b.ts')
  })

  test('emits on phase change', () => {
    throttle.record('run-1', 'reading', 'file-a.ts')
    throttle.record('run-1', 'editing', 'file-a.ts')
    throttle.flush()
    expect(events).toHaveLength(2)
    expect(events[0].phase).toBe('reading')
    expect(events[1].phase).toBe('editing')
  })

  test('respects max events per run', () => {
    for (let i = 0; i < 15; i++) {
      throttle.record('run-1', `phase-${i}`, `detail-${i}`)
    }
    throttle.flush()
    expect(events).toHaveLength(10)
  })

  test('tracks separate runs independently', () => {
    throttle.record('run-1', 'reading', 'file-a.ts')
    throttle.record('run-2', 'reading', 'file-b.ts')
    throttle.flush()
    expect(events).toHaveLength(2)
  })

  test('cleanup removes run tracking', () => {
    throttle.record('run-1', 'reading', 'file.ts')
    throttle.cleanupRun('run-1')
    throttle.flush()
    expect(events).toHaveLength(0)
  })
})
