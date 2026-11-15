// Tiny stdio MCP server used by tests: one "echo" tool.
import readline from 'node:readline'

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.id === undefined) return
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } } })
  else if (msg.method === 'tools/list')
    send({ id: msg.id, result: { tools: [{ name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } })
  else if (msg.method === 'tools/call' && msg.params.arguments.text === 'crash') process.exit(1)
  else if (msg.method === 'tools/call') send({ id: msg.id, result: { content: [{ type: 'text', text: `echo: ${msg.params.arguments.text}` }] } })
  else send({ id: msg.id, error: { code: -32601, message: 'Method not found' } })
})
