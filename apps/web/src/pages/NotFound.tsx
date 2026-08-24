import { Link } from 'react-router-dom'

const NotFound = () => (
  <div>
    <h1 className="text-[13px] tracking-[0.18em] text-dim">NO SUCH SCREEN</h1>
    <p className="mt-4 text-[13px] sm:text-[15px]">This route is not part of the terminal.</p>
    <Link
      to="/limit"
      className="mt-8 inline-block border border-rule px-4 py-2 text-[12px] sm:text-[13px] hover:border-ink"
    >
      GO TO LIMIT →
    </Link>
  </div>
)

export default NotFound
