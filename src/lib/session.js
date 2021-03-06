const debug = require('debug')('dgmc:session')
const Session = function (filename, filetype, index, project) {
  this.index = index
  this.filename = filename
  this.filetype = filetype
  this.start = Date.now()
  this.end = null
  this.lastTick = Date.now()
  this.ticks = 0
  this.marked = false
  this.project = project || 'na'
}
module.exports = Session

Session.current = null
Session.IDLE_TIMEOUT = 60000
Session.index = 0
Session.new = function (fn, ft) {
  if (fn === undefined || ft === undefined)
    throw (new Error('Session.new expects two arguments'))
  if (fn === null || ft === null)
    throw (new Error('Session.new expects two arguments'))
  if (typeof fn !== 'string' || typeof ft !== 'string')
    throw (new Error('Session.new expects string arguments'))

  let index = ++Session.index
  let session = new Session(fn, ft, index)
  debug('Created: ' + JSON.stringify(session))
  return session
}
Session.stash = function (session) {
  if (!session.validate()) return
  if (!session.isClosed()) session.close()
  debug('Stashed: ' + JSON.stringify(session))
  Session.history.push(session)
}
Session.history = []

Session.prototype.isExpired = function (ts) {
  let timeout = ts - this.lastTick
  return timeout > Session.IDLE_TIMEOUT
}

Session.prototype.isClosed = function () {
  return this.end !== null
}

Session.prototype.beat = function () {
  this.lastTick = Date.now()
  this.ticks++
}

Session.prototype.close = function (info) {
  if (this.marked) {
    info = info || {filename: 'unknown', filetype: 'unknow'}
    this.filename = info.filename
    this.filetype = info.filetype
  }
  if (this.isExpired(Date.now()))
    this.end = this.lastTick + Session.IDLE_TIMEOUT
  else
    this.end = Date.now()
}

Session.prototype.validate = function () {
  if (this.ticks === 0) return false
  let regx = /NERD_tree*/
  let isNerd = regx.test(this.filename)
  if (isNerd) return false
  if (this.filename === '') return false
  if (this.filetype === '') return false
  return true
}
