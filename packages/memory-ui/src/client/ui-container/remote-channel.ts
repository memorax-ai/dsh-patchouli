import type { UiRemoteMessage } from './remote-protocol.js'

export type UiRemoteChannel = {
  ready: Promise<void>
  send: (message: UiRemoteMessage) => void
  onMessage: (listener: (message: unknown) => void) => () => void
  onClose: (listener: () => void) => () => void
  close: () => void
}

export type WebSocketLike = {
  readonly readyState: number
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  addEventListener: (type: string, listener: (event: unknown) => void) => void
  removeEventListener: (type: string, listener: (event: unknown) => void) => void
}

export type MessagePortLike = {
  postMessage: (message: unknown) => void
  start?: () => void
  close: () => void
  addEventListener: (type: 'message' | 'messageerror' | 'close', listener: (event: unknown) => void) => void
  removeEventListener: (type: 'message' | 'messageerror' | 'close', listener: (event: unknown) => void) => void
}

function eventData(event: unknown): unknown {
  return typeof event === 'object' && event !== null && 'data' in event
    ? event.data
    : undefined
}

export function createWebSocketUiRemoteChannel(socket: WebSocketLike): UiRemoteChannel {
  const ready = socket.readyState === 1
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        const open = () => {
          cleanup()
          resolve()
        }
        const failed = () => {
          cleanup()
          reject(new Error('UI container WebSocket closed before opening'))
        }
        const cleanup = () => {
          socket.removeEventListener('open', open)
          socket.removeEventListener('error', failed)
          socket.removeEventListener('close', failed)
        }
        socket.addEventListener('open', open)
        socket.addEventListener('error', failed)
        socket.addEventListener('close', failed)
      })

  return {
    ready,
    send: (message) => socket.send(JSON.stringify(message)),
    onMessage: (listener) => {
      const receive = (event: unknown) => {
        const data = eventData(event)
        if (typeof data !== 'string') {
          socket.close(1003, 'UI container remote accepts JSON text messages only')
          return
        }
        try {
          listener(JSON.parse(data))
        } catch {
          socket.close(1007, 'Invalid UI container remote JSON')
        }
      }
      socket.addEventListener('message', receive)
      return () => socket.removeEventListener('message', receive)
    },
    onClose: (listener) => {
      socket.addEventListener('close', listener)
      return () => socket.removeEventListener('close', listener)
    },
    close: () => socket.close(1000, 'UI container remote closed'),
  }
}

export function createMessagePortUiRemoteChannel(port: MessagePortLike): UiRemoteChannel {
  port.start?.()
  return {
    ready: Promise.resolve(),
    send: (message) => port.postMessage(message),
    onMessage: (listener) => {
      const receive = (event: unknown) => listener(eventData(event))
      port.addEventListener('message', receive)
      return () => port.removeEventListener('message', receive)
    },
    onClose: (listener) => {
      const failed = () => listener()
      port.addEventListener('messageerror', failed)
      port.addEventListener('close', failed)
      return () => {
        port.removeEventListener('messageerror', failed)
        port.removeEventListener('close', failed)
      }
    },
    close: () => port.close(),
  }
}
