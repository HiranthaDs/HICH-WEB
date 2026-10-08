import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { LoadingState } from './components/ui'
import { useAuth } from './context/AuthContext'

const AdminLayout = lazy(() => import('./components/AdminLayout').then((module) => ({ default: module.AdminLayout })))
const AdminLogin = lazy(() => import('./pages/AdminLogin').then((module) => ({ default: module.AdminLogin })))
const ResetPassword = lazy(() => import('./pages/ResetPassword').then(module => ({ default: module.ResetPassword })))
const AgreementSigning = lazy(() => import('./pages/AgreementSigning').then((module) => ({ default: module.AgreementSigning })))
const PublicInvoice = lazy(() => import('./pages/PublicInvoice').then(module => ({ default: module.PublicInvoice })))
const PublicChange = lazy(() => import('./pages/PublicChange').then(module => ({ default: module.PublicChange })))
const OperationsPage = lazy(() => import('./pages/admin/OperationsPage').then(module => ({ default: module.OperationsPage })))
const NotFound = lazy(() => import('./pages/NotFound').then((module) => ({ default: module.NotFound })))
const PublicPortfolio = lazy(() => import('./pages/PublicPortfolio').then((module) => ({ default: module.PublicPortfolio })))
const OverviewPage = lazy(() => import('./pages/admin/OverviewPage').then((module) => ({ default: module.OverviewPage })))
const ClientsPage = lazy(() => import('./pages/admin/ClientsPage').then((module) => ({ default: module.ClientsPage })))
const AgreementsPage = lazy(() => import('./pages/admin/AgreementsPage').then((module) => ({ default: module.AgreementsPage })))
const InvoicesPage = lazy(() => import('./pages/admin/InvoicesPage').then((module) => ({ default: module.InvoicesPage })))
const PortfolioPage = lazy(() => import('./pages/admin/PortfolioPage').then((module) => ({ default: module.PortfolioPage })))
const ActivityPage = lazy(() => import('./pages/admin/ActivitySettings').then((module) => ({ default: module.ActivityPage })))
const SettingsPage = lazy(() => import('./pages/admin/ActivitySettings').then((module) => ({ default: module.SettingsPage })))

function ProtectedRoute() {
  const { user, checking } = useAuth()
  const location = useLocation()
  if (checking) return <div className="route-loading"><LoadingState label="Checking your secure session…" /></div>
  if (!user) return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />
  return <Outlet />
}

export default function App() {
  return (
    <Suspense fallback={<div className="route-loading"><LoadingState label="Loading workspace…" /></div>}>
      <Routes>
        <Route path="/" element={<PublicPortfolio />} />
        <Route path="/invoice/:token" element={<PublicInvoice />} />
        <Route path="/change/:token" element={<PublicChange />} />
        <Route path="/collection/:collectionToken" element={<PublicPortfolio />} />
        <Route path="/sign/:token" element={<AgreementSigning />} />
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin/reset-password" element={<ResetPassword />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<OverviewPage />} />
            <Route path="operations" element={<OperationsPage />} />
            <Route path="clients" element={<ClientsPage />} />
            <Route path="agreements" element={<AgreementsPage />} />
            <Route path="invoices" element={<InvoicesPage />} />
            <Route path="portfolio" element={<PortfolioPage />} />
            <Route path="activity" element={<ActivityPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  )
}
