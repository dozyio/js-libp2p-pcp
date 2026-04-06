/**
 * @packageDocumentation
 *
 * libp2p NAT traversal service that configures PCP mappings using `@dozyio/pcp`.
 */

import { PCPNAT as PCPNATClass } from './pcp-nat.js'
import type { Gateway, PCPNAT as PCPClient } from '@dozyio/pcp'
import type { ComponentLogger, Libp2pEvents, NodeInfo, PeerId } from '@libp2p/interface'
import type { AddressManager } from '@libp2p/interface-internal'
import type { TypedEventTarget } from 'main-event'

export type { Gateway, PCPClient }

export interface PCPNATInit {
  /**
   * PCP server address - usually your router LAN-side IPv6 GUA.
   */
  gateway: string

  /**
   * Pre-configured PCP client, otherwise one is created.
   */
  portMappingClient?: PCPClient

  /**
   * How long PCP mappings should last in ms.
   */
  portMappingTTL?: number

  /**
   * Whether to refresh mappings before they expire.
   *
   * @default true
   */
  portMappingAutoRefresh?: boolean

  /**
   * Timeout in ms for map refresh operations.
   */
  portMappingRefreshTimeout?: number

  /**
   * Trust PCP mapped addresses immediately without requiring autonat
   * verification.
   *
   * @default false
   */
  trustMappedAddresses?: boolean
}

export interface PCPNATComponents {
  peerId: PeerId
  nodeInfo: NodeInfo
  logger: ComponentLogger
  addressManager: AddressManager
  events: TypedEventTarget<Libp2pEvents>
}

export interface PCPNAT {
  portMappingClient: PCPClient
}

export function pcpNAT (init: PCPNATInit): (components: PCPNATComponents) => PCPNAT {
  return (components: PCPNATComponents) => {
    return new PCPNATClass(components, init)
  }
}
