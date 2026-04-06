import { generateKeyPair } from '@libp2p/crypto/keys'
import { start, stop } from '@libp2p/interface'
import { defaultLogger } from '@libp2p/logger'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { expect } from 'aegir/chai'
import { TypedEventEmitter } from 'main-event'
import { stubInterface } from 'sinon-ts'
import { PCPNAT } from '../src/pcp-nat.js'
import type { Gateway, PCPNAT as PCPClient } from '@dozyio/pcp'
import type { ComponentLogger, Libp2pEvents, NodeInfo, PeerId } from '@libp2p/interface'
import type { AddressManager } from '@libp2p/interface-internal'
import type { TypedEventTarget } from 'main-event'
import type { StubbedInstance } from 'sinon-ts'

interface StubbedPCPNATComponents {
  peerId: PeerId
  nodeInfo: NodeInfo
  logger: ComponentLogger
  addressManager: StubbedInstance<AddressManager>
  events: TypedEventTarget<Libp2pEvents>
}

const gatewayAddress = process.env.GATEWAY
const itWithGateway = process.env.CI != null || gatewayAddress == null
  ? it.skip
  : it

describe('PCP NAT', () => {
  const teardown: Array<() => Promise<void>> = []
  let client: StubbedInstance<PCPClient>
  let gateway: StubbedInstance<Gateway>

  async function createNatManager (): Promise<{ natManager: PCPNAT, components: StubbedPCPNATComponents }> {
    const components: StubbedPCPNATComponents = {
      peerId: peerIdFromPrivateKey(await generateKeyPair('Ed25519')),
      nodeInfo: { name: 'test', version: 'test', userAgent: 'test' },
      logger: defaultLogger(),
      addressManager: stubInterface<AddressManager>(),
      events: new TypedEventEmitter()
    }

    components.addressManager.getAddressesWithMetadata.returns([])

    gateway = stubInterface<Gateway>({
      family: 'IPv6'
    })

    client = stubInterface<PCPClient>()
    client.getGateway.resolves(gateway)

    const natManager = new PCPNAT(components, {
      gateway: gatewayAddress ?? '2001:db8::1',
      portMappingClient: client
    })

    teardown.push(async () => {
      await stop(natManager)
    })

    return {
      natManager,
      components
    }
  }

  afterEach(async () => {
    await Promise.all(teardown.map(async t => {
      await t()
    }))
    teardown.length = 0
  })

  describe('unit', () => {
    it('maps IPv6 TCP transport addresses', async () => {
      const { natManager, components } = await createNatManager()

      const internalHost = '2001:db8::abcd'
      const internalPort = 4001

      gateway.map.withArgs(internalPort, internalHost).resolves({
        internalHost,
        internalPort,
        externalHost: '2001:db8::1',
        externalPort: 4002,
        protocol: 'TCP'
      })

      components.addressManager.getAddressesWithMetadata.returns([{
        multiaddr: multiaddr(`/ip6/${internalHost}/tcp/${internalPort}`),
        verified: true,
        type: 'transport',
        expires: Date.now() + 10_000
      }])

      await start(natManager)
      await natManager.mapIpAddresses()

      expect(gateway.map.called).to.be.true()
      expect(components.addressManager.addPublicAddressMapping.called).to.be.true()
    })

    it('does not map loopback addresses', async () => {
      const { natManager, components } = await createNatManager()

      components.addressManager.getAddressesWithMetadata.returns([{
        multiaddr: multiaddr('/ip6/::1/tcp/4001'),
        verified: true,
        type: 'transport',
        expires: Date.now() + 10_000
      }])

      await start(natManager)
      await natManager.mapIpAddresses()

      expect(gateway.map.called).to.be.false()
    })

    it('can recover from a failed start attempt', async () => {
      const { natManager } = await createNatManager()

      client.getGateway.onFirstCall().rejects(new Error('gateway unavailable'))
      client.getGateway.onSecondCall().resolves(gateway)

      await expect(start(natManager)).to.eventually.be.rejected()
      expect(natManager.isStarted()).to.be.false()

      await start(natManager)

      expect(natManager.isStarted()).to.be.true()
      expect(client.getGateway.callCount).to.equal(2)
    })

    it('cancels debounced mapping when stopped', async function () {
      this.timeout(10_000)

      const { natManager } = await createNatManager()

      await start(natManager)

      let deferredMapCalls = 0
      ;(natManager as any).mapIpAddresses = async () => {
        deferredMapCalls++
      }

      ;(natManager as any).mapIpAddressesDebounced()

      await stop(natManager)
      await new Promise(resolve => setTimeout(resolve, 5_500))

      expect(deferredMapCalls).to.equal(0)
    })
  })

  describe('integration (requires GATEWAY and is skipped in CI)', () => {
    itWithGateway('can initialize against a real PCP gateway', async () => {
      const components: StubbedPCPNATComponents = {
        peerId: peerIdFromPrivateKey(await generateKeyPair('Ed25519')),
        nodeInfo: { name: 'test', version: 'test', userAgent: 'test' },
        logger: defaultLogger(),
        addressManager: stubInterface<AddressManager>(),
        events: new TypedEventEmitter()
      }

      components.addressManager.getAddressesWithMetadata.returns([])

      const natManager = new PCPNAT(components, {
        gateway: gatewayAddress!,
        trustMappedAddresses: true
      })

      teardown.push(async () => {
        await stop(natManager)
      })

      await start(natManager)

      expect(natManager.isStarted()).to.be.true()
    })
  })
})
