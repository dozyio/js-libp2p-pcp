# @dozyio/libp2p-pcp

libp2p NAT traversal service backed by PCP (RFC 6887).

This package is a thin libp2p wrapper around `@dozyio/pcp`.

## Install

```console
npm i @dozyio/libp2p-pcp
```

## Usage

```ts
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { pcpNAT } from '@dozyio/libp2p-pcp'

const gateway = process.env.GATEWAY

if (gateway == null || gateway === '') {
  throw new Error('Please set GATEWAY to your router PCP server address')
}

const node = await createLibp2p({
  addresses: {
    listen: [
      '/ip6/::/tcp/0'
    ]
  },
  transports: [
    tcp()
  ],
  connectionEncrypters: [
    noise()
  ],
  streamMuxers: [
    yamux()
  ],
  services: {
    identify: identify(),
    ping: ping(),
    natTraversal: pcpNAT({
      gateway,
      trustMappedAddresses: true
    })
  }
})

await node.start()

const logListenAddrs = (label: string): void => {
  console.log(`\n[${label}] listen addresses:`)
  for (const addr of node.getMultiaddrs()) {
    console.log(addr.toString())
  }
}

logListenAddrs('startup')

node.addEventListener('self:peer:update', () => {
  logListenAddrs('self:peer:update')
})

process.on('SIGINT', async () => {
  await node.stop()
  process.exit(0)
})
```

## Notes

- PCP runs over UDP port `5351`.
- Some routers require PCP on a LAN-side IPv6 GUA instead of link-local/WAN addresses.
- This service adds mapped addresses as observed addresses. With `trustMappedAddresses: true`, mapped addresses are trusted immediately and `@libp2p/autonat` is not required. With `trustMappedAddresses: false` (default), mapped addresses are unverified until confirmed by `@libp2p/autonat`.

## Testing

- Run unit tests: `npm test`
- Integration tests require a reachable PCP gateway and are skipped by default in CI.
- To run integration tests locally, set `GATEWAY` to your router's LAN-side IPv6 GUA:

```console
GATEWAY=2001:db8::1 npm test
```
