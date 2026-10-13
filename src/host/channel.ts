/**
 * The yield point between an engine-driven role context and the engine.
 *
 * A role sub-agent runs ONE long turn. Each time it reaches a handoff it calls
 * `rsi_handoff(text)`; that tool call stays pending until the engine sends the
 * next message, which becomes the tool result. The child therefore keeps its
 * complete trajectory across work, verification, and learning phases — the
 * same-context continuity RSIAgent requires — without new loop machinery.
 */

/** Resolves a parked handoff when the engine has no further message: the role ends its turn. */
export const CLOSED: unique symbol = Symbol('dsh-rsi.closed')

export type ChannelEvent =
  | { kind: 'handoff', text: string, actions: number }
  | { kind: 'ended', output: string, actions: number }

interface Pending {
  respond: (message: string | typeof CLOSED) => void
  reject: (error: Error) => void
}

export class HandoffChannel {
  #pending: Pending | undefined
  #queued: ChannelEvent[] = []
  #waiter: { resolve: (event: ChannelEvent) => void, reject: (error: Error) => void } | undefined
  #failure: Error | undefined
  #ended = false
  #closed = false

  get ended(): boolean {
    return this.#ended
  }

  get closed(): boolean {
    return this.#closed
  }

  get hasPendingHandoff(): boolean {
    return this.#pending !== undefined
  }

  /** Child side: publishes `text` and waits for the engine's next message, or CLOSED. */
  handoff(text: string, actions: number, signal: AbortSignal): Promise<string | typeof CLOSED> {
    if (this.#closed) return Promise.resolve(CLOSED)
    if (this.#pending) return Promise.reject(new Error('a handoff is already pending; wait for its reply'))
    return new Promise<string | typeof CLOSED>((resolve, reject) => {
      const onAbort = () => {
        if (this.#pending === pending) this.#pending = undefined
        reject(new Error('rsi_handoff was cancelled'))
      }
      const pending: Pending = {
        respond: message => {
          signal.removeEventListener('abort', onAbort)
          resolve(message)
        },
        reject: error => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      }
      this.#pending = pending
      signal.addEventListener('abort', onAbort, { once: true })
      this.#emit({ kind: 'handoff', text, actions })
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

  /** Engine side: no further messages; a parked or future handoff ends the role's turn. */
  close(): void {
    this.#closed = true
    const pending = this.#pending
    this.#pending = undefined
    pending?.respond(CLOSED)
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
  end(output: string, actions: number): void {
    if (this.#ended) return
    this.#ended = true
    this.#pending?.reject(new Error('the role context ended'))
    this.#pending = undefined
    this.#emit({ kind: 'ended', output, actions })
  }

  /** The child failed below the protocol (infrastructure). */
  fail(error: Error): void {
    if (this.#ended) return
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
