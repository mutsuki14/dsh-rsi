import { describe, expect, it } from 'vitest'
import { parseDecision, parseVerdict } from '../src/protocol/tokens.ts'
import { parseWave } from '../src/protocol/wave.ts'
import { parseSubmitHandoff } from '../src/engine/steps.ts'

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
    expect(parseDecision('\n\nDECISION: PROJECT\nBuild a parser in {{PROJECT_ROOT}}.', allowed))
      .toEqual({ decision: 'PROJECT', body: 'Build a parser in {{PROJECT_ROOT}}.' })
  })
  it('rejects tokens outside the mode vocabulary or not on the first line', () => {
    expect(parseDecision('DECISION: SATURATED', allowed)).toBeUndefined()
    expect(parseDecision('Thinking…\nDECISION: PROJECT', allowed)).toBeUndefined()
  })
})

describe('parseWave', () => {
  it('accepts a fenced WAVE envelope', () => {
    const text = 'Here is the wave.\n```json\n{"decision":"WAVE","rationale":"probe CLI","projects":[{"id":"csv-1","instruction":"In {{PROJECT_ROOT}} write a CSV merger."}]}\n```'
    expect(parseWave(text, 4)).toEqual({ decision: 'WAVE', rationale: 'probe CLI', projects: [{ id: 'csv-1', instruction: 'In {{PROJECT_ROOT}} write a CSV merger.' }] })
  })
  it('accepts terminal decisions only with an empty project list', () => {
    expect(parseWave('{"decision":"SATURATED","rationale":"coverage","projects":[]}', 4)?.decision).toBe('SATURATED')
    expect(parseWave('{"decision":"STALLED","rationale":"x","projects":[{"id":"a","instruction":"{{PROJECT_ROOT}}"}]}', 4)).toBeUndefined()
  })
  it('rejects bad ids, duplicates, missing roots and oversized waves', () => {
    const wave = (projects: unknown[]) => JSON.stringify({ decision: 'WAVE', rationale: 'r', projects })
    expect(parseWave(wave([{ id: 'Bad Id', instruction: '{{PROJECT_ROOT}}' }]), 4)).toBeUndefined()
    expect(parseWave(wave([{ id: 'a', instruction: '{{PROJECT_ROOT}}' }, { id: 'a', instruction: '{{PROJECT_ROOT}}' }]), 4)).toBeUndefined()
    expect(parseWave(wave([{ id: 'a', instruction: 'no root' }]), 4)).toBeUndefined()
    expect(parseWave(wave([{ id: 'a', instruction: '{{PROJECT_ROOT}}' }, { id: 'b', instruction: '{{PROJECT_ROOT}}' }]), 1)).toBeUndefined()
    expect(parseWave('not json', 4)).toBeUndefined()
  })
})

describe('parseSubmitHandoff', () => {
  it('requires STATUS: SUBMIT on the first non-empty line', () => {
    expect(parseSubmitHandoff('\nSTATUS: SUBMIT\nDone: wrote merge.py')).toBe('Done: wrote merge.py')
    expect(parseSubmitHandoff('I am finished.')).toBeUndefined()
  })
})
