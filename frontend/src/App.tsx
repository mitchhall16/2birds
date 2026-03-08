import { useState, useCallback } from 'react'
import { useWallet } from '@txnlab/use-wallet-react'
import { StatusBar } from './components/StatusBar'
import { PoolBlob } from './components/PoolBlob'
import { TransactionFlow } from './components/TransactionFlow'
import { ToastContainer } from './components/ToastContainer'
import { usePoolState } from './hooks/usePoolState'
import { useDeploy } from './hooks/useDeploy'

export function App() {
  const { activeAddress } = useWallet()
  const pool = usePoolState()
  const deployer = useDeploy()
  const [depositAnim, setDepositAnim] = useState(false)
  const [withdrawAnim, setWithdrawAnim] = useState(false)

  // Contracts are already deployed — hardcoded in config.ts
  const needsDeploy = false

  const handleDeposit = useCallback(() => {
    setDepositAnim(true)
    setTimeout(() => setDepositAnim(false), 2000)
  }, [])

  const handleWithdraw = useCallback(() => {
    setWithdrawAnim(true)
    setTimeout(() => setWithdrawAnim(false), 2000)
  }, [])

  const handleComplete = useCallback(() => {
    pool.refresh()
  }, [pool.refresh])

  return (
    <>
      <div className="status-bar">
        <StatusBar />
      </div>

      <div className="app-layout">
        {/* Left column — transaction panel */}
        <div className="app-layout__left">
          {activeAddress ? (
            <TransactionFlow
              onDeposit={handleDeposit}
              onWithdraw={handleWithdraw}
              onComplete={handleComplete}
              walletBalance={pool.walletBalance}
            />
          ) : (
            <div className="app-hero">
              <h1 className="app-hero__title">Private transactions on Algorand</h1>
              <p className="app-hero__desc">
                Deposit ALGO into a shared pool, withdraw to any address. Zero-knowledge proofs guarantee your deposit without revealing which one is yours.
              </p>
              <div className="app-hero__steps">
                <div className="app-hero__step">
                  <span className="app-hero__step-num">1</span>
                  <span>Deposit ALGO into the pool</span>
                </div>
                <div className="app-hero__step">
                  <span className="app-hero__step-num">2</span>
                  <span>Wait for others to deposit</span>
                </div>
                <div className="app-hero__step">
                  <span className="app-hero__step-num">3</span>
                  <span>Withdraw to any address — unlinkable</span>
                </div>
              </div>
              <p className="app-hero__connect-hint">Connect your wallet to get started</p>
            </div>
          )}
        </div>

        {/* Right column — blob + stats */}
        <div className="app-layout__right">
          <div className="blob-container">
            <PoolBlob
              poolBalance={pool.totalDeposited}
              onDeposit={depositAnim}
              onWithdraw={withdrawAnim}
            />
          </div>
          <div className="pool-stats">
            {activeAddress && pool.userBalance > 0 && (
              <div className="pool-stat">
                <span className="pool-stat__label">Your Balance</span>
                <span className="pool-stat__value pool-stat__value--accent">{pool.userBalance.toFixed(3)} ALGO</span>
              </div>
            )}
            <div className="pool-stat">
              <span className="pool-stat__label">Pool Balance</span>
              <span className="pool-stat__value">{pool.totalDeposited.toFixed(3)} ALGO</span>
            </div>
          </div>
        </div>
      </div>

      {/* Deploy banner */}
      {activeAddress && needsDeploy && !deployer.appId && (
        <div className="deploy-banner">
          <span>New contract needs deployment</span>
          <button
            className="deploy-banner__btn"
            onClick={deployer.deploy}
            disabled={deployer.deploying}
          >
            {deployer.deploying ? 'Deploying...' : 'Deploy'}
          </button>
          {deployer.error && <span className="deploy-banner__error">{deployer.error}</span>}
        </div>
      )}

      {deployer.appId && needsDeploy && (
        <div className="deploy-banner deploy-banner--success">
          Deployed! App ID: {deployer.appId} — Refresh the page to use it.
        </div>
      )}

      <ToastContainer />
    </>
  )
}
