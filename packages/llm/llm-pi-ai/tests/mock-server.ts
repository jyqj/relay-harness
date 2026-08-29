import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

export interface MockServer {
  url: string
  paths: string[]
  requests: unknown[]
  headers: IncomingMessage['headers'][]
  readonly closedResponses: number
  responseOpened: Promise<void>
  responseClosed: Promise<void>
}

const servers: Server[] = []

/** Close every server opened since the last call; run from each spec's afterEach. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  }))
}

/** A minimal complete text generation in pi-ai's chat-completions shape. */
export const textEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

/** Local provider stand-in: replays scripted behaviors per request. */
export async function mockServer(script: {
  status?: number
  events?: string[]
  body?: string
  delayMs?: number
  holdOpenAfterEvents?: boolean
  closeObservationDelayMs?: number
  headers?: Record<string, string>
}[]): Promise<MockServer> {
  const paths: string[] = []
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  let closedResponses = 0
  const responseOpened = Promise.withResolvers<undefined>()
  const responseClosed = Promise.withResolvers<undefined>()
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let closeObservationDelayMs = 0
    response.on('close', () => {
      closedResponses += 1
      setTimeout(() => { responseClosed.resolve(undefined) }, closeObservationDelayMs)
    })
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      paths.push(request.url ?? '')
      requests.push(body.length === 0 ? undefined : JSON.parse(body))
      headers.push(request.headers)
      const behavior = script.shift() ?? { status: 500, body: 'script exhausted' }
      closeObservationDelayMs = behavior.closeObservationDelayMs ?? 0
      if (behavior.status !== undefined && behavior.status !== 200) {
        response.writeHead(behavior.status, { 'content-type': 'application/json', ...behavior.headers })
        response.end(behavior.body ?? '{}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      let index = 0
      const writeNext = (): void => {
        const event = behavior.events?.[index++]
        if (event === undefined) {
          if (behavior.holdOpenAfterEvents !== true) response.end()
          return
        }
        response.write(`data: ${event}\n\n`)
        responseOpened.resolve(undefined)
        if (behavior.delayMs === undefined) writeNext()
        else setTimeout(writeNext, behavior.delayMs)
      }
      writeNext()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    paths,
    requests,
    headers,
    responseOpened: responseOpened.promise,
    responseClosed: responseClosed.promise,
    get closedResponses() { return closedResponses },
  }
}
