// Disposable hosted-runner proxy: one browser origin for the GUI and its local API.
import http from 'node:http'

const port = Number(process.env.PROXY_PORT || 3000)
const guiPort = Number(process.env.GUI_PORT || 3001)
const backendPort = Number(process.env.BACKEND_PORT || 8080)
for (const value of [port, guiPort, backendPort]) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error('Invalid local proxy port')
}
function targetPort(url) {
  const pathname = new URL(url, 'http://127.0.0.1').pathname
  return /^\/(api|auth|socket\.io)(\/|$)/.test(pathname) ? backendPort : guiPort
}
function forward(req) {
  return http.request({
    hostname: '127.0.0.1', port: targetPort(req.url), path: req.url,
    method: req.method, headers: req.headers,
  })
}
const server = http.createServer((req, res) => {
  const upstream = forward(req)
  upstream.on('response', response => {
    res.writeHead(response.statusCode, response.headers)
    response.pipe(res)
  })
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('Local upstream unavailable')
  })
  req.on('error', () => upstream.destroy())
  req.pipe(upstream)
})
server.on('upgrade', (req, socket, head) => {
  const upstream = forward(req)
  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    let headers = `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`
    for (let i = 0; i < response.rawHeaders.length; i += 2) {
      headers += `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`
    }
    socket.write(headers + '\r\n')
    if (upstreamHead.length) socket.write(upstreamHead)
    if (head.length) upstreamSocket.write(head)
    socket.on('error', () => upstreamSocket.destroy())
    upstreamSocket.on('error', () => socket.destroy())
    socket.pipe(upstreamSocket).pipe(socket)
  })
  upstream.on('response', () => socket.destroy())
  upstream.on('error', () => socket.destroy())
  upstream.end()
})
server.listen(port, '127.0.0.1', () => console.log(`Local smoke proxy listening on 127.0.0.1:${port}`))
