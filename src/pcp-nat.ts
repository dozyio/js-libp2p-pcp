import { pcpNat } from '@dozyio/pcp'
import { serviceCapabilities, serviceDependencies, start, stop } from '@libp2p/interface'
import { debounce, getNetConfig, isLinkLocal, isLoopback } from '@libp2p/utils'
import { multiaddr } from '@multiformats/multiaddr'
import { QUIC_V1, TCP, WebSockets, WebSocketsSecure, WebTransport } from '@multiformats/multiaddr-matcher'
import { setMaxListeners } from 'main-event'
import type { PCPNAT as PCPNATService, PCPNATComponents, PCPNATInit } from './index.js'
import type { Gateway, Protocol } from '@dozyio/pcp'
import type { Logger, Startable } from '@libp2p/interface'
import type { DebouncedFunction } from '@libp2p/utils'
import type { Multiaddr } from '@multiformats/multiaddr'

const MAX_DATE = 8_640_000_000_000_000

interface PortMapping {
  externalHost: string
  externalPort: number
}

export class PCPNAT implements Startable, PCPNATService {
  private readonly log: Logger
  private readonly components: PCPNATComponents
  private readonly init: PCPNATInit
  private readonly mappedPorts: Map<string, PortMapping>
  private readonly mapIpAddressesDebounced: DebouncedFunction
  private started: boolean
  private shutdownController?: AbortController
  private gateway?: Gateway
  public portMappingClient

  constructor (components: PCPNATComponents, init: PCPNATInit) {
    this.log = components.logger.forComponent('libp2p:pcp-nat')
    this.components = components
    this.init = init
    this.started = false
    this.mappedPorts = new Map()

    this.portMappingClient = init.portMappingClient ?? pcpNat(init.gateway, {
      ttl: init.portMappingTTL,
      autoRefresh: init.portMappingAutoRefresh,
      refreshTimeout: init.portMappingRefreshTimeout
    })

    this.mapIpAddressesDebounced = debounce(async () => {
      try {
        await this.mapIpAddresses()
      } catch (err: any) {
        this.log.error('error mapping IP addresses - %e', err)
      }
    }, 5_000)
  }

  readonly [Symbol.toStringTag] = '@dozyio/libp2p-pcp'

  readonly [serviceCapabilities]: string[] = [
    '@libp2p/nat-traversal'
  ]

  get [serviceDependencies] (): string[] {
    if (this.init.trustMappedAddresses === true) {
      return []
    }

    return [
      '@libp2p/autonat'
    ]
  }

  isStarted (): boolean {
    return this.started
  }

  async start (): Promise<void> {
    if (this.started) {
      return
    }

    if (this.init.gateway === '') {
      throw new Error('PCP gateway address is required')
    }

    const gateway = await this.portMappingClient.getGateway()
    const shutdownController = new AbortController()

    this.gateway = gateway
    this.shutdownController = shutdownController
    setMaxListeners(Infinity, shutdownController.signal)
    this.components.events.addEventListener('self:peer:update', this.mapIpAddressesDebounced)

    try {
      await start(this.mapIpAddressesDebounced)
      await this.mapIpAddresses()
      this.started = true
    } catch (err) {
      shutdownController.abort()
      this.components.events.removeEventListener('self:peer:update', this.mapIpAddressesDebounced)
      await stop(this.mapIpAddressesDebounced)
      await gateway.stop()
      this.gateway = undefined
      this.shutdownController = undefined
      throw err
    }
  }

  async stop (): Promise<void> {
    this.shutdownController?.abort()
    this.components.events.removeEventListener('self:peer:update', this.mapIpAddressesDebounced)

    try {
      await stop(this.mapIpAddressesDebounced)
    } finally {
      await this.gateway?.stop()
    }

    this.gateway = undefined
    this.shutdownController = undefined
    this.started = false
  }

  async mapIpAddresses (): Promise<void> {
    if (this.gateway == null) {
      return
    }

    const addresses = this.getUnmappedAddresses(this.components.addressManager.getAddressesWithMetadata())

    if (addresses.length === 0) {
      this.log('no unmapped, non-loopback, non-link-local, IP based addresses found')
      return
    }

    for (const addr of addresses) {
      const { port, host, protocol, type } = getNetConfig(addr)

      if (host == null || port == null || protocol == null || (type !== 'ip4' && type !== 'ip6')) {
        continue
      }

      if (type === 'ip4' && this.gateway.family !== 'IPv4') {
        continue
      }

      if (type === 'ip6' && this.gateway.family !== 'IPv6') {
        continue
      }

      const key = `${host}-${port}-${protocol}`
      if (this.mappedPorts.has(key)) {
        continue
      }

      const pcpProtocol: Protocol = protocol === 'tcp' ? 'TCP' : 'UDP'

      try {
        const mapping = await this.gateway.map(port, host, {
          protocol: pcpProtocol,
          ttl: this.init.portMappingTTL,
          autoRefresh: this.init.portMappingAutoRefresh,
          refreshTimeout: this.init.portMappingRefreshTimeout
        })

        this.mappedPorts.set(key, mapping)
        this.components.addressManager.addPublicAddressMapping(mapping.internalHost, mapping.internalPort, mapping.externalHost, mapping.externalPort, protocol === 'tcp' ? 'tcp' : 'udp')
        this.log('created mapping of %s:%s to %s:%s for protocol %s', mapping.internalHost, mapping.internalPort, mapping.externalHost, mapping.externalPort, protocol)

        if (this.init.trustMappedAddresses === true) {
          const ma = multiaddr(`/ip${type === 'ip4' ? 4 : 6}/${mapping.externalHost}/${protocol}/${mapping.externalPort}`)
          this.log('trusting mapped IP address %a', ma)
          this.components.addressManager.confirmObservedAddr(ma, {
            ttl: MAX_DATE - Date.now()
          })
        }
      } catch (err: any) {
        this.log.error('failed to create mapping for %s:%d for protocol %s - %e', host, port, protocol, err)
      }
    }
  }

  private getUnmappedAddresses (multiaddrs: Array<{ multiaddr: Multiaddr, type: string }>): Multiaddr[] {
    const output: Multiaddr[] = []

    for (const { multiaddr: ma, type } of multiaddrs) {
      if (type !== 'transport') {
        continue
      }

      const config = getNetConfig(ma)

      if (config.host == null || config.port == null || config.protocol == null) {
        continue
      }

      if (isLoopback(ma) || isLinkLocal(ma)) {
        continue
      }

      if (!this.isIPAddress(ma)) {
        continue
      }

      const key = `${config.host}-${config.port}-${config.protocol}`
      if (this.mappedPorts.has(key)) {
        continue
      }

      output.push(ma)
    }

    return output
  }

  private isIPAddress (ma: Multiaddr): boolean {
    return TCP.exactMatch(ma) ||
      WebSockets.exactMatch(ma) ||
      WebSocketsSecure.exactMatch(ma) ||
      QUIC_V1.exactMatch(ma) ||
      WebTransport.exactMatch(ma)
  }
}
