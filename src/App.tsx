import { useRef } from 'react'
import CardanoWalletConnector from './components/WalletConnector'
import type { WalletConnectorRef } from './components/WalletConnector'
import { NetworkType } from '@cardano-foundation/cardano-connect-with-wallet-core'

export default function App() {
  const walletRef = useRef<WalletConnectorRef>(null)

  return (
    <div className="min-h-screen flex flex-col items-center justify-start bg-linear-to-br from-black to-gray-900">
      
      <div className="w-full max-w-md px-2 mt-10 ml-auto">
        <CardanoWalletConnector
          ref={walletRef}
          variant="default"
          listLayout="dropdown"
          networkType={NetworkType.TESTNET}
        />
      </div>
    </div>
  )
}
