// Scripted Anthropic-Messages-compatible SSE endpoint standing in for the DeepSeek API, so the
// offline end-to-end check can drive a real `dsh` headless run through every RSI role.
// Usage: node scripts/mock-deepseek.mjs <request-log.jsonl> <port>
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const log = process.argv[2]
const port = Number(process.argv[3] ?? 18090)
let ids = 0

const textOf = value => typeof value === 'string' ? value : JSON.stringify(value ?? '')

function lastUserText(messages) {
  const last = messages.at(-1)
  return textOf(last?.content)
}

function decide(body) {
  const system = textOf(body.system)
  const last = lastUserText(body.messages)
  const hasToolResult = last.includes('tool_result')
  // Auxiliary calls (session titles) carry no tools.
  if (!body.tools || body.tools.length === 0) return { role: 'aux', text: 'RSI demo' }
  if (system.includes('You are an independent Verifier Agent inspecting')) {
    if (last.includes('RSI CONTEXT COMPLETE')) return { role: 'verifier', text: 'closing' }
    if (!hasToolResult && last.includes('greet.txt')) return { role: 'verifier', tool: ['rsi_handoff', { text: 'greet.txt does not exist in the project root.\nVERDICT: FAIL' }] }
    if (!hasToolResult) return { role: 'verifier', tool: ['rsi_handoff', { text: 'Read hello.txt in the candidate root: it contains exactly "hello".\nVERDICT: PASS' }] }
    return { role: 'verifier', text: 'done' }
  }
  if (system.includes('You are the Curriculum Agent')) {
    if (last.includes('RSI CONTEXT COMPLETE')) return { role: 'curriculum', text: 'bye' }
    if (last.includes('TERMINAL OUTCOME')) return { role: 'curriculum', tool: ['rsi_handoff', { text: '{"decision":"SATURATED","rationale":"the single probe answered the open question","projects":[]}' }] }
    return { role: 'curriculum', tool: ['rsi_handoff', { text: JSON.stringify({ decision: 'WAVE', rationale: 'probe file deliverables', projects: [{ id: 'greet', instruction: 'In <PROJECT_ROOT> create greet.txt containing hi.' }] }) }] }
  }
  if (system.includes('You are an Actor Agent in a recursive self-improvement lineage')) {
    if (last.includes('RSI CONTEXT COMPLETE')) return { role: 'actor', text: 'bye' }
    if (last.includes('MEMORY DISTILLATION')) return { role: 'actor', tool: ['rsi_memory_write', { path: 'lessons/deliverables.md', content: 'A practice FAIL: the Verifier found no greet.txt. Create deliverables before submitting.' }] }
    if (last.includes('draft: wrote')) return { role: 'actor', tool: ['rsi_handoff', { text: 'Draft ready.' }] }
    if (last.includes('MEMORY RECONCILIATION')) return { role: 'actor', tool: ['rsi_handoff', { text: 'Reconciled.' }] }
    return { role: 'actor', tool: ['rsi_handoff', { text: 'STATUS: SUBMIT\nI did not create the file.' }] }
  }
  const request = textOf(body.messages[0]?.content)
  if (!hasToolResult && request.includes('Explore')) return { role: 'main', tool: ['rsi_explore', { phase: 'broad', direction: 'A POSIX shell workspace; practice small file tasks.', lineage: 'e2e-broad' }] }
  if (last.includes('termination')) return { role: 'main', text: `Exploration result: ${last.includes('saturated') ? 'saturated' : 'other'}` }
  if (!hasToolResult) return { role: 'main', tool: ['rsi_submit', {}] }
  if (last.includes('VERDICT: PASS') && !last.includes('MEMORY DISTILLATION')) return { role: 'main', tool: ['rsi_learn', {}] }
  if (last.includes('MEMORY DISTILLATION')) return { role: 'main', tool: ['rsi_memory_write', { path: 'procedures/greeting-files.md', content: 'Greeting files live at the workspace root; verify exact bytes with cat.' }] }
  if (last.includes('draft: wrote')) return { role: 'main', tool: ['rsi_memory_commit', {}] }
  if (last.includes('MEMORY RECONCILIATION')) return { role: 'main', tool: ['rsi_memory_commit', {}] }
  if (last.includes('Memory promoted')) return { role: 'main', text: 'hello.txt is verified and the lesson is in memory.' }
  return { role: 'main', text: `unscripted state: ${last.slice(0, 200)}` }
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    let body
    try { body = JSON.parse(raw) } catch { res.writeHead(400).end(); return }
    const step = decide(body)
    appendFileSync(log, `${JSON.stringify({ role: step.role, tools: (body.tools ?? []).map(tool => tool.name), reply: step.tool?.[0] ?? step.text })}\n`)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    sse(res, 'message_start', { type: 'message_start', message: { id: `msg_${++ids}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })
    if (step.tool) {
      const [name, input] = step.tool
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${++ids}`, name, input: {} } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })
    } else {
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    }
    sse(res, 'message_stop', { type: 'message_stop' })
    res.end()
  })
}).listen(port, '127.0.0.1')
