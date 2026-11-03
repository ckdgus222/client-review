import { Link } from 'react-router'

export const NotFoundPage = () => (
  <>
    <h1>없는 화면이에요</h1>
    <p>주소가 맞는지 확인해 주세요.</p>
    {/* Link가 basename(/app)을 앞에 붙여 준다. */}
    <Link to="/">첫 화면으로 가기</Link>
  </>
)
