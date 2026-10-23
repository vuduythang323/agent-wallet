import { useState, useEffect } from 'react'
import { useAccount } from 'wagmi'
import { Layout, type NavPage } from './components/Layout'
import { OverviewPage } from './components/OverviewPage'
import { AgentsPage } from './components/AgentsPage'
import { PaymentsPage } from './components/PaymentsPage'
import { PolicyPage } from './components/PolicyPage'
import { DeveloperPage } from './components/DeveloperPage'
import { api } from './lib/api'

export default function App() {
  const [page, setPage] = useState<NavPage>('overview')
  const { address } = useAccount()

  // Keep API client in sync with connected wallet
  useEffect(() => {
    if (address) {
      api.setOwner(address)
    }
  }, [address])

  function renderPage() {
    switch (page) {
      case 'overview':   return <OverviewPage />
      case 'agents':     return <AgentsPage />
      case 'payments':   return <PaymentsPage />
      case 'policy':     return <PolicyPage />
      case 'developer':  return <DeveloperPage />
    }
  }

  return (
    <Layout page={page} onNav={setPage}>
      {renderPage()}
    </Layout>
  )
}
