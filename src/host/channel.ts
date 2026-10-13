/**
 * The yield point between an engine-driven role context and the engine.
 *
 * A role sub-agent runs ONE long turn. Each time it reaches a handoff it calls
 * `rsi_handoff(text)`; that tool call stays pending until the engine sends the
 * next message, which becomes the tool result. The child therefore keeps its
 * complete trajectory across work, verification, and learning phases — the
 * same-context continuity RSIAgent requires — without new loop machinery.
 */

export type ChannelEvent =
  | { kind: 'handoff', text: string }
  | { kind: 'ended', output: string }

interface Pending {
  text: string
  respond: (message: string) => void
  reject: (error: Error) => void
}

export class HandoffChannel {
  #pending: Pending | undefined
  #queued: ChannelEvent[] = []
  #waiter: { resolve: (event: ChannelEvent) => void, reject: (error: Error) => void } | undefined
  #failure: Error | undefined
  #ended = false

  get ended(): boolean {
    return this.#ended
  }

  get hasPendingHandoff(): boolean {
    return this.#pending !== undefined
  }

  /** Child side: publishes `text` and waits for the engine's next message. */
  handoff(text: string, signal: AbortSignal): Promise<string> {
    if (this.#pending) return Promise.reject(new Error('a handoff is already pending; wait for its reply'))
    return new Promise<string>((respond, reject) => {
      const onAbort = () => {
        if (this.#pending?.respond === respondOnce) this.#pending = undefined
        reject(new Error('rsi_handoff was cancelled'))
      }
      const respondOnce = (message: string) => {
        signal.removeEventListener('abort', onAbort)
        respond(message)
      }
      this.#pending = {
        text,
        respond: respondOnce,
        reject: error => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.#emit({ kind: 'handoff', text })
    })
  }

  /** Engine side: resolves the pending handoff with the next message. */
  respond(message: string): boolean {
    const pending = this.#pending
    if (!pending) return false
    this.#pending = undefined
    pending.respond(message)
    return true
  }

  /** Engine side: waits for the next handoff or the end of the child's turn. */
  next(): Promise<ChannelEvent> {
    const queued = this.#queued.shift()
    if (queued) return Promise.resolve(queued)
    if (this.#failure) return Promise.reject(this.#failure)
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject }
    })
  }

  /** The child's turn settled with its final assistant output. */
  end(output: string): void {
    this.#ended = true
    this.#pending?.reject(new Error('the role context ended'))
    this.#pending = undefined
    this.#emit({ kind: 'ended', output })
  }

  /** The child failed below the protocol (infrastructure). */
  fail(error: Error): void {
    this.#ended = true
    this.#failure = error
    this.#pending?.reject(error)
    this.#pending = undefined
    const waiter = this.#waiter
    this.#waiter = undefined
    waiter?.reject(error)
  }

  #emit(event: ChannelEvent): void {
    const waiter = this.#waiter
    if (waiter) {
      this.#waiter = undefined
      waiter.resolve(event)
    } else {
      this.#queued.push(event)
    }
  }
}
