import { MultiaddrConnection } from './types'
import Defer, { DeferredPromise } from 'p-defer'

import type { Readable, Writable, Duplex } from 'stream'

import type { Instance as SimplePeer } from 'simple-peer'
import Multiaddr from 'multiaddr'
import type PeerId from 'peer-id'
import { durations } from '@hoprnet/hopr-utils'

const WEBRTC_UPGRADE_TIMEOUT = durations.seconds(7)

declare interface toIterable {
  sink(stream: Writable): (source: AsyncGenerator) => Promise<void>
  source(stream: Readable): AsyncGenerator
  duplex(
    stream: Duplex
  ): {
    sink: AsyncGenerator
    source: AsyncGenerator
  }
}

// @ts-ignore
const toIterable: toIterable = require('stream-to-it')

class WebRTCConnection implements MultiaddrConnection {
  private _switchPromise: DeferredPromise<void>
  private _webRTCStateKnown: boolean
  private _webRTCAvailable: boolean
  private _migrated: boolean
  private _destroyed: boolean
  private _webRTCTimeout?: NodeJS.Timeout

  public source: AsyncGenerator<Uint8Array, Uint8Array | void>

  public remoteAddr: Multiaddr
  public localAddr: Multiaddr

  public sink: (source: AsyncGenerator<Uint8Array, Uint8Array | void>) => Promise<void>

  public timeline: {
    open: number
    closed?: number
  }

  constructor(
    public conn: MultiaddrConnection,
    private channel: SimplePeer,
    private self: PeerId,
    private counterparty: PeerId
  ) {
    this._destroyed = false
    this._switchPromise = Defer<void>()
    this._webRTCStateKnown = false
    this._webRTCAvailable = false

    this.remoteAddr = Multiaddr(`/p2p/${self.toB58String()}`)
    this.localAddr = Multiaddr(`/p2p/${counterparty.toB58String()}`)

    this.channel.on('connect', () => {
      if (this._webRTCTimeout != null) {
        clearTimeout(this._webRTCTimeout)
      }

      console.log(`available after connect`)
      this.timeline = {
        open: Date.now(),
      }
      this._webRTCStateKnown = true
      this._webRTCAvailable = true
      this._switchPromise.resolve()
    })

    const endWebRTCUpgrade = () => {
      console.log(`error thrown`)
      this._webRTCStateKnown = true
      this._webRTCAvailable = false
      this._switchPromise.resolve()
      setImmediate(() => {
        this.channel.destroy()
      })
    }

    this.channel.on('iceTimeout', endWebRTCUpgrade)
    this.channel.on('error', endWebRTCUpgrade)

    this.sink = async (source: AsyncGenerator<Uint8Array, Uint8Array | void>) => {
      this.conn.sink(
        async function* (this: WebRTCConnection) {
          if (this._webRTCTimeout == null) {
            this._webRTCTimeout = setTimeout(endWebRTCUpgrade, WEBRTC_UPGRADE_TIMEOUT)
          }
          let sourceReceived = false
          let sourceMsg: Uint8Array | void
          let sourceDone = false

          function sourceFunction({ value, done }: { value?: Uint8Array | void; done?: boolean | void }) {
            sourceReceived = true
            sourceMsg = value

            if (done) {
              sourceDone = true
            }
          }

          let sourcePromise = source.next().then(sourceFunction)

          while (!this._webRTCAvailable) {
            if (!this._webRTCStateKnown) {
              await Promise.race([
                // prettier-ignore
                sourcePromise,
                this._switchPromise.promise,
              ])

              if (sourceReceived) {
                sourceReceived = false

                if (sourceDone && this._webRTCStateKnown && !this._webRTCAvailable) {
                  return sourceMsg
                } else if (sourceDone) {
                  yield sourceMsg
                  break
                } else {
                  sourcePromise = source.next().then(sourceFunction)
                  yield sourceMsg
                }
              }
            } else {
              await sourcePromise
              if (sourceDone) {
                return sourceMsg
              } else {
                yield sourceMsg
                yield* source
              }
            }
          }
        }.call(this)
      )

      this._switchPromise.promise.then(() => {
        if (this._webRTCAvailable) {
          const sink = toIterable.sink(this.channel)
          this._migrated = true

          sink(source)
        }
      })
    }

    this.source = async function* (this: WebRTCConnection) {
      if (this._webRTCTimeout == null) {
        this._webRTCTimeout = setTimeout(endWebRTCUpgrade, WEBRTC_UPGRADE_TIMEOUT)
      }
      let streamMsgReceived = false
      let streamMsg: Uint8Array | void
      let streamDone = false

      function streamSourceFunction({ value, done }: { value?: Uint8Array | void; done?: boolean | void }) {
        streamMsgReceived = true
        streamMsg = value

        if (done) {
          streamDone = true
        }
      }

      let streamPromise = this.conn.source.next().then(streamSourceFunction)

      while (!this._webRTCAvailable) {
        if (!this._webRTCStateKnown) {
          await Promise.race([
            // prettier-ignore
            streamPromise,
            this._switchPromise.promise,
          ])

          if (streamMsgReceived) {
            streamMsgReceived = false
            if (streamDone && this._webRTCStateKnown && !this._webRTCAvailable) {
              return streamMsg
            } else if (streamDone) {
              yield streamMsg
              break
            } else {
              streamPromise = this.conn.source.next().then(streamSourceFunction)
              yield streamMsg
            }
          }
        } else {
          await streamPromise

          if (streamDone) {
            return streamMsg
          } else {
            yield streamMsg
            yield* this.conn.source
          }
        }
      }

      await this._switchPromise.promise

      if (this._webRTCAvailable) {
        yield* this.channel[Symbol.asyncIterator]()
      } else {
        return
      }
    }.call(this)
  }

  get destroyed(): boolean {
    return this._destroyed
  }

  async close(err?: Error): Promise<void> {
    if (this.destroyed) {
      return Promise.resolve()
    }

    if (this.timeline == null) {
      this.timeline = {
        open: Date.now(),
        closed: Date.now(),
      }
    } else {
      this.timeline.closed = Date.now()
    }

    if (this._migrated) {
      return Promise.resolve(this.channel.destroy())
    } else {
      return Promise.all([this.channel.destroy(), this.conn.close()]).then(() => {})
    }
  }
}

export { WebRTCConnection }
