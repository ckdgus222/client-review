import { Link } from 'react-router'

// 프로젝트를 쓰는 화면(검수실, 설정, 버전 작성, 활동 일지)이 함께 쓴다.
// 서버는 없는 프로젝트와 남의 프로젝트를 같은 404로 답해서, 화면도 둘을 구분하지 않는다.
export const ProjectNotFound = () => (
  <>
    <h1>없는 프로젝트예요</h1>
    <Link to="/">프로젝트 목록</Link>
  </>
)
