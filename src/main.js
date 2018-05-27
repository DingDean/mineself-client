const relay = require('./relay.js')
const Session = require('./session.js')
const {Pomodoro} = require('./pomodoro.js')

const debug = require('debug')('digitme')
const net = require('net')
const fs = require('fs')
const os = require('os')
const path = require('path')
const TEMP_DIR = path.resolve(os.homedir(), '.digitalme')

try {
  fs.readdirSync(TEMP_DIR)
  debug('TEMP DIR exists, safe to go')
} catch (e) {
  try {
    fs.mkdirSync(TEMP_DIR)
    debug('TEMP DIR is created')
  } catch (e) {
    throw (e)
  }
}

// use this title to locate this process
process.title = 'dgmc'

exports.run = function (host, port, eport) {
  host = host || 'localhost'
  port = port || 8764
  eport = eport || 8763

  let sender = relay(`tcp://${host}:${port}`)
  sender.on('flush_history', () => {
    fs.readdir(TEMP_DIR, (err, files) => {
      if (err) return debug('Failed to open temp dir')
      for (let name of files) {
        name = path.resolve(TEMP_DIR, name)
        fs.readFile(name, 'utf8', (err, buff) => {
          if (!err) {
            sender.send(buff)
            debug('A local history is sync to remote')
            fs.unlink(name, err => {
              if (err) debug(`Error on deleting temp file ${name}`)
            })
          }
        })
      }
    })
  })

  let clients = []
  let clientIndex = 0

  const tomato = new Pomodoro()
  tomato.add({name: 'default'})
  tomato.on('finish', () => {
    // TODO: 2018-05-22
    // Query for afterthought
    debug('a timer is finished')
    let msg = JSON.stringify(['ex', 'call digitme#tomatoFinish()'])
    clients.forEach(socket => {
      socket.write(msg)
    })
  })

  tomato.on('change', () => {
    let {state, tEnd} = tomato.getState()
    let msg = JSON.stringify([
      'ex',
      `call digitme#tomatoStateSync(${state}, ${tEnd})`
    ])
    debug(`state change to ${state}`)
    clients.forEach(socket => {
      socket.write(msg)
    })
  })

  const editorListener = net.createServer(c => {
    c.id = `socket${clientIndex}`
    clientIndex++
    clients.push(c)
    c.setEncoding('utf8')

    c.on('data', msg => {
      if (!msg) return
      let index, message
      try {
        msg = JSON.parse(msg)
        index = msg[0]
        message = msg[1]
      } catch (e) {
        debug('收到无效的编辑器消息, error: ' + e)
        debug('消息为 ' + msg)
        return
      }
      let {event, ts, data} = message
      editorListener.emit(event, ts, data, index, c)
    })

    c.on('close', () => {
      debug('editor client closed')
      clients = clients.filter(socket => socket.id !== c.id)
    })
  })

  editorListener.on('error', err => {
    throw (new Error(err))
  })

  editorListener.on('ping', (ts, data) => {
    let current = Session.current
    if (current) {
      if (current.isExpired(ts)) {
        current.close()
        Session.stash(current)
        let {filename, filetype} = current
        let s = Session.new(filename, filetype)
        Session.current = s
      } else
        current.beat()
    } else {
      // this might happen when client is restarted
      let s = Session.new('', '')
      s.marked = true
      Session.current = s
      debug(`A marked session is created with index ${s.index}`)
    }
    if (sender.isAlive()) {
      let msg = JSON.stringify({event: 'digit_ping'})
      sender.send(msg)
    }
  })

  editorListener.on('bufEnter', (ts, data) => {
    let {filename = 'test', filetype = 'test'} = data
    let current = Session.current
    if (current) {
      if (current.isClosed()) {
        // do nothing
      } else {
        current.close()
        Session.stash(current)
      }
    }
    let s = Session.new(filename, filetype)
    Session.current = s
  })

  editorListener.on('bufLeave', (ts, data) => {
    let current = Session.current

    if (!current) return debug('Possible bug, no session when a bufleave')
    current.close(data)
    Session.stash(current)
  })

  editorListener.on('tomatoQuery', (ts, data, index, client) => {
    debug('tomatoQuery')
    client.write(JSON.stringify([index, tomato.getState()]))
  })

  editorListener.on('tomatoStart', (ts, data, index, client) => {
    debug('tomatoStart')
    debug(data)
    let {name = 'default'} = data
    let msg = [index, {ok: 0, err: ''}]
    let err = tomato.start(name)
    if (err) {
      msg[1].ok = 1
      msg[1].err = err
    }
    debug(err || 'timer started')
    client.write(JSON.stringify(msg))
  })

  editorListener.on('tomatoPause', (ts, data, index, client) => {
    debug('tomatoPause')
    let msg = [index, {ok: 0, err: ''}]
    let err = tomato.pause()
    if (err) {
      msg[1].ok = 1
      msg[1].err = err
    }
    debug(err || 'timer paused')
    client.write(JSON.stringify(msg))
  })

  editorListener.on('tomatoAbandon', (ts, data, index, client) => {
    debug('tomatoAbandon')
    let msg = [index, {ok: 0, err: ''}]
    let err = tomato.abandon()
    if (err) {
      msg[1].ok = 1
      msg[1].err = err
    }
    debug(err || 'timer abandoned')
    client.write(JSON.stringify(msg))
  })

  editorListener.on('tomatoResume', (ts, data, index, client) => {
    debug('tomatoResume')
    let msg = [index, {ok: 0}]
    let err = tomato.resume()
    if (err) {
      msg[1].ok = 1
      msg[1].err = err
    }
    client.write(JSON.stringify(msg))
    debug(err || 'timer resumed')
  })

  editorListener.listen(eport, () => {
    debug('Listening vim input on ' + port)
  })

  process.on('SIGINT', () => {
    sender.close()
    process.exit()
  })

  setInterval(() => {
    // TODO: 2018-05-06
    // gzip the history
    let history = Session.history
      .filter(e => e.validate())
    Session.history = []

    let tomatos = tomato.history
    tomato.history = []
    if (history.length === 0 && tomatos.length === 0) return

    let msg = {
      event: 'digit_session',
      data: { ts: Date.now(), history, tomatos }
    }
    msg = JSON.stringify(msg)

    if (sender.isAlive()) {
      sender.send(msg)
      debug('History is synced to remote server')
    } else {
      let fp = path.resolve(TEMP_DIR, `./${Date.now()}_tmp`)
      fs.writeFile(fp, msg, err => {
        if (err) return debug('Failed to save history locally: ' + err)
        debug('History is saved locally')
      })
    }
  }, 30000)
}