import { describe, expect, it } from 'vitest'
import { parseDecision, parseVerdict } from '../src/protocol/tokens.ts'
import { parseWave } from '../src/protocol/wave.ts'
import { converse } from '../src/engine/converse.ts'
import { formatLeads, parseLeads, parseSubmitHandoff } from '../src/engine/steps.ts'
import { TransportInfraError, type RoleConversation, type RoleReply } from '../src/engine/types.ts'
import { memoryPreamble } from '../src/roles/actor.ts'

describe('parseVerdict', () => {
  it('finds one standalone verdict anywhere in a free-form report', () => {
    expect(parseVerdict('# Report\nAll checks hold.\nVERDICT: PASS\n', false)).toBe('PASS')
    expect(parseVerdict('verdict: fail', false)).toBe('FAIL')
  })

  it('ignores examples inside fences and indented code', () => {
    const report = 'Format:\n```\nVERDICT: PASS\n```\n    VERDICT: PASS\nVERDICT: FAIL'
    expect(parseVerdict(report, false)).toBe('FAIL')
  })

  it('treats repeated identical tokens as idempotent and conflicting ones as invalid', () => {
    expect(parseVerdict('VERDICT: PASS\nVERDICT: PASS', false)).toBe('PASS')
    expect(parseVerdict('VERDICT: PASS\nVERDICT: FAIL', false)).toBeUndefined()
    expect(parseVerdict('no verdict here', false)).toBeUndefined()
    expect(parseVerdict('The VERDICT: PASS is inline', false)).toBeUndefined()
  })

  it('admits UNVERIFIED only when the protocol allows it', () => {
    expect(parseVerdict('VERDICT: UNVERIFIED', false)).toBeUndefined()
    expect(parseVerdict('VERDICT: UNVERIFIED', true)).toBe('UNVERIFIED')
  })
})

describe('parseDecision', () => {
  const allowed = ['PROJECT', 'READY_FOR_TARGET', 'STALLED'] as const
  it('reads the first non-empty line and keeps the body verbatim', () => {
    expect(parseDecision('\n\nDECISION: PROJECT\nBuild a parser in <PROJECT_ROOT>.', allowed))
      .toEqual({ decision: 'PROJECT', body: 'Build a parser in <PROJECT_ROOT>.' })
  })
  it('rejects tokens outside the mode vocabulary or not on the first line', () => {
    expect(parseDecision('DECISION: SATURATED', allowed)).toBeUndefined()
    expect(parseDecision('Thinking…\nDECISION: PROJECT', allowed)).toBeUndefined()
  })
})

describe('parseWave', () => {
  it('accepts a fenced WAVE envelope', () => {
    const text = 'Here is the wave.\n```json\n{"decision":"WAVE","rationale":"probe CLI","projects":[{"id":"csv-1","instruction":"In <PROJECT_ROOT> write a CSV merger."}]}\n```'
    expect(parseWave(text)).toEqual({ decision: 'WAVE', rationale: 'probe CLI', projects: [{ id: 'csv-1', instruction: 'In <PROJECT_ROOT> write a CSV merger.' }] })
  })
  it('accepts terminal decisions only with an empty project list', () => {
    expect(parseWave('{"decision":"SATURATED","rationale":"coverage","projects":[]}')?.decision).toBe('SATURATED')
    expect(parseWave('{"decision":"STALLED","rationale":"x","projects":[{"id":"a","instruction":"<PROJECT_ROOT>"}]}')).toBeUndefined()
  })
  it('rejects bad ids, duplicates, missing roots and oversized waves', () => {
    const wave = (projects: unknown[]) => JSON.stringify({ decision: 'WAVE', rationale: 'r', projects })
    expect(parseWave(wave([{ id: 'Bad Id', instruction: '<PROJECT_ROOT>' }]))).toBeUndefined()
    expect(parseWave(wave([{ id: 'a', instruction: '<PROJECT_ROOT>' }, { id: 'a', instruction: '<PROJECT_ROOT>' }]))).toBeUndefined()
    expect(parseWave(wave([{ id: 'a', instruction: 'no root' }]))).toBeUndefined()
    expect(parseWave('not json')).toBeUndefined()
  })
})

describe('parseSubmitHandoff', () => {
  it('requires STATUS: SUBMIT on the first non-empty line', () => {
    expect(parseSubmitHandoff('\nSTATUS: SUBMIT\nDone: wrote merge.py')).toBe('Done: wrote merge.py')
    expect(parseSubmitHandoff('I am finished.')).toBeUndefined()
  })
})

describe('leads', () => {
  it('extracts CLAIM/PROBE pairs with fenced multi-line probes and drops all narrative', () => {
    const handoff = [
      'STATUS: SUBMIT',
      'I am confident.',
      'CLAIM: output exists',
      'PROBE: test -f out.txt && echo PASS',
      'This line explains my work and must not reach the Verifier.',
      'CLAIM: two lines',
      'PROBE:',
      '```sh',
      'python3 - <<PY',
      'print("PASS")',
      'PY',
      '```',
      'CLAIM: no probe',
      '',
      'I fixed parse.py and all my own tests pass; the task is complete.',
    ].join('\n')
    expect(parseLeads(handoff)).toEqual([
      { claim: 'output exists', probe: 'test -f out.txt && echo PASS' },
      { claim: 'two lines', probe: 'python3 - <<PY\nprint("PASS")\nPY' },
    ])
    // Narrative after the last probe never travels inside it.
    expect(parseLeads('STATUS: SUBMIT\nCLAIM: sorted\nPROBE: sort -c out.txt && echo PASS\n\nI fixed parse.py; the task is complete.'))
      .toEqual([{ claim: 'sorted', probe: 'sort -c out.txt && echo PASS' }])
  })
  it('formats RSIAgent LEAD blocks marked NOT_RUN', () => {
    const text = formatLeads([{ claim: 'c', probe: 'p' }])
    expect(text).toContain('LEAD 1\nActor-stated claim: c')
    expect(text).toContain('--- BEGIN PROBE ---\np\n--- END PROBE ---')
    expect(text).toContain('Harness execution classification: NOT_RUN')
  })
})

describe('converse', () => {
  const role = (replies: RoleReply[]): RoleConversation & { sent: string[] } => {
    const sent: string[] = []
    return {
      sent,
      send: async message => {
        sent.push(message)
        return replies.shift() ?? { text: '', actions: 0 }
      },
      close: async () => {},
    }
  }
  const parse = (reply: RoleReply) => (reply.text === 'ok' ? { ok: true as const, value: 1 } : { ok: false as const, detail: 'not ok' })
  const policy = { actionlessLimit: 3, ceiling: 10 }

  it('continues in the same context without a fixed retry count while the role keeps acting', async () => {
    const r = role([{ text: 'a', actions: 2 }, { text: 'b', actions: 1 }, { text: 'c', actions: 0 }, { text: 'd', actions: 1 }, { text: 'ok', actions: 0 }])
    await expect(converse(r, 'go', parse, detail => `again: ${detail}`, policy, 'role')).resolves.toBe(1)
    expect(r.sent).toEqual(['go', 'again: not ok', 'again: not ok', 'again: not ok', 'again: not ok'])
  })
  it('ends as transport infrastructure after consecutive actionless segments', async () => {
    const r = role([{ text: 'a', actions: 0 }, { text: 'b', actions: 0 }, { text: 'c', actions: 0 }])
    await expect(converse(r, 'go', parse, () => 'again', policy, 'role')).rejects.toBeInstanceOf(TransportInfraError)
  })
  it('stops at the emergency ceiling', async () => {
    const r = role(Array.from({ length: 20 }, () => ({ text: 'x', actions: 1 })))
    await expect(converse(r, 'go', parse, () => 'again', { actionlessLimit: 3, ceiling: 4 }, 'role')).rejects.toThrow(/ceiling/)
  })
})

describe('memoryPreamble', () => {
  it('lists names and sizes but leaves brace-bearing names to rsi_memory_list', () => {
    const text = memoryPreamble([{ path: 'a.md', bytes: 3 }, { path: 'notes/{{x}}.md', bytes: 4 }], 10)
    expect(text).toContain('a.md  3B')
    expect(text).not.toContain('{{')
    expect(text).toContain('1 more (use rsi_memory_list)')
  })
})
