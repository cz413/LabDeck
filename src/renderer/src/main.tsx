import ReactDOM from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'
import { SftpWindowApp } from './components/SftpPanel'

const sftpServerId = new URLSearchParams(window.location.search).get('sftpServerId')
const sftpRouteId = new URLSearchParams(window.location.search).get('sftpRouteId') ?? undefined
ReactDOM.createRoot(document.getElementById('root')!).render(sftpServerId ? <SftpWindowApp serverId={sftpServerId} accessRouteId={sftpRouteId} /> : <App />)
