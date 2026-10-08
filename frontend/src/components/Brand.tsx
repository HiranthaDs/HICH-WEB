import { Link } from 'react-router-dom'
import { classNames } from '../lib/format'

export function Brand({ inverse = false, compact = false, to = '/' }: { inverse?: boolean; compact?: boolean; to?: string }) {
  return (
    <Link to={to} className={classNames('brand', inverse && 'brand--inverse', compact && 'brand--compact')} aria-label="Hich Web home">
      <img className="brand__logo" src="/hich.png" width="144" height="72" alt="Hi.Ch Web dev" />
    </Link>
  )
}
